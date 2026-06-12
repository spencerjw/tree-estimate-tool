// Fixed-window rate limiter backed by the rate_limits table + check_rate_limit RPC
// (supabase/migrations/008_rate_limits.sql). Used by the unauthenticated public
// endpoints to throttle abuse per client IP.
//
// FAILS OPEN: if the limiter errors (migration not yet applied, DB hiccup), the
// request is allowed rather than blocking a legitimate user. The cost of a missed
// limit is bounded by the downstream caps (tier limits, etc.); the cost of a false
// block is a lost lead. The RPC is atomic, so concurrent requests count correctly.

import { supabase } from './supabase.js';

export async function rateLimit({ bucket, identifier, windowSeconds, max }) {
  if (!identifier) return { allowed: true, unknown: true };
  try {
    const { data, error } = await supabase.rpc('check_rate_limit', {
      p_bucket:         bucket,
      p_identifier:     identifier,
      p_window_seconds: windowSeconds,
      p_max:            max,
    });
    if (error) {
      console.error(`rateLimit(${bucket}) RPC error — failing open:`, error.message);
      return { allowed: true, error: true };
    }
    return data ?? { allowed: true };
  } catch (e) {
    console.error(`rateLimit(${bucket}) threw — failing open:`, e?.message ?? e);
    return { allowed: true, error: true };
  }
}

// Best-effort client IP from Vercel's proxy headers (x-forwarded-for is a
// comma-separated list, client first).
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
}
