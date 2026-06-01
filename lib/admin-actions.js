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
  sendEmailChangedNotice,
  sendEmailChangeConfirmation,
  sendAccountChangeSummary,
} from './emails.js';

// Notify the customer's current address of admin-made changes, with old → new
// values. Best-effort: never blocks the action; failures are collected as
// warnings. `changes` is an array of { label, from, to }.
async function notifyAccountChange(customer, toEmail, changes, warnings) {
  if (!changes.length || !toEmail) return;
  try {
    await sendAccountChangeSummary(toEmail, customer, changes);
    await supabase.from('email_log').insert({
      customer_id: customer.id, email_type: 'account_updated', recipient: toEmail,
    });
  } catch (e) {
    warnings.push(`Change-summary email failed: ${e.message}`);
  }
}

function fmtDay(d) {
  return d ? new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '—';
}

const STATUS_LABELS = {
  trialing: 'Trialing', active: 'Active', past_due: 'Past Due',
  paused: 'Paused (estimate tool offline)', canceled: 'Canceled',
};

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
    .from('customers').select('id, email, owner_name, company_name, stripe_subscription_id, trial_end, status').eq('id', customer_id).single();
  if (custErr || !customer) return res.status(404).json({ error: 'Customer not found' });
  if (!customer.stripe_subscription_id) {
    return res.status(400).json({ error: 'Customer has no active subscription to extend' });
  }

  const base        = Math.max(Date.now(), new Date(customer.trial_end).getTime());
  const newTrialEnd = base + numDays * 86400000;
  const newTrialIso = new Date(newTrialEnd).toISOString();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  await stripe.subscriptions.update(customer.stripe_subscription_id, {
    trial_end: Math.floor(newTrialEnd / 1000),
  });

  await supabase
    .from('customers')
    .update({ trial_end: newTrialIso, trial_extended: true })
    .eq('id', customer_id);

  const warnings = [];
  await notifyAccountChange(customer, customer.email,
    [{ label: 'Trial End Date', from: fmtDay(customer.trial_end), to: fmtDay(newTrialIso) }], warnings);

  return res.status(200).json({ success: true, new_trial_end: newTrialIso, warnings });
}

export async function togglePause(req, res) {
  const { customerId } = req.body ?? {};
  if (!customerId) return res.status(400).json({ error: 'Missing customerId' });

  const { data: customer, error: fetchError } = await supabase
    .from('customers').select('id, email, owner_name, company_name, status').eq('id', customerId).single();
  if (fetchError || !customer) return res.status(404).json({ error: 'Customer not found' });

  const newStatus = customer.status === 'paused' ? 'active' : 'paused';
  const { error } = await supabase.from('customers').update({ status: newStatus }).eq('id', customerId);
  if (error) return res.status(500).json({ error: error.message });

  const warnings = [];
  await notifyAccountChange(customer, customer.email,
    [{ label: 'Account Status', from: STATUS_LABELS[customer.status] ?? customer.status, to: STATUS_LABELS[newStatus] ?? newStatus }], warnings);

  return res.status(200).json({ success: true, new_status: newStatus, warnings });
}

// Admin edit of everything a customer set during onboarding: pricing config
// (customer_config) plus business_name/phone on the customers row. No customer
// self-serve UI yet — this is the admin's way to make those changes.
const VALID_THEMES = ['forest-green', 'deep-navy', 'slate-gray', 'burnt-orange', 'burgundy-red', 'charcoal'];

export async function editConfig(req, res) {
  const { customerId, config } = req.body ?? {};
  if (!customerId || !config || typeof config !== 'object') {
    return res.status(400).json({ error: 'Missing customerId or config' });
  }

  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .select('id, email, subdomain, stripe_customer_id, owner_name, company_name, business_name, phone')
    .eq('id', customerId).single();
  if (custErr || !customer) return res.status(404).json({ error: 'Customer not found' });

  // Snapshot the existing config so we can email the customer a before/after.
  const { data: oldCfg } = await supabase
    .from('customer_config').select('*').eq('customer_id', customerId).maybeSingle();

  // Numeric rates — empty/absent → null (keeps the column clearable); reject
  // negatives and NaN. Treat '' as "not provided" rather than 0.
  const num = v => (v === '' || v === null || v === undefined ? null : Number(v));
  const fields = {
    base_rate_removal_low:   num(config.removal_low),
    base_rate_removal_high:  num(config.removal_high),
    base_rate_trimming_low:  num(config.trimming_low),
    base_rate_trimming_high: num(config.trimming_high),
    minimum_job:             num(config.minimum_job),
    emergency_multiplier:    num(config.emergency_multiplier),
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== null && (!Number.isFinite(v) || v < 0)) {
      return res.status(400).json({ error: `${k} must be a non-negative number` });
    }
  }
  if (fields.base_rate_removal_low !== null && fields.base_rate_removal_high !== null
      && fields.base_rate_removal_low >= fields.base_rate_removal_high) {
    return res.status(400).json({ error: 'Removal high must be greater than low' });
  }
  if (fields.base_rate_trimming_low !== null && fields.base_rate_trimming_high !== null
      && fields.base_rate_trimming_low >= fields.base_rate_trimming_high) {
    return res.status(400).json({ error: 'Trimming high must be greater than low' });
  }
  // An emergency multiplier below 1 would discount emergencies — almost always a
  // typo, and 0 tells the estimate model to zero-out emergency pricing.
  if (fields.emergency_multiplier !== null && fields.emergency_multiplier < 1) {
    return res.status(400).json({ error: 'Emergency multiplier must be at least 1' });
  }

  const serviceZips = Array.isArray(config.service_zips)
    ? config.service_zips.map(z => String(z).trim()).filter(Boolean)
    : [];

  // add_ons: [{ name, low, high }] — same shape the estimate API consumes.
  const addOns = [];
  if (Array.isArray(config.add_ons)) {
    for (const a of config.add_ons) {
      if (!a || typeof a !== 'object') continue;
      const name = String(a.name ?? '').trim();
      if (!name) continue;
      const low  = Number(a.low)  || 0;
      const high = Number(a.high) || 0;
      if (low < 0 || high < 0) {
        return res.status(400).json({ error: `Add-on "${name}" prices must be non-negative` });
      }
      if (high < low) {
        return res.status(400).json({ error: `Add-on "${name}" high price must be ≥ low price` });
      }
      addOns.push({ name, low, high });
    }
  }

  const theme = VALID_THEMES.includes(config.theme) ? config.theme : 'forest-green';
  const disclaimer = config.custom_disclaimer
    ? String(config.custom_disclaimer).trim().slice(0, 500)
    : null;

  // customer_config — upsert on customer_id so a (rare) missing row self-heals.
  const { error: cfgErr } = await supabase
    .from('customer_config')
    .upsert({
      customer_id:      customerId,
      ...fields,
      service_zips:     serviceZips,
      add_ons:          addOns,
      theme,
      custom_disclaimer: disclaimer,
      updated_at:       new Date().toISOString(),
    }, { onConflict: 'customer_id' });
  if (cfgErr) return res.status(500).json({ error: `customer_config update: ${cfgErr.message}` });

  // business_name / phone / email live on the customers row and are also
  // onboarding-set. Email is unique and referenced by the originating lead
  // (matched on subdomain+email at delete) and by the Stripe customer, so a
  // change must propagate to both.
  const warnings = [];
  const customerUpdates = {};

  if (config.business_name !== undefined) {
    const bn = String(config.business_name ?? '').trim();
    if (!bn) return res.status(400).json({ error: 'Business name cannot be empty' });
    customerUpdates.business_name = bn;
  }
  if (config.phone !== undefined) {
    customerUpdates.phone = String(config.phone ?? '').trim() || null;
  }

  let emailChanged = false;
  let newEmail = null;
  if (config.email !== undefined) {
    newEmail = String(config.email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    if (newEmail !== customer.email) {
      const { data: clash } = await supabase
        .from('customers').select('id').eq('email', newEmail).neq('id', customerId).maybeSingle();
      if (clash) return res.status(409).json({ error: `Email "${newEmail}" is already used by another customer.` });
      customerUpdates.email = newEmail;
      emailChanged = true;
    }
  }

  if (Object.keys(customerUpdates).length) {
    const { error: cuErr } = await supabase.from('customers').update(customerUpdates).eq('id', customerId);
    if (cuErr) {
      // Unique violation = a concurrent edit grabbed the email between our check
      // and this write.
      if (cuErr.code === '23505') {
        return res.status(409).json({ error: 'That email is already in use by another customer.' });
      }
      return res.status(500).json({ error: `customers update: ${cuErr.message}` });
    }
  }

  // Keep the originating lead and the Stripe customer in sync with the new email.
  if (emailChanged) {
    // deleteCustomer matches the lead on (subdomain, email) — move it in lockstep
    // using the OLD email so the linkage survives.
    const { error: leadErr } = await supabase
      .from('leads').update({ email: newEmail })
      .eq('subdomain', customer.subdomain).eq('email', customer.email);
    if (leadErr) warnings.push(`Originating lead email not updated: ${leadErr.message}`);

    if (customer.stripe_customer_id) {
      try {
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        await stripe.customers.update(customer.stripe_customer_id, { email: newEmail });
      } catch (e) {
        warnings.push(`Stripe customer email not synced: ${e.message}`);
      }
    }

    // Security: notify the PREVIOUS address so an unauthorized change (e.g.
    // someone phoning support to swap it) is caught by the real owner.
    try {
      await sendEmailChangedNotice(customer.email, newEmail, customer);
      await supabase.from('email_log').insert({
        customer_id: customerId, email_type: 'email_changed', recipient: customer.email,
      });
    } catch (e) {
      warnings.push(`Change-notification email to the previous address failed: ${e.message}`);
    }

    // Confirm to the NEW address that the change completed.
    try {
      await sendEmailChangeConfirmation(newEmail, customer);
      await supabase.from('email_log').insert({
        customer_id: customerId, email_type: 'email_change_confirmed', recipient: newEmail,
      });
    } catch (e) {
      warnings.push(`Confirmation email to the new address failed: ${e.message}`);
    }
  }

  // Email the customer a before/after of every non-email setting that changed.
  // (Email itself has its own dedicated old/new notices above.)
  const o = oldCfg || {};
  const range = (lo, hi) => (lo != null ? `$${lo}–$${hi}` : '—');
  const money = v => (v != null ? `$${v}` : '—');
  const mult  = v => (v != null ? `${v}×` : '—');
  const zipsF = a => (a && a.length ? a.join(', ') : 'All areas');
  const addF  = a => (a && a.length ? a.map(x => `${x.name} ($${x.low}–$${x.high})`).join('; ') : 'None');
  const themeF = k => ({ 'forest-green': 'Forest Green', 'deep-navy': 'Deep Navy', 'slate-gray': 'Slate Gray', 'burnt-orange': 'Burnt Orange', 'burgundy-red': 'Burgundy Red', 'charcoal': 'Charcoal Black' }[k] || k || '—');
  const textF = v => (v && String(v).trim() ? String(v) : '—');

  const changes = [];
  const diff = (label, from, to) => { if (from !== to) changes.push({ label, from, to }); };

  if ('business_name' in customerUpdates) diff('Business Name', textF(customer.business_name), textF(customerUpdates.business_name));
  if ('phone' in customerUpdates)         diff('Phone', textF(customer.phone), textF(customerUpdates.phone));
  diff('Removal Rate',        range(o.base_rate_removal_low, o.base_rate_removal_high),   range(fields.base_rate_removal_low, fields.base_rate_removal_high));
  diff('Trimming Rate',       range(o.base_rate_trimming_low, o.base_rate_trimming_high), range(fields.base_rate_trimming_low, fields.base_rate_trimming_high));
  diff('Minimum Job',         money(o.minimum_job),          money(fields.minimum_job));
  diff('Emergency Multiplier', mult(o.emergency_multiplier), mult(fields.emergency_multiplier));
  diff('Service Zips',        zipsF(o.service_zips),         zipsF(serviceZips));
  diff('Add-ons',             addF(o.add_ons),               addF(addOns));
  diff('Theme',               themeF(o.theme),               themeF(theme));
  diff('Custom Disclaimer',   textF(o.custom_disclaimer),    textF(disclaimer));

  await notifyAccountChange(customer, emailChanged ? newEmail : customer.email, changes, warnings);

  const { data: updated } = await supabase
    .from('customers').select('*, customer_config(*)').eq('id', customerId).single();
  return res.status(200).json({ success: true, customer: updated, warnings });
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
