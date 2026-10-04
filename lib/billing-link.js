// Signed, expiring links that open a customer's Stripe billing portal.
//
// Tree pros have no login, so the link itself is the credential: HMAC over the
// customer id + expiry. It goes only to the owner email on file (trial-ending,
// paused, and on-request emails) and is never shown on the public shop page.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const LINK_TTL_DAYS = 14;

function signingKey() {
  // BILLING_LINK_SECRET if set; otherwise derived from the service-role key (a
  // server-only secret that already exists) with a fixed label, so no new env var
  // is required to ship. Rotating either secret invalidates outstanding links.
  const base = process.env.BILLING_LINK_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base) throw new Error('No signing secret for billing links');
  return createHmac('sha256', base).update('treesnap-billing-link-v1').digest();
}

function mac(customerId, exp) {
  return createHmac('sha256', signingKey()).update(`${customerId}.${exp}`).digest('base64url');
}

export function billingLinkUrl(customerId, { now = Date.now(), appUrl = process.env.APP_URL ?? 'https://app.treesnap.cloud' } = {}) {
  const exp = Math.floor(now / 1000) + LINK_TTL_DAYS * 86400;
  const q = new URLSearchParams({ c: customerId, e: String(exp), s: mac(customerId, exp) });
  return `${appUrl}/api/billing?${q}`;
}

// Returns the customer id when the link is genuine and unexpired, else null.
export function verifyBillingLink({ c, e, s } = {}, now = Date.now()) {
  if (typeof c !== 'string' || typeof e !== 'string' || typeof s !== 'string') return null;
  const exp = Number(e);
  if (!Number.isInteger(exp) || exp * 1000 < now) return null;
  const want = Buffer.from(mac(c, exp));
  const got = Buffer.from(s);
  return want.length === got.length && timingSafeEqual(want, got) ? c : null;
}
