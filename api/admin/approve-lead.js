// Admin action — approve a pending lead and send them a Stripe Checkout link.
// POST /api/admin/approve-lead  { password, leadId }

import Stripe from 'stripe';
import { supabase } from '../../lib/supabase.js';
import { sendApprovalEmail } from '../../lib/emails.js';

const SETUP_PRICE_IDS = {
  starter: process.env.STRIPE_SETUP_PRICE_STARTER,
  pro:     process.env.STRIPE_SETUP_PRICE_PRO,
  proplus: process.env.STRIPE_SETUP_PRICE_PROPLUS,
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

  const { leadId } = req.body ?? {};
  if (!leadId) return res.status(400).json({ error: 'Missing leadId' });

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single();

  if (leadErr || !lead) return res.status(404).json({ error: 'Lead not found' });
  if (lead.status !== 'pending') {
    return res.status(400).json({ error: `Lead is already ${lead.status}` });
  }

  const priceId = SETUP_PRICE_IDS[lead.tier];
  if (!priceId) {
    return res.status(500).json({ error: `No setup price configured for tier "${lead.tier}". Set STRIPE_SETUP_PRICE_${lead.tier.toUpperCase()} env var.` });
  }

  const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY);
  const appUrl  = process.env.APP_URL ?? 'https://treesnap.cloud';

  const session = await stripe.checkout.sessions.create({
    mode:           'payment',
    line_items:     [{ price: priceId, quantity: 1 }],
    customer_email: lead.email,
    metadata:       { lead_id: lead.id, tier: lead.tier },
    success_url:    `${appUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:     `${appUrl}/apply?canceled=1`,
    expires_at:     Math.floor(Date.now() / 1000) + 86400, // 24 h
  });

  await supabase
    .from('leads')
    .update({ status: 'approved', checkout_session_id: session.id })
    .eq('id', leadId);

  await sendApprovalEmail(lead, session.url);

  return res.status(200).json({ checkoutUrl: session.url });
}
