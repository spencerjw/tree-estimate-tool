// Admin API — password-protected endpoint for the TreeSnap admin panel.
// All actions require ADMIN_PASSWORD in the request body or query string.

import { supabase } from '../lib/supabase.js';
import {
  approveLead, rejectLead, resendOnboarding,
  upgradeCustomer, extendTrial, togglePause, editConfig, deleteCustomer,
} from '../lib/admin-actions.js';

const TIER_LIMITS = { starter: 50, pro: 250, proplus: 'Unlimited' };

// POST action name → handler. Each runs only after the password check below.
const POST_ACTIONS = {
  'approve':      approveLead,
  'reject':       rejectLead,
  'resend':       resendOnboarding,
  'upgrade':      upgradeCustomer,
  'extend-trial': extendTrial,
  'toggle-pause': togglePause,
  'edit-config':  editConfig,
  'delete':       deleteCustomer,
};

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
  // POST — mutate actions (handlers live in lib/admin-actions.js)
  // -------------------------------------------------------------------------
  if (req.method === 'POST') {
    const { action } = req.body ?? {};
    // hasOwn guard so inherited props ('constructor', 'toString', …) can't be invoked.
    const fn = Object.hasOwn(POST_ACTIONS, action) ? POST_ACTIONS[action] : null;
    if (typeof fn !== 'function') return res.status(400).json({ error: `Unknown action: ${action}` });
    return fn(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
