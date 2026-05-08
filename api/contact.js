// Public endpoint — captures new business lead from the signup form.
// Validates subdomain availability, inserts into leads table, sends emails.

import { supabase } from '../lib/supabase.js';
import { sendLeadAcknowledgmentEmail, sendLeadNotificationToAdmin } from '../lib/emails.js';

const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, phone, company, subdomain, tier, zip } = req.body ?? {};

  if (!name || !email || !phone || !company || !subdomain || !tier) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const cleanSub = subdomain.toLowerCase().trim();
  if (!SUBDOMAIN_RE.test(cleanSub)) {
    return res.status(400).json({
      error: 'Subdomain must be 3–30 lowercase letters, numbers, or hyphens and cannot start or end with a hyphen.',
    });
  }

  if (!['starter', 'pro', 'proplus'].includes(tier)) {
    return res.status(400).json({ error: 'Invalid tier.' });
  }

  // Check for subdomain collision with existing customers
  const { data: existingCustomer } = await supabase
    .from('customers')
    .select('id')
    .eq('subdomain', cleanSub)
    .maybeSingle();

  if (existingCustomer) {
    return res.status(409).json({ error: 'That subdomain is already taken. Please choose another.' });
  }

  // Check for subdomain collision with pending/approved leads
  const { data: existingLead } = await supabase
    .from('leads')
    .select('id')
    .eq('subdomain', cleanSub)
    .not('status', 'eq', 'rejected')
    .maybeSingle();

  if (existingLead) {
    return res.status(409).json({ error: 'That subdomain has already been requested. Please choose another.' });
  }

  const { data: lead, error } = await supabase
    .from('leads')
    .insert({
      name,
      email,
      phone,
      company,
      subdomain: cleanSub,
      tier,
      zip:    zip || null,
      status: 'pending',
    })
    .select()
    .single();

  if (error) {
    console.error('Lead insert error:', error);
    return res.status(500).json({ error: 'Failed to submit application. Please try again.' });
  }

  if (process.env.RESEND_API_KEY) {
    await Promise.all([
      sendLeadAcknowledgmentEmail(lead),
      sendLeadNotificationToAdmin(lead),
    ]);
  }

  return res.status(200).json({ success: true });
}
