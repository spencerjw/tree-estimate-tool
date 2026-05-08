// Admin action — send an existing customer a Stripe Checkout link for a tier upgrade.
// POST /api/admin/upgrade-customer  { password, customerId, targetTier }

import Stripe from 'stripe';
import { supabase } from '../../lib/supabase.js';
import { sendUpgradeCheckoutEmail } from '../../lib/emails.js';

const UPGRADE_PRICE_IDS = {
  starter_pro:     process.env.STRIPE_UPGRADE_PRICE_STARTER_TO_PRO,
  starter_proplus: process.env.STRIPE_UPGRADE_PRICE_STARTER_TO_PROPLUS,
  pro_proplus:     process.env.STRIPE_UPGRADE_PRICE_PRO_TO_PROPLUS,
};

const UPGRADE_FEES = {
  starter_pro: 150, starter_proplus: 250, pro_proplus: 125,
};

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

  const { customerId, targetTier } = req.body ?? {};
  if (!customerId || !targetTier) {
    return res.status(400).json({ error: 'Missing customerId or targetTier' });
  }

  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .single();

  if (custErr || !customer) return res.status(404).json({ error: 'Customer not found' });

  const upgradeKey = `${customer.tier}_${targetTier}`;
  const priceId    = UPGRADE_PRICE_IDS[upgradeKey];
  const upgradeFee = UPGRADE_FEES[upgradeKey];

  if (!priceId) {
    return res.status(400).json({ error: `No upgrade path from ${customer.tier} to ${targetTier}` });
  }

  const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY);
  const appUrl  = process.env.APP_URL ?? 'https://treesnap.cloud';

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
