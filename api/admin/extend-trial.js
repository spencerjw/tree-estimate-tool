// Admin action — extend a customer's Stripe trial and update Supabase.
// POST /api/admin/extend-trial  { password, customer_id, days }

import Stripe from 'stripe';
import { supabase } from '../../lib/supabase.js';

function checkPassword(req) {
  const pw = process.env.ADMIN_PASSWORD;
  return pw && req.body?.password === pw;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });
  if (!checkPassword(req))     return res.status(401).json({ error: 'Unauthorized' });

  const { customer_id, days } = req.body ?? {};

  if (!customer_id || !days) {
    return res.status(400).json({ error: 'Missing customer_id or days' });
  }

  const numDays = Number(days);
  if (!Number.isInteger(numDays) || numDays < 1 || numDays > 90) {
    return res.status(400).json({ error: 'days must be an integer between 1 and 90' });
  }

  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .select('id, stripe_subscription_id, trial_end, status')
    .eq('id', customer_id)
    .single();

  if (custErr || !customer) return res.status(404).json({ error: 'Customer not found' });

  if (!customer.stripe_subscription_id) {
    return res.status(400).json({ error: 'Customer has no active subscription to extend' });
  }

  // Extend from now if trial is already past, otherwise extend from current trial_end
  const base = Math.max(Date.now(), new Date(customer.trial_end).getTime());
  const newTrialEnd = base + numDays * 86400000;

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  await stripe.subscriptions.update(customer.stripe_subscription_id, {
    trial_end: Math.floor(newTrialEnd / 1000),
  });

  await supabase
    .from('customers')
    .update({
      trial_end:      new Date(newTrialEnd).toISOString(),
      trial_extended: true,
    })
    .eq('id', customer_id);

  return res.status(200).json({
    success:       true,
    new_trial_end: new Date(newTrialEnd).toISOString(),
  });
}
