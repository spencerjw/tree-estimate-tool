// Vercel cron job — daily data hygiene:
//   1. Purge uploaded photos from storage for estimates older than 14 days
//   2. Delete demo estimate rows older than 24 hours
//   3. Delete lead/estimate data for tenants canceled 90+ days ago (per Privacy Policy)
// Schedule: daily at 6am UTC (see vercel.json)
// Requires env var: CRON_SECRET (random 32-char string, set in Vercel dashboard)

import { supabase } from '../../lib/supabase.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cutoff14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const cutoff24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const cutoff90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  // 1. Delete photos from storage for estimates older than 14 days
  const { data: oldEstimates } = await supabase
    .from('estimates')
    .select('id, photo_paths')
    .lt('created_at', cutoff14)
    .not('photo_paths', 'is', null);

  let photosDeleted = 0;
  if (oldEstimates?.length) {
    const allPaths = oldEstimates.flatMap(e => e.photo_paths || []);
    if (allPaths.length > 0) {
      const { error } = await supabase.storage.from('estimate-photos').remove(allPaths);
      if (error) {
        console.error('Storage cleanup error:', error.message);
      } else {
        photosDeleted = allPaths.length;
      }
    }

    // Null out photo_paths on rows so we don't try to delete them again
    await supabase
      .from('estimates')
      .update({ photo_paths: null })
      .lt('created_at', cutoff14)
      .not('photo_paths', 'is', null);
  }

  // 2. Delete demo estimate rows older than 24 hours
  const { data: deletedDemo } = await supabase
    .from('estimates')
    .delete()
    .eq('is_demo', true)
    .lt('created_at', cutoff24)
    .select('id');

  const demoDeleted = deletedDemo?.length ?? 0;

  // 3. Purge lead/estimate data for tenants canceled 90+ days ago.
  //    Per the Privacy Policy, a canceled tenant's estimate history and lead data
  //    are retained for up to 90 days, then deleted. (Uploaded photos are already
  //    gone by then via the 14-day sweep above; we still clear any stragglers.)
  //    The customer/billing row is intentionally left in place — billing records
  //    are retained separately for tax/accounting compliance.
  let canceledEstimatesDeleted = 0;
  const { data: staleCanceled } = await supabase
    .from('customers')
    .select('id')
    .eq('status', 'canceled')
    .not('canceled_at', 'is', null)
    .lt('canceled_at', cutoff90);

  if (staleCanceled?.length) {
    const customerIds = staleCanceled.map(c => c.id);

    // Clear any lingering photos for these tenants' estimates first.
    const { data: leftoverPhotos } = await supabase
      .from('estimates')
      .select('photo_paths')
      .in('customer_id', customerIds)
      .not('photo_paths', 'is', null);

    const stragglerPaths = (leftoverPhotos || []).flatMap(e => e.photo_paths || []);
    if (stragglerPaths.length > 0) {
      const { error } = await supabase.storage.from('estimate-photos').remove(stragglerPaths);
      if (error) console.error('Canceled-tenant photo cleanup error:', error.message);
    }

    // Delete the estimate rows (homeowner PII + lead history).
    const { data: deletedCanceled } = await supabase
      .from('estimates')
      .delete()
      .in('customer_id', customerIds)
      .select('id');

    canceledEstimatesDeleted = deletedCanceled?.length ?? 0;
  }

  console.log(`Cleanup: ${photosDeleted} photos deleted from storage, ${demoDeleted} demo estimates removed, ${canceledEstimatesDeleted} estimates purged for canceled tenants`);
  return res.status(200).json({ photosDeleted, demoDeleted, canceledEstimatesDeleted });
}
