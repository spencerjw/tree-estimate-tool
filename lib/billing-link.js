// Signed, expiring links for tree pros, who have no login: the link itself is
// the credential (HMAC over purpose + customer id + expiry). They go only to the
// owner email on file and are never shown on the public shop page.
//
//   billing  -> /api/billing   (Stripe portal; trial-ending, paused, on-request emails)
//   settings -> /api/settings  (rates and colors form; welcome email)
//
// Each purpose has its own key, so a billing link can't open settings and vice versa.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const LINK_TTL_DAYS = 14;          // billing
export const SETTINGS_TTL_DAYS = 365;     // "change your rates or colors any time"

const LABELS = { billing: 'treesnap-billing-link-v1', settings: 'treesnap-settings-link-v1' };
const PATHS = { billing: '/api/billing', settings: '/api/settings' };

function signingKey(purpose) {
  // BILLING_LINK_SECRET if set; otherwise derived from the service-role key (a
  // server-only secret that already exists) with a fixed per-purpose label, so no
  // new env var is required. Rotating either secret invalidates outstanding links.
  const base = process.env.BILLING_LINK_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base) throw new Error('No signing secret for customer links');
  return createHmac('sha256', base).update(LABELS[purpose]).digest();
}

function mac(purpose, customerId, exp) {
  return createHmac('sha256', signingKey(purpose)).update(`${customerId}.${exp}`).digest('base64url');
}

function linkUrl(purpose, ttlDays, customerId, { now = Date.now(), appUrl = process.env.APP_URL ?? 'https://app.treesnap.cloud' } = {}) {
  const exp = Math.floor(now / 1000) + ttlDays * 86400;
  const q = new URLSearchParams({ c: customerId, e: String(exp), s: mac(purpose, customerId, exp) });
  return `${appUrl}${PATHS[purpose]}?${q}`;
}

// Returns the customer id when the link is genuine and unexpired, else null.
function verify(purpose, { c, e, s } = {}, now = Date.now()) {
  if (typeof c !== 'string' || typeof e !== 'string' || typeof s !== 'string') return null;
  const exp = Number(e);
  if (!Number.isInteger(exp) || exp * 1000 < now) return null;
  const want = Buffer.from(mac(purpose, c, exp));
  const got = Buffer.from(s);
  return want.length === got.length && timingSafeEqual(want, got) ? c : null;
}

export const billingLinkUrl = (customerId, opts) => linkUrl('billing', LINK_TTL_DAYS, customerId, opts);
export const verifyBillingLink = (params, now) => verify('billing', params, now);
export const settingsLinkUrl = (customerId, opts) => linkUrl('settings', SETTINGS_TTL_DAYS, customerId, opts);
export const verifySettingsLink = (params, now) => verify('settings', params, now);
