// Admin action — permanently delete a customer and tear down everything
// provisioning created: Stripe subscription + customer, Cloudflare CNAME,
// Vercel domain, the Supabase customers row (cascades to customer_config,
// estimates, monthly_usage, email_log), and the originating lead.
//
// External steps are best-effort: a failure on one is recorded but does not
// block the rest, so a stuck Stripe/DNS call can't prevent freeing the DB
// (which holds the unique subdomain/email constraints). Returns a per-step report.
//
// POST /api/admin/delete-customer  { password, customerId }

import Stripe from 'stripe';
import { supabase } from '../../lib/supabase.js';

function checkPassword(req) {
  const pw = process.env.ADMIN_PASSWORD;
  return pw && req.body?.password === pw;
}

async function teardownStripe(customer, results) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { results.stripe = 'skipped (no STRIPE_SECRET_KEY)'; return; }
  const stripe = new Stripe(key);

  if (customer.stripe_subscription_id) {
    try {
      await stripe.subscriptions.cancel(customer.stripe_subscription_id);
      results.stripe_subscription = 'canceled';
    } catch (e) {
      // resource_missing (already gone) is fine
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
      // 404 = not attached / already removed
      results.vercel = resp.status === 404 ? 'already gone' : `error: ${d.error?.message || resp.status}`;
    }
  } catch (e) {
    results.vercel = `error: ${e.message}`;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });
  if (!checkPassword(req))     return res.status(401).json({ error: 'Unauthorized' });

  const { customerId } = req.body ?? {};
  if (!customerId) return res.status(400).json({ error: 'Missing customerId' });

  const { data: customer, error: fetchErr } = await supabase
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .single();

  if (fetchErr || !customer) return res.status(404).json({ error: 'Customer not found' });

  const results = {};

  // External teardown first — needs the IDs/subdomain from the row.
  await teardownStripe(customer, results);
  await removeCloudflareCname(customer.subdomain, results);
  await removeVercelDomain(customer.subdomain, results);

  // DB teardown — cascades to customer_config, estimates, monthly_usage, email_log.
  const { error: delErr } = await supabase.from('customers').delete().eq('id', customerId);
  results.supabase_customer = delErr ? `error: ${delErr.message}` : 'deleted (cascaded config/estimates/usage/email_log)';

  // Free the originating lead — scoped by subdomain AND email so we don't wipe an
  // unrelated lead that happens to reuse the same subdomain string.
  const { error: leadErr } = await supabase
    .from('leads')
    .delete()
    .eq('subdomain', customer.subdomain)
    .eq('email', customer.email);
  results.lead = leadErr ? `error: ${leadErr.message}` : 'deleted';

  // Surface any external-step failures so the admin knows orphans may remain.
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
