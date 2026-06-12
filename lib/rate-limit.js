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

// Client IP for rate-limit keying. On Vercel, `x-real-ip` is set by the platform
// to the actual connecting IP and cannot be spoofed by the caller — use it first.
// `x-forwarded-for` is client-appendable (its LEFTMOST entry is attacker-supplied;
// Vercel appends the real IP last), so only fall back to its last hop, never the
// first — otherwise an attacker rotates a fake X-Forwarded-For per request to get
// a fresh bucket and evade every limit.
export function clientIp(req) {
  const realIp = req.headers['x-real-ip'];
  if (realIp) return String(realIp).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const hops = String(xff).split(',').map(s => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket?.remoteAddress || '';
}
