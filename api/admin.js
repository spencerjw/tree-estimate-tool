// Admin API — password-protected endpoint for the TreeSnap admin panel.
// All actions require ADMIN_PASSWORD in the request body or query string.

import { supabase } from '../lib/supabase.js';

const TIER_LIMITS = { starter: 50, pro: 250, proplus: 'Unlimited' };

function checkPassword(req) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return false;
  const provided = req.method === 'GET'
    ? req.query?.password
    : req.body?.password;
  return provided === adminPassword;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!checkPassword(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // -------------------------------------------------------------------------
  // GET — list all customers with this-month usage
  // -------------------------------------------------------------------------
  if (req.method === 'GET') {
    const monthKey = new Date().toISOString().slice(0, 7);

    const [customersResult, usageResult, leadsResult] = await Promise.all([
      supabase
        .from('customers')
        .select('*, customer_config(*)')
        .order('created_at', { ascending: false }),
      supabase
        .from('monthly_usage')
        .select('customer_id, estimate_count')
        .eq('month_key', monthKey),
      supabase
        .from('leads')
        .select('*')
        .order('created_at', { ascending: false }),
    ]);

    if (customersResult.error) {
      return res.status(500).json({ error: customersResult.error.message });
    }

    const usageMap = {};
    for (const u of (usageResult.data ?? [])) {
      usageMap[u.customer_id] = u.estimate_count;
    }

    const customers = (customersResult.data ?? []).map(c => ({
      ...c,
      estimates_this_month: usageMap[c.id] ?? 0,
      monthly_limit: TIER_LIMITS[c.tier] ?? 50,
    }));

    const leads = leadsResult.data ?? [];

    return res.status(200).json({ customers, leads, month_key: monthKey });
  }

  // -------------------------------------------------------------------------
  // POST — mutate actions
  // -------------------------------------------------------------------------
  if (req.method === 'POST') {
    const { action, customerId } = req.body ?? {};

    if (!action || !customerId) {
      return res.status(400).json({ error: 'Missing action or customerId' });
    }

    if (action === 'extend-trial') {
      const { data: customer, error: fetchError } = await supabase
        .from('customers')
        .select('trial_end')
        .eq('id', customerId)
        .single();

      if (fetchError || !customer) {
        return res.status(404).json({ error: 'Customer not found' });
      }

      const newEnd = new Date(customer.trial_end);
      newEnd.setDate(newEnd.getDate() + 7);

      const { error } = await supabase
        .from('customers')
        .update({ trial_end: newEnd.toISOString(), trial_extended: true })
        .eq('id', customerId);

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true, new_trial_end: newEnd.toISOString() });
    }

    if (action === 'toggle-pause') {
      const { data: customer, error: fetchError } = await supabase
        .from('customers')
        .select('status')
        .eq('id', customerId)
        .single();

      if (fetchError || !customer) {
        return res.status(404).json({ error: 'Customer not found' });
      }

      const newStatus = customer.status === 'paused' ? 'active' : 'paused';

      const { error } = await supabase
        .from('customers')
        .update({ status: newStatus })
        .eq('id', customerId);

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ success: true, new_status: newStatus });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
