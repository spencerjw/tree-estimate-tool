// All admin mutation handlers, dispatched from api/admin.js by `action`.
// Consolidated here (lib/ files are not Vercel serverless functions) to stay
// under the Hobby-plan 12-function limit. The dispatcher verifies the admin
// password before calling any of these, so they assume the caller is authorized.

import { randomUUID } from 'crypto';
import Stripe from 'stripe';
import { supabase } from './supabase.js';
import {
  sendOnboardingApprovalEmail,
  sendRejectionEmail,
  sendUpgradeCheckoutEmail,
} from './emails.js';

const UPGRADE_PRICE_IDS = {
  starter_pro:     process.env.STRIPE_UPGRADE_PRICE_STARTER_TO_PRO,
  starter_proplus: process.env.STRIPE_UPGRADE_PRICE_STARTER_TO_PROPLUS,
  pro_proplus:     process.env.STRIPE_UPGRADE_PRICE_PRO_TO_PROPLUS,
};
const UPGRADE_FEES = { starter_pro: 150, starter_proplus: 250, pro_proplus: 125 };

// ---------------------------------------------------------------------------
// Lead lifecycle
// ---------------------------------------------------------------------------
export async function approveLead(req, res) {
  const { leadId } = req.body ?? {};
  if (!leadId) return res.status(400).json({ error: 'Missing leadId' });

  const { data: lead, error: leadErr } = await supabase
    .from('leads').select('*').eq('id', leadId).single();

  if (leadErr || !lead) return res.status(404).json({ error: 'Lead not found' });
  if (lead.status !== 'pending') {
    return res.status(400).json({ error: `Lead is already ${lead.status}` });
  }

  const { data: existing } = await supabase
    .from('customers').select('id').eq('subdomain', lead.subdomain).maybeSingle();
  if (existing) {
    return res.status(409).json({ error: `Subdomain "${lead.subdomain}" is already in use by an active customer.` });
  }

  const token  = randomUUID();
  const appUrl = process.env.APP_URL ?? 'https://app.treesnap.cloud';

  const { error: updateErr } = await supabase
    .from('leads')
    .update({ status: 'approved', onboarding_token: token, onboarding_token_issued_at: new Date().toISOString() })
    .eq('id', leadId);
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  await sendOnboardingApprovalEmail(lead, `${appUrl}/onboard?token=${token}`);
  return res.status(200).json({ success: true });
}

export async function rejectLead(req, res) {
  const { leadId, reason } = req.body ?? {};
  if (!leadId) return res.status(400).json({ error: 'Missing leadId' });

  const { data: lead, error: leadErr } = await supabase
    .from('leads').select('*').eq('id', leadId).single();
  if (leadErr || !lead) return res.status(404).json({ error: 'Lead not found' });

  await supabase.from('leads').update({ status: 'rejected', notes: reason || null }).eq('id', leadId);
  await sendRejectionEmail(lead, reason || null);
  return res.status(200).json({ success: true });
}

export async function resendOnboarding(req, res) {
  const { leadId } = req.body ?? {};
  if (!leadId) return res.status(400).json({ error: 'Missing leadId' });

  const { data: lead, error: leadErr } = await supabase
    .from('leads').select('*').eq('id', leadId).single();
  if (leadErr || !lead) return res.status(404).json({ error: 'Lead not found' });

  if (lead.status === 'provisioned') {
    return res.status(400).json({ error: 'This customer is already provisioned — no setup link needed.' });
  }
  if (lead.status !== 'approved') {
    return res.status(400).json({ error: `Lead is "${lead.status}". Approve it first to send a setup link.` });
  }

  const { data: existing } = await supabase
    .from('customers').select('id').eq('subdomain', lead.subdomain).maybeSingle();
  if (existing) {
    return res.status(409).json({ error: `Subdomain "${lead.subdomain}" is already in use by an active customer.` });
  }

  const token  = randomUUID();
  const appUrl = process.env.APP_URL ?? 'https://app.treesnap.cloud';

  // Re-issue the token and reset its expiry clock via onboarding_token_issued_at
  // — no longer clobbering created_at (which corrupted the lead's real age).
  const { error: updateErr } = await supabase
    .from('leads')
    .update({ onboarding_token: token, onboarding_completed_at: null, onboarding_token_issued_at: new Date().toISOString() })
    .eq('id', leadId);
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  await sendOnboardingApprovalEmail(lead, `${appUrl}/onboard?token=${token}`);
  return res.status(200).json({ success: true });
}

// ---------------------------------------------------------------------------
// Customer lifecycle
// ---------------------------------------------------------------------------
export async function upgradeCustomer(req, res) {
  const { customerId, targetTier } = req.body ?? {};
  if (!customerId || !targetTier) {
    return res.status(400).json({ error: 'Missing customerId or targetTier' });
  }

  const { data: customer, error: custErr } = await supabase
    .from('customers').select('*').eq('id', customerId).single();
  if (custErr || !customer) return res.status(404).json({ error: 'Customer not found' });

  const upgradeKey = `${customer.tier}_${targetTier}`;
  const priceId    = UPGRADE_PRICE_IDS[upgradeKey];
  const upgradeFee = UPGRADE_FEES[upgradeKey];
  if (!priceId) {
    return res.status(400).json({ error: `No upgrade path from ${customer.tier} to ${targetTier}` });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const appUrl = process.env.APP_URL ?? 'https://treesnap.cloud';

  const session = await stripe.checkout.sessions.create({
    mode:       'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    customer:   customer.stripe_customer_id,
    metadata:   { customer_id: customer.id, action: 'upgrade', target_tier: targetTier },
    success_url: `${appUrl}/welcome?session_id={CHECKOUT_SESSION_ID}&upgrade=1`,
    cancel_url:  `https://${customer.subdomain}.treesnap.cloud`,
  });

  await sendUpgradeCheckoutEmail(customer, targetTier, session.url, upgradeFee);
  return res.status(200).json({ checkoutUrl: session.url });
}

export async function extendTrial(req, res) {
  const { customer_id, days } = req.body ?? {};
  if (!customer_id || !days) {
    return res.status(400).json({ error: 'Missing customer_id or days' });
  }

  const numDays = Number(days);
  if (!Number.isInteger(numDays) || numDays < 1 || numDays > 90) {
    return res.status(400).json({ error: 'days must be an integer between 1 and 90' });
  }

  const { data: customer, error: custErr } = await supabase
    .from('customers').select('id, stripe_subscription_id, trial_end, status').eq('id', customer_id).single();
  if (custErr || !customer) return res.status(404).json({ error: 'Customer not found' });
  if (!customer.stripe_subscription_id) {
    return res.status(400).json({ error: 'Customer has no active subscription to extend' });
  }

  const base        = Math.max(Date.now(), new Date(customer.trial_end).getTime());
  const newTrialEnd = base + numDays * 86400000;

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  await stripe.subscriptions.update(customer.stripe_subscription_id, {
    trial_end: Math.floor(newTrialEnd / 1000),
  });

  await supabase
    .from('customers')
    .update({ trial_end: new Date(newTrialEnd).toISOString(), trial_extended: true })
    .eq('id', customer_id);

  return res.status(200).json({ success: true, new_trial_end: new Date(newTrialEnd).toISOString() });
}

export async function togglePause(req, res) {
  const { customerId } = req.body ?? {};
  if (!customerId) return res.status(400).json({ error: 'Missing customerId' });

  const { data: customer, error: fetchError } = await supabase
    .from('customers').select('status').eq('id', customerId).single();
  if (fetchError || !customer) return res.status(404).json({ error: 'Customer not found' });

  const newStatus = customer.status === 'paused' ? 'active' : 'paused';
  const { error } = await supabase.from('customers').update({ status: newStatus }).eq('id', customerId);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ success: true, new_status: newStatus });
}

// ---------------------------------------------------------------------------
// Customer deletion (full teardown) + helpers
// ---------------------------------------------------------------------------
async function teardownStripe(customer, results) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { results.stripe = 'skipped (no STRIPE_SECRET_KEY)'; return; }
  const stripe = new Stripe(key);

  if (customer.stripe_subscription_id) {
    try {
      await stripe.subscriptions.cancel(customer.stripe_subscription_id);
      results.stripe_subscription = 'canceled';
    } catch (e) {
      results.stripe_subscription = e.code === 'resource_missing' ? 'already gone' : `error: ${e.message}`;
    }
  }
  if (customer.stripe_customer_id) {
    try {
      await stripe.customers.del(customer.stripe_customer_id);
      results.stripe_customer = 'deleted';
    } catch (e) {
      results.stripe_customer = e.code === 'resource_missing' ? 'already gone' : `error: ${e.message}`;
    }
  }
}

async function removeCloudflareCname(subdomain, results) {
  const zone  = process.env.CLOUDFLARE_ZONE_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!zone || !token) { results.cloudflare = 'skipped (no Cloudflare env)'; return; }
  const name = `${subdomain}.treesnap.cloud`;
  try {
    const listResp = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const listData = await listResp.json();
    const record = listData.result?.[0];
    if (!record) { results.cloudflare = 'no record found'; return; }

    const delResp = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records/${record.id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
    const delData = await delResp.json();
    results.cloudflare = delData.success ? 'deleted' : `error: ${JSON.stringify(delData.errors)}`;
  } catch (e) {
    results.cloudflare = `error: ${e.message}`;
  }
}

async function removeVercelDomain(subdomain, results) {
  const token   = process.env.VERCEL_API_TOKEN;
  const project = process.env.VERCEL_PROJECT_ID;
  if (!token || !project) { results.vercel = 'skipped (no Vercel env)'; return; }
  const domain = `${subdomain}.treesnap.cloud`;
  try {
    const resp = await fetch(
      `https://api.vercel.com/v9/projects/${project}/domains/${domain}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
    if (resp.ok) {
      results.vercel = 'deleted';
    } else {
      const d = await resp.json().catch(() => ({}));
      results.vercel = resp.status === 404 ? 'already gone' : `error: ${d.error?.message || resp.status}`;
    }
  } catch (e) {
    results.vercel = `error: ${e.message}`;
  }
}

export async function deleteCustomer(req, res) {
  const { customerId } = req.body ?? {};
  if (!customerId) return res.status(400).json({ error: 'Missing customerId' });

  const { data: customer, error: fetchErr } = await supabase
    .from('customers').select('*').eq('id', customerId).single();
  if (fetchErr || !customer) return res.status(404).json({ error: 'Customer not found' });

  const results = {};

  // External teardown first — needs the IDs/subdomain from the row.
  await teardownStripe(customer, results);
  await removeCloudflareCname(customer.subdomain, results);
  await removeVercelDomain(customer.subdomain, results);

  // DB teardown — cascades to customer_config, estimates, monthly_usage, email_log.
  const { error: delErr } = await supabase.from('customers').delete().eq('id', customerId);
  results.supabase_customer = delErr ? `error: ${delErr.message}` : 'deleted (cascaded config/estimates/usage/email_log)';

  // Free the originating lead — scoped by subdomain AND email.
  const { error: leadErr } = await supabase
    .from('leads').delete().eq('subdomain', customer.subdomain).eq('email', customer.email);
  results.lead = leadErr ? `error: ${leadErr.message}` : 'deleted';

  const warnings = Object.entries(results)
    .filter(([, v]) => typeof v === 'string' && v.startsWith('error:'))
    .map(([k, v]) => `${k}: ${v}`);

  return res.status(delErr ? 500 : 200).json({
    success: !delErr,
    subdomain: customer.subdomain,
    warnings,
    results,
  });
}
