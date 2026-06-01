// Admin action — regenerate a lead's onboarding token and re-send the setup link.
// Use when an approval link expired or a customer got stuck mid-onboarding
// (e.g. abandoned at Stripe checkout). Resets the token, the completion flag,
// and the 72h TTL clock, then re-sends the approval email.
// POST /api/admin/resend-onboarding  { password, leadId }

import { randomUUID } from 'crypto';
import { supabase } from '../../lib/supabase.js';
import { sendOnboardingApprovalEmail } from '../../lib/emails.js';

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

  if (lead.status === 'provisioned') {
    return res.status(400).json({ error: 'This customer is already provisioned — no setup link needed.' });
  }
  if (lead.status !== 'approved') {
    return res.status(400).json({ error: `Lead is "${lead.status}". Approve it first to send a setup link.` });
  }

  // Guard: don't hand out a link if the subdomain was taken by an active customer.
  const { data: existing } = await supabase
    .from('customers')
    .select('id')
    .eq('subdomain', lead.subdomain)
    .maybeSingle();

  if (existing) {
    return res.status(409).json({ error: `Subdomain "${lead.subdomain}" is already in use by an active customer.` });
  }

  // Regenerate the token, clear the completion flag, and reset the TTL clock.
  // (TTL is measured from created_at; resetting it gives a fresh 72h window.)
  const token  = randomUUID();
  const appUrl = process.env.APP_URL ?? 'https://app.treesnap.cloud';

  const { error: updateErr } = await supabase
    .from('leads')
    .update({
      onboarding_token:        token,
      onboarding_completed_at: null,
      created_at:              new Date().toISOString(),
    })
    .eq('id', leadId);

  if (updateErr) return res.status(500).json({ error: updateErr.message });

  await sendOnboardingApprovalEmail(lead, `${appUrl}/onboard?token=${token}`);

  return res.status(200).json({ success: true });
}
