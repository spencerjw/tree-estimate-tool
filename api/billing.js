// Billing portal entry for tree pros (no login; see lib/billing-link.js).
//
// GET  /api/billing?c&e&s        signed link -> Stripe portal, "update payment method" flow
// GET  /api/billing?c&e&s&r=1    portal return -> resume a trial that paused for lack of a card
// POST /api/billing              from a paused shop page: email the owner a fresh link

import { supabase } from '../lib/supabase.js';
import { getStripe } from '../lib/stripe.js';
import { billingLinkUrl, verifyBillingLink } from '../lib/billing-link.js';
import { rateLimit, clientIp } from '../lib/rate-limit.js';
import { sendBillingLinkEmail } from '../lib/emails.js';

const PORTAL_CONFIGURATION = 'bpc_1UMrOKGTb7xBM80F1LABPaA1'; // update payment method + invoices, no cancel

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

async function hasDefaultCard(stripe, stripeCustomerId) {
  const c = await stripe.customers.retrieve(stripeCustomerId);
  return !c.deleted && !!(c.invoice_settings?.default_payment_method || c.default_source);
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

// Back from the portal. If the trial already paused for lack of a card and a card
// is now on file, resume and bill now. Stripe charges the card; the webhook moves
// the shop back to active once that invoice is paid.
async function afterPortal(res, stripe, customer) {
  if (!(await hasDefaultCard(stripe, customer.stripe_customer_id))) {
    return page(res, 200, 'No card saved yet',
      '<p>Nothing changed. Use the link in your email again whenever you are ready.</p>');
  }
  const sub = customer.stripe_subscription_id
    ? await stripe.subscriptions.retrieve(customer.stripe_subscription_id)
    : null;
  if (sub?.status === 'paused') {
    await stripe.subscriptions.resume(sub.id, { billing_cycle_anchor: 'now' });
    return page(res, 200, 'Card saved. Your tool is turning back on.',
      `<p>We are charging the first month now. As soon as it goes through,
       <a href="https://${customer.subdomain}.treesnap.cloud">${customer.subdomain}.treesnap.cloud</a>
       takes estimate requests again. If the card is declined, we will email you.</p>`);
  }
  return page(res, 200, 'Card saved',
    '<p>Your tool keeps running when the trial ends. The first monthly charge happens on the trial end date.</p>');
}

// "Email me a link" on a paused shop page. The response never says whether the
// shop exists or what its email is; the link only goes to the owner on file.
async function requestLink(req, res) {
  const generic = { ok: true, message: 'If this is your shop, we just emailed the owner a link to turn it back on.' };
  const host = req.headers.host ?? '';
  const subdomain = host.split('.')[0].toLowerCase();

  const ipLimit = await rateLimit({ bucket: 'billing_link_ip', identifier: clientIp(req), windowSeconds: 3600, max: 5 });
  const subLimit = await rateLimit({ bucket: 'billing_link_sub', identifier: subdomain, windowSeconds: 86400, max: 3 });
  if (!ipLimit.allowed || !subLimit.allowed) return res.status(200).json(generic);

  const { data: customer } = await supabase
    .from('customers')
    .select('id, email, owner_name, status, stripe_customer_id')
    .eq('subdomain', subdomain)
    .single();

  if (customer?.email && customer.stripe_customer_id && ['paused', 'past_due'].includes(customer.status)) {
    try {
      await sendBillingLinkEmail(customer, billingLinkUrl(customer.id));
    } catch (err) {
      console.error('Billing link email failed:', err.message);
    }
  }
  return res.status(200).json(generic);
}
