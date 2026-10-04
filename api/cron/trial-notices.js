// Vercel cron job — internal trial notice, 5 days out.
//
// Once per trialing subscription, when its trial ends within 5 days, email
// projects@ (never the shop) with the shop slug and how many real estimates it
// has run. Stripe has no event 5 days out (trial_will_end fires ~3 days out),
// so this runs daily and catches each trial the first morning it is 5 days out
// to the nearest day; a missed run sends the next day instead of skipping.
//
// Deduped per subscription via email_log (email_type 'internal_trial_5d:<sub id>'),
// so an admin extension (which creates a new subscription) gets its own notice.
// Schedule: daily 14:00 UTC (see vercel.json). Requires CRON_SECRET.

import { supabase } from '../../lib/supabase.js';
import { sendInternalTrialNotice, INTERNAL_NOTICE_TO } from '../../lib/emails.js';

export const config = { maxDuration: 30 };

export const NOTICE_DAYS = 5;
export const noticeType = subId => `internal_trial_5d:${subId}`;

// Which trialing shops are due: trial ends in 5 days or less (to the nearest
// day) and has not ended, and no notice yet for this subscription.
export function dueForNotice(customers, sentTypes, now = Date.now()) {
  return (customers ?? []).filter(c => {
    if (c?.status !== 'trialing' || !c.trial_end || !c.stripe_subscription_id) return false;
    const ms = new Date(c.trial_end).getTime() - now;
    // A daily run can't hit exactly 5.0 days; send on the run where the trial is
    // 5 days out to the nearest day, so the subject's "5 days" holds.
    return ms > 0 && Math.round(ms / 86400000) <= NOTICE_DAYS && !sentTypes.has(noticeType(c.stripe_subscription_id));
  });
}

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: customers, error } = await supabase
    .from('customers')
    .select('id, subdomain, business_name, company_name, email, tier, status, trial_end, stripe_subscription_id')
    .eq('status', 'trialing');
  if (error) return res.status(500).json({ error: error.message });

  const { data: logs, error: logErr } = await supabase
    .from('email_log')
    .select('email_type')
    .like('email_type', 'internal_trial_5d:%');
  if (logErr) return res.status(500).json({ error: logErr.message });
  const sent = new Set((logs ?? []).map(l => l.email_type));

  const results = [];
  for (const c of dueForNotice(customers, sent)) {
    try {
      const { count, error: countErr } = await supabase
        .from('estimates')
        .select('id', { count: 'exact', head: true })
        .eq('customer_id', c.id)
        .or('is_demo.is.null,is_demo.eq.false');
      if (countErr) throw new Error(countErr.message);

      await sendInternalTrialNotice(c, { estimateCount: count ?? 0 });
      await supabase.from('email_log').insert({
        customer_id: c.id,
        email_type:  noticeType(c.stripe_subscription_id),
        recipient:   INTERNAL_NOTICE_TO,
      });
      results.push({ shop: c.subdomain, sent: true, estimates: count ?? 0 });
    } catch (e) {
      console.error('Trial notice failed for', c.subdomain, e.message);
      results.push({ shop: c.subdomain, sent: false, error: e.message });
    }
  }

  return res.status(200).json({ trialing: customers?.length ?? 0, notices: results });
}
