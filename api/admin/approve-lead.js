// Admin action — approve a pending lead and send them an onboarding link.
// Stripe checkout happens at the END of onboarding, not here.
// POST /api/admin/approve-lead  { password, leadId }

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
  if (lead.status !== 'pending') {
    return res.status(400).json({ error: `Lead is already ${lead.status}` });
  }

  // Check subdomain not already taken by an active customer
  const { data: existing } = await supabase
    .from('customers')
    .select('id')
    .eq('subdomain', lead.subdomain)
    .maybeSingle();

  if (existing) {
    return res.status(409).json({ error: `Subdomain "${lead.subdomain}" is already in use by an active customer.` });
  }

  const token = randomUUID();
  const appUrl = process.env.APP_URL ?? 'https://app.treesnap.cloud';

  const { error: updateErr } = await supabase
    .from('leads')
    .update({ status: 'approved', onboarding_token: token })
    .eq('id', leadId);

  if (updateErr) {
    return res.status(500).json({ error: updateErr.message });
  }

  await sendOnboardingApprovalEmail(lead, `${appUrl}/onboard?token=${token}`);

  return res.status(200).json({ success: true });
}
