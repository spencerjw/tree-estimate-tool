// Stripe webhook handler — verifies signature and processes subscription lifecycle events.
// Requires bodyParser disabled so we can verify the raw request body.

import { supabase } from '../lib/supabase.js';
import { getStripe, hasCardOnFile, trialDaysForCheckout, MONTHLY_PRICE_IDS, PRICE_TO_TIER } from '../lib/stripe.js';
import { billingLinkUrl } from '../lib/billing-link.js';
import { provisionCustomer } from '../lib/provision.js';
import {
  sendTrialEndingEmail,
  sendTrialPausedEmail,
  sendSubscriptionStartedEmail,
  sendPaymentFailedEmail,
  sendCancellationEmail,
  sendAccountChangeSummary,
} from '../lib/emails.js';

export const config = {
  api: { bodyParser: false },
};

const TIER_LABELS = { starter: 'Starter', pro: 'Pro', proplus: 'Pro+' };


// Stripe subscription status → TreeSnap status
const STATUS_MAP = {
  trialing:            'trialing',
  active:              'active',
  past_due:            'past_due',
  canceled:            'canceled',
  paused:              'paused',
  unpaid:              'past_due',
  incomplete:          'trialing',
  incomplete_expired:  'canceled',
};

function toIso(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

// Billing-period fields moved from the subscription root onto its items in
// Stripe's Basil API version (2025-03-31+); invoice.subscription moved under
// invoice.parent. Webhook event payloads are versioned by the endpoint's
// dashboard setting (not the SDK pin), so read from either location.
function subPeriodStart(sub) {
  return sub?.current_period_start ?? sub?.items?.data?.[0]?.current_period_start ?? null;
}
function subPeriodEnd(sub) {
  return sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end ?? null;
}
function invoiceSubscriptionId(invoice) {
  return invoice?.subscription
    ?? invoice?.parent?.subscription_details?.subscription
    ?? invoice?.lines?.data?.[0]?.subscription
    ?? null;
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Admin "extend trial" on a paused no-card trial replaces the subscription (Stripe
// won't re-trial a paused one). Events from the replaced subscription must not
// touch the customer: its cancel would otherwise mark the shop canceled.
function isStaleSubscription(customer, sub) {
  return !!(customer?.stripe_subscription_id && sub?.id && customer.stripe_subscription_id !== sub.id);
}

async function getCustomerByStripeId(stripeCustomerId) {
  const { data } = await supabase
    .from('customers')
    .select('*')
    .eq('stripe_customer_id', stripeCustomerId)
    .single();
  return data;
}

async function logEmail(customerId, emailType, recipient) {
  await supabase.from('email_log').insert({ customer_id: customerId, email_type: emailType, recipient });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeKey || !webhookSecret) {
    console.error('Stripe env vars not configured');
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  const stripe = getStripe(stripeKey);
  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Stripe signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  console.log('Stripe event received:', event.type);

  try {
    switch (event.type) {

      // ----------------------------------------------------------------------
      // Trial ending soon (fires ~3 days before — we send our 2-day warning)
      // ----------------------------------------------------------------------
      case 'customer.subscription.trial_will_end': {
        const sub = event.data.object;
        const customer = await getCustomerByStripeId(sub.customer);
        if (customer && !isStaleSubscription(customer, sub)) {
          // No card on file -> "nothing will be charged" copy + a card link. Covers
          // BETA30 trials and a paid signup whose card save failed (safety net).
          const noCard = !(await hasCardOnFile(stripe, sub));
          await sendTrialEndingEmail(customer, {
            noCard,
            billingUrl: noCard ? billingLinkUrl(customer.id) : null,
          });
          await logEmail(customer.id, 'trial_ending', customer.email);
        }
        break;
      }

      // ----------------------------------------------------------------------
      // Subscription updated — sync status, tier, period dates
      // ----------------------------------------------------------------------
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const priceId = sub.items?.data[0]?.price?.id;
        const tier = PRICE_TO_TIER[priceId];
        const status = STATUS_MAP[sub.status] ?? sub.status;

        const customer = await getCustomerByStripeId(sub.customer);
        if (isStaleSubscription(customer, sub)) break;

        const updates = {
          status,
          current_period_start: toIso(subPeriodStart(sub)),
          current_period_end:   toIso(subPeriodEnd(sub)),
          // Stamp on cancel, clear on any other status so a reactivated tenant
          // isn't purged by the 90-day cleanup cron.
          canceled_at: status === 'canceled' ? new Date().toISOString() : null,
        };
        if (tier) updates.tier = tier;

        await supabase
          .from('customers')
          .update(updates)
          .eq('stripe_customer_id', sub.customer);

        // A no-card trial just ended and Stripe paused it: send the owner a card link.
        const prevStatus = event.data.previous_attributes?.status;
        if (customer && sub.status === 'paused' && prevStatus && prevStatus !== 'paused') {
          // Best-effort: the status change is already saved, and a 500 here would
          // make Stripe redeliver and re-send the email.
          try {
            await sendTrialPausedEmail(customer, billingLinkUrl(customer.id));
            await logEmail(customer.id, 'trial_paused', customer.email);
          } catch (e) {
            console.error('Trial paused email failed:', e.message);
          }
        }
        break;
      }

      // ----------------------------------------------------------------------
      // Subscription canceled
      // ----------------------------------------------------------------------
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const periodEnd = toIso(subPeriodEnd(sub));
        const existing = await getCustomerByStripeId(sub.customer);
        if (isStaleSubscription(existing, sub)) break;

        await supabase
          .from('customers')
          .update({ status: 'canceled', current_period_end: periodEnd, canceled_at: new Date().toISOString() })
          .eq('stripe_customer_id', sub.customer);

        const customer = existing ? { ...existing, status: 'canceled' } : null;
        if (customer) {
          await sendCancellationEmail({ ...customer, current_period_end: periodEnd });
          await logEmail(customer.id, 'cancellation', customer.email);
        }
        break;
      }

      // ----------------------------------------------------------------------
      // Payment succeeded — activate account; email on trial conversion
      // ----------------------------------------------------------------------
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const customer = await getCustomerByStripeId(invoice.customer);
        if (!customer) break;
        // A $0 invoice is a trial start (incl. an admin re-trial), not a payment.
        if (!invoice.amount_paid) break;
        if (isStaleSubscription(customer, { id: invoiceSubscriptionId(invoice) })) break;

        let periodStart = null;
        let periodEnd = null;

        const invSubId = invoiceSubscriptionId(invoice);
        if (invSubId) {
          const sub = await stripe.subscriptions.retrieve(invSubId);
          periodStart = toIso(subPeriodStart(sub));
          periodEnd   = toIso(subPeriodEnd(sub));
        }

        await supabase
          .from('customers')
          .update({ status: 'active', current_period_start: periodStart, current_period_end: periodEnd, canceled_at: null })
          .eq('id', customer.id);

        // "Subscription started" on the customer's first real charge, whether the
        // trial converted at its end or a paused no-card trial resumed with a card.
        // Decided from Stripe's invoice history, not the DB status: Stripe can send
        // subscription.updated (already active) before this event.
        // Once a start email is logged, every later invoice is a renewal: skip the
        // Stripe lookup. (DB status can't tell: Stripe may mark the sub active
        // before this event arrives.)
        const { data: startedLog } = await supabase
          .from('email_log').select('id')
          .eq('customer_id', customer.id).eq('email_type', 'subscription_started').limit(1)
          .maybeSingle();
        const isFirstCharge = !startedLog && !(await stripe.invoices.list({
          customer: invoice.customer, status: 'paid', limit: 100,
        })).data.some(i => i.id !== invoice.id && i.amount_paid > 0);
        if (isFirstCharge) {
          const amountPaid = Math.round(invoice.amount_paid / 100);
          await sendSubscriptionStartedEmail(
            { ...customer, status: 'active', current_period_end: periodEnd },
            amountPaid
          );
          await logEmail(customer.id, 'subscription_started', customer.email);
        }
        break;
      }

      // ----------------------------------------------------------------------
      // Payment failed — mark past_due
      // ----------------------------------------------------------------------
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (isStaleSubscription(await getCustomerByStripeId(invoice.customer), { id: invoiceSubscriptionId(invoice) })) break;

        await supabase
          .from('customers')
          .update({ status: 'past_due' })
          .eq('stripe_customer_id', invoice.customer);

        const customer = await getCustomerByStripeId(invoice.customer);
        if (customer) {
          await sendPaymentFailedEmail(customer);
          await logEmail(customer.id, 'payment_failed', customer.email);
        }
        break;
      }

      // ----------------------------------------------------------------------
      // Setup-fee or upgrade-fee checkout completed — provision or upgrade
      // ----------------------------------------------------------------------
      case 'checkout.session.completed': {
        const session    = event.data.object;
        const { lead_id, customer_id, action, target_tier } = session.metadata ?? {};

        if (action === 'upgrade' && customer_id && target_tier) {
          // Upgrade flow — swap subscription price and update tier in Supabase
          const { data: customer } = await supabase
            .from('customers')
            .select('*')
            .eq('id', customer_id)
            .single();

          if (!customer) {
            console.error('Upgrade: customer not found', customer_id);
            break;
          }

          const newPriceId = MONTHLY_PRICE_IDS[target_tier];
          if (!newPriceId) {
            console.error('Upgrade: unknown target tier', target_tier);
            break;
          }

          const sub = await stripe.subscriptions.retrieve(customer.stripe_subscription_id);
          await stripe.subscriptions.update(sub.id, {
            items:               [{ id: sub.items.data[0].id, price: newPriceId }],
            proration_behavior:  'none',
          });

          await supabase
            .from('customers')
            .update({ tier: target_tier })
            .eq('id', customer_id);

          console.log(`Upgraded customer ${customer_id} → ${target_tier}`);

          // Notify the customer their plan changed (tier flips here, on payment,
          // not when the admin sent the checkout link). Best-effort.
          try {
            await sendAccountChangeSummary(customer.email, customer, [{
              label: 'Plan',
              from:  TIER_LABELS[customer.tier] ?? customer.tier,
              to:    TIER_LABELS[target_tier] ?? target_tier,
            }]);
            await logEmail(customer.id, 'account_updated', customer.email);
          } catch (e) {
            console.error('Upgrade summary email failed:', e.message);
          }

        } else if (lead_id) {
          // New signup flow — provision the customer
          const { data: lead } = await supabase
            .from('leads')
            .select('*')
            .eq('id', lead_id)
            .single();

          if (!lead) {
            console.error('Provision: lead not found', lead_id);
            break;
          }

          if (lead.status === 'provisioned') {
            console.log('Provision: already done, skipping duplicate webhook', lead_id);
            break;
          }

          // Persist the setup-fee card as the customer's default payment method so
          // the monthly subscription (created in provisionCustomer) auto-charges it
          // off-session when the trial ends. Best-effort: if it fails the trial
          // still starts; the trial-ending email is the safety net. A $0 checkout
          // (e.g. BETA30) has no card; that trial pauses at its end instead.
          try {
            if (session.customer && session.payment_intent) {
              const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
              if (pi.payment_method) {
                await stripe.customers.update(session.customer, {
                  invoice_settings: { default_payment_method: pi.payment_method },
                });
              }
            }
          } catch (e) {
            console.error('Failed to set default payment method from setup checkout:', e.message);
          }

          // Throws on a Stripe error -> 500 -> Stripe redelivers. Better than
          // quietly provisioning 14 days for someone promised 30.
          const trialDays = await trialDaysForCheckout(stripe, session);
          const collectedCard = (session.amount_total ?? 1) > 0;
          await provisionCustomer(lead, { trialDays, collectedCard });
          console.log(`Provisioned customer for lead ${lead_id}`);
        }
        break;
      }

      default:
        // Silently ignore unhandled event types
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ error: 'Webhook handler error' });
  }
}
