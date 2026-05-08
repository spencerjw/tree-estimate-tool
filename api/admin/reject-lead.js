// Admin action — reject a pending lead and notify them.
// POST /api/admin/reject-lead  { password, leadId, reason? }

import { supabase } from '../../lib/supabase.js';
import { sendRejectionEmail } from '../../lib/emails.js';

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

  const { leadId, reason } = req.body ?? {};
  if (!leadId) return res.status(400).json({ error: 'Missing leadId' });

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single();

  if (leadErr || !lead) return res.status(404).json({ error: 'Lead not found' });

  await supabase
    .from('leads')
    .update({ status: 'rejected', notes: reason || null })
    .eq('id', leadId);

  await sendRejectionEmail(lead, reason || null);

  return res.status(200).json({ success: true });
}
