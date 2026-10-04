// Billing portal entry for tree pros (no login; see lib/billing-link.js).
//
// GET  /api/billing?c&e&s        signed link -> Stripe portal, "update payment method" flow
// GET  /api/billing?c&e&s&r=1    portal return -> resume a trial that paused for lack of a card
// POST /api/billing              from a paused shop page: email the owner a fresh link

import { supabase } from '../lib/supabase.js';
import { getStripe, defaultCardId } from '../lib/stripe.js';
import { billingLinkUrl, verifyBillingLink } from '../lib/billing-link.js';
import { rateLimit, clientIp } from '../lib/rate-limit.js';
import { sendBillingLinkEmail } from '../lib/emails.js';

// Update payment method + invoices, no cancel. Env override for test mode.
const PORTAL_CONFIGURATION = process.env.STRIPE_PORTAL_CONFIGURATION || 'bpc_1UMrOKGTb7xBM80F1LABPaA1';

function page(res, status, title, body) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#1f2937;line-height:1.5">
<h1 style="font-size:22px;color:#166534">${title}</h1>${body}
<p style="color:#6b7280;font-size:14px">Questions? <a href="mailto:hello@treesnap.cloud">hello@treesnap.cloud</a></p></body></html>`);
}

async function loadCustomer(id) {
  const { data } = await supabase
    .from('customers')
    .select('id, email, owner_name, subdomain, status, stripe_customer_id, stripe_subscription_id')
    .eq('id', id)
    .single();
  return data;
}

export default async function handler(req, res) {
  if (req.method === 'POST') return requestLink(req, res);
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const customerId = verifyBillingLink(req.query ?? {});
  if (!customerId) {
    return page(res, 403, 'This link has expired',
      '<p>Billing links last 14 days. Reply to any TreeSnap email and we will send a new one.</p>');
  }
  const customer = await loadCustomer(customerId);
  if (!customer?.stripe_customer_id) {
    return page(res, 404, 'Account not found', '<p>We could not find a billing account for this link.</p>');
  }
  const stripe = getStripe();

  try {
    if (req.query.r === '1') return await afterPortal(res, stripe, customer);

    const appUrl = process.env.APP_URL ?? 'https://app.treesnap.cloud';
    const back = `${appUrl}/api/billing?${new URLSearchParams({
      c: req.query.c, e: req.query.e, s: req.query.s, r: '1',
    })}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: customer.stripe_customer_id,
      configuration: PORTAL_CONFIGURATION,
      return_url: back,
      flow_data: {
        type: 'payment_method_update',
        after_completion: { type: 'redirect', redirect: { return_url: back } },
      },
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('Billing portal error:', err);
    return page(res, 500, 'Something went wrong',
      '<p>We could not open billing just now. Try the link again in a minute, or reply to the email.</p>');
  }
}

// Back from the portal. Pin the card just added on the subscription (a card pinned
// there overrides the customer default, and provision pins the setup-fee card),
// then, if the shop is down for billing, charge now:
//   paused (no-card trial ended) -> resume once and pay its first invoice
//   past_due / unpaid            -> pay the open invoice with the new card
// The webhook moves the shop to active once the invoice is paid.
async function afterPortal(res, stripe, customer) {
  const pmId = await defaultCardId(stripe, customer.stripe_customer_id);
  if (!pmId) {
    return page(res, 200, 'No card saved yet',
      '<p>Nothing changed. Use the link in your email again whenever you are ready.</p>');
  }
  const sub = customer.stripe_subscription_id
    ? await stripe.subscriptions.retrieve(customer.stripe_subscription_id)
    : null;
  if (!sub || ['canceled', 'incomplete_expired'].includes(sub.status)) {
    return page(res, 200, 'Card saved',
      '<p>Your card is on file. This account is not active right now; reply to any TreeSnap email to restart it.</p>');
  }
  if (sub.default_payment_method !== pmId) {
    await stripe.subscriptions.update(sub.id, { default_payment_method: pmId });
  }
  const shop = `<a href="https://${customer.subdomain}.treesnap.cloud">${customer.subdomain}.treesnap.cloud</a>`;

  if (['paused', 'past_due', 'unpaid'].includes(sub.status)) {
    let outcome = 'failed';
    try {
      outcome = await chargeNow(stripe, sub, pmId);
    } catch (err) {
      console.error('Billing return: charge failed:', err.message);
    }
    if (outcome === 'paid') {
      return page(res, 200, 'Card saved. Your tool is back on.',
        `<p>The payment went through. ${shop} takes estimate requests again within a minute or two.</p>`);
    }
    if (outcome === 'nothing') {
      return page(res, 200, 'Card saved',
        `<p>Your card is on file and there is nothing to charge right now. If ${shop} is still
         not taking requests, reply to any TreeSnap email and we will sort it out.</p>`);
    }
    return page(res, 200, 'Card saved, but the charge did not go through',
      `<p>Your card is on file, but the payment was declined or is still processing, so ${shop}
       stays paused for now. Try another card with the same link, or reply to any TreeSnap email.</p>`);
  }
  if (sub.status === 'trialing') {
    return page(res, 200, 'Card saved',
      '<p>Your tool keeps running when the trial ends. The first monthly charge goes to this card on the trial end date.</p>');
  }
  return page(res, 200, 'Card saved', '<p>Future monthly charges will use this card.</p>');
}

// Returns 'paid' | 'failed' | 'nothing'.
async function chargeNow(stripe, sub, pmId) {
  let invoice = (await stripe.invoices.list({ subscription: sub.id, status: 'open', limit: 1 })).data[0];
  if (!invoice && sub.status === 'paused') {
    // Resuming creates the first invoice but doesn't charge it (open, auto_advance
    // off) and the sub stays paused until it's paid. The key is per pause (the
    // pre-resume latest invoice), so two overlapping returns resume once.
    const resumed = await stripe.subscriptions.resume(
      sub.id,
      { billing_cycle_anchor: 'now', expand: ['latest_invoice'] },
      { idempotencyKey: `treesnap-resume-${sub.id}-${typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id}` },
    );
    invoice = resumed.latest_invoice;
    if (invoice?.status === 'draft') invoice = await stripe.invoices.finalizeInvoice(invoice.id);
  }
  if (!invoice) return 'nothing';
  if (invoice.status === 'open') {
    try {
      invoice = await stripe.invoices.pay(invoice.id, { payment_method: pmId },
        { idempotencyKey: `treesnap-pay-${invoice.id}-${pmId}` });
    } catch (err) {
      // A concurrent return may have paid it already.
      invoice = await stripe.invoices.retrieve(invoice.id);
      if (invoice.status !== 'paid') throw err;
    }
  }
  return invoice.status === 'paid' ? 'paid' : 'failed';
}

// "Email me a link" on a paused shop page. The response never says whether the
// shop exists or what its email is; the link only goes to the owner on file.
async function requestLink(req, res) {
  const generic = { ok: true, message: 'If this is your shop, we just emailed the owner a link to turn it back on.' };
  const host = req.headers.host ?? '';
  const subdomain = host.split('.')[0].toLowerCase();

  const ipLimit = await rateLimit({ bucket: 'billing_link_ip', identifier: clientIp(req), windowSeconds: 3600, max: 5 });
  if (!ipLimit.allowed) return res.status(200).json(generic);

  const { data: customer } = await supabase
    .from('customers')
    .select('id, email, owner_name, status, stripe_customer_id, stripe_subscription_id')
    .eq('subdomain', subdomain)
    .single();

  // Only when Stripe agrees a card would fix it. An admin pause (DB-only) or a
  // canceled shop gets nothing; adding a card would not turn those back on.
  if (customer?.email && customer.stripe_subscription_id && ['paused', 'past_due'].includes(customer.status)) {
    try {
      const sub = await getStripe().subscriptions.retrieve(customer.stripe_subscription_id);
      if (['paused', 'past_due', 'unpaid'].includes(sub.status)) {
        // One send per shop per hour, three per day: the button is on a public
        // page, so anyone can press it. Counted only when an email would actually go out, and
        // fails closed (no send) if the limiter itself can't be reached.
        const perShop = await rateLimit({ bucket: 'billing_link_send', identifier: customer.id, windowSeconds: 3600, max: 1 });
        const perDay = perShop.allowed && !perShop.error
          ? await rateLimit({ bucket: 'billing_link_send_day', identifier: customer.id, windowSeconds: 86400, max: 3 })
          : { allowed: false };
        if (perShop.allowed && !perShop.error && perDay.allowed && !perDay.error) {
          await sendBillingLinkEmail(customer, billingLinkUrl(customer.id));
        }
      }
    } catch (err) {
      console.error('Billing link request failed:', err.message);
    }
  }
  return res.status(200).json(generic);
}
