// Onboarding API — serves prefill data and saves config + creates Stripe checkout.
// GET  /api/onboarding?token=<token>  → prefill fields for the form
// POST /api/onboarding                → save config, create Stripe checkout, return URL

import Stripe from 'stripe';
import { supabase } from '../lib/supabase.js';

const SETUP_PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_SETUP_STARTER,
  pro:     process.env.STRIPE_PRICE_SETUP_PRO,
  proplus: process.env.STRIPE_PRICE_SETUP_PROPLUS,
};

const TOKEN_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

async function getLeadByToken(token) {
  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('onboarding_token', token)
    .is('onboarding_completed_at', null)
    .single();
  return lead;
}

function isExpired(lead) {
  return Date.now() - new Date(lead.created_at).getTime() > TOKEN_TTL_MS;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // -------------------------------------------------------------------------
  // GET — validate token and return prefill data
  // -------------------------------------------------------------------------
  if (req.method === 'GET') {
    const { token } = req.query ?? {};
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const lead = await getLeadByToken(token);
    if (!lead) return res.status(404).json({ error: 'invalid_token' });
    if (isExpired(lead)) return res.status(410).json({ error: 'token_expired' });

    return res.status(200).json({
      company_name: lead.company,
      owner_name:   lead.name,
      email:        lead.email,
      phone:        lead.phone,
      subdomain:    lead.subdomain,
      tier:         lead.tier,
    });
  }

  // -------------------------------------------------------------------------
  // POST — save config and create Stripe checkout
  // -------------------------------------------------------------------------
  if (req.method === 'POST') {
    const {
      token,
      business_name,
      phone,
      service_zips,
      removal_low,
      removal_high,
      trimming_low,
      trimming_high,
      minimum_job,
      emergency_multiplier,
      add_ons,
      theme,
      custom_disclaimer,
    } = req.body ?? {};

    if (!token) return res.status(400).json({ error: 'Missing token' });

    const lead = await getLeadByToken(token);
    if (!lead) return res.status(404).json({ error: 'invalid_token' });
    if (isExpired(lead)) return res.status(410).json({ error: 'token_expired' });

    if (!business_name || !phone || !removal_low || !removal_high || !trimming_low || !trimming_high) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    const onboardingConfig = {
      business_name,
      phone,
      service_zips:          Array.isArray(service_zips) ? service_zips : [],
      removal_low:           Number(removal_low),
      removal_high:          Number(removal_high),
      trimming_low:          Number(trimming_low),
      trimming_high:         Number(trimming_high),
      minimum_job:           Number(minimum_job) || 350,
      emergency_multiplier:  Number(emergency_multiplier) || 1.5,
      add_ons:               Array.isArray(add_ons) ? add_ons : [],
      theme:                 theme || 'forest-green',
      custom_disclaimer:     custom_disclaimer || null,
    };

    // Save config and mark onboarding complete
    const { error: updateErr } = await supabase
      .from('leads')
      .update({
        onboarding_config:       onboardingConfig,
        onboarding_completed_at: new Date().toISOString(),
        company:                 business_name,
        phone,
      })
      .eq('id', lead.id);

    if (updateErr) {
      return res.status(500).json({ error: updateErr.message });
    }

    // Create Stripe checkout for setup fee
    const priceId = SETUP_PRICE_IDS[lead.tier];
    if (!priceId) {
      return res.status(500).json({
        error: `No setup price configured for tier "${lead.tier}". Set STRIPE_PRICE_SETUP_${lead.tier.toUpperCase()} env var.`,
      });
    }

    const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY);
    const appUrl  = process.env.APP_URL ?? 'https://app.treesnap.cloud';

    const session = await stripe.checkout.sessions.create({
      mode:           'payment',
      line_items:     [{ price: priceId, quantity: 1 }],
      customer_email: lead.email,
      payment_intent_data: { setup_future_usage: 'off_session' },
      metadata:       { lead_id: lead.id, tier: lead.tier, subdomain: lead.subdomain },
      success_url:    `${appUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:     `${appUrl}/onboard?token=${token}`,
    });

    return res.status(200).json({ success: true, checkoutUrl: session.url });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
