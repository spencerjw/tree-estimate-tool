// Stripe webhook handler — verifies signature and processes subscription lifecycle events.
// Requires bodyParser disabled so we can verify the raw request body.

import Stripe from 'stripe';
import { supabase } from '../lib/supabase.js';
import { provisionCustomer } from '../lib/provision.js';
import {
  sendTrialEndingEmail,
  sendSubscriptionStartedEmail,
  sendPaymentFailedEmail,
  sendCancellationEmail,
} from '../lib/emails.js';

export const config = {
  api: { bodyParser: false },
};

// Stripe monthly price ID → TreeSnap tier (also used for upgrade swaps)
const MONTHLY_PRICE_IDS = {
  starter: 'price_1TUradGTb7xBM80FK2OjcI5D',  // $79/mo
  pro:     'price_1TUracGTb7xBM80FNCyGv4Hp',  // $129/mo
  proplus: 'price_1TUrafGTb7xBM80FVV4J21Cr',  // $179/mo
};

// Stripe price ID → TreeSnap tier
const PRICE_TO_TIER = {
  'price_1TUradGTb7xBM80FK2OjcI5D': 'starter',  // $79/mo
  'price_1TUracGTb7xBM80FNCyGv4Hp': 'pro',       // $129/mo
  'price_1TUrafGTb7xBM80FVV4J21Cr': 'proplus',   // $179/mo
};

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

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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

  const stripe = new Stripe(stripeKey);
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
        if (customer) {
          await sendTrialEndingEmail(customer);
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

        const updates = {
          status,
          current_period_start: toIso(sub.current_period_start),
          current_period_end:   toIso(sub.current_period_end),
        };
        if (tier) updates.tier = tier;

        await supabase
          .from('customers')
          .update(updates)
          .eq('stripe_customer_id', sub.customer);
        break;
      }

      // ----------------------------------------------------------------------
      // Subscription canceled
      // ----------------------------------------------------------------------
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const periodEnd = toIso(sub.current_period_end);

        await supabase
          .from('customers')
          .update({ status: 'canceled', current_period_end: periodEnd })
          .eq('stripe_customer_id', sub.customer);

        const customer = await getCustomerByStripeId(sub.customer);
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

        let periodStart = null;
        let periodEnd = null;

        if (invoice.subscription) {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription);
          periodStart = toIso(sub.current_period_start);
          periodEnd   = toIso(sub.current_period_end);
        }

        await supabase
          .from('customers')
          .update({ status: 'active', current_period_start: periodStart, current_period_end: periodEnd })
          .eq('id', customer.id);

        // Only send "subscription started" email for the first charge (trial → paid conversion)
        if (invoice.billing_reason === 'subscription_create') {
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

          await provisionCustomer(lead);
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
