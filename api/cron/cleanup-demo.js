// Vercel cron job — deletes demo estimates older than 24 hours.
// Schedule: daily at 6am UTC (see vercel.json)
// Requires env var: CRON_SECRET (random 32-char string, set in Vercel dashboard)

import { supabase } from '../../lib/supabase.js';

export const config = {
  maxDuration: 10,
};

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('estimates')
    .delete()
    .eq('is_demo', true)
    .lt('created_at', cutoff)
    .select('id');

  if (error) {
    console.error('Demo cleanup failed:', error);
    return res.status(500).json({ error: error.message });
  }

  const count = data?.length ?? 0;
  console.log(`Demo cleanup: deleted ${count} demo estimates older than 24h`);
  return res.status(200).json({ deleted: count });
}
