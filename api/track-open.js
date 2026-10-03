// Public email-open pixel for cold outreach.
//
// This Vercel project is the demo host (demo.treesnap.cloud). The public URL is:
//   https://demo.treesnap.cloud/t/o.gif?c=wave19&s=anjoe
//
// c = campaign, s = shop slug. The recipient email is never read, logged, or sent
// to analytics — extra query keys are ignored. Each GET is one open: a line in the
// function log (`EMAIL_OPEN {...}`) and, when a shop slug is present, a non-blocking
// GA4 `email_open` event on property TreeSnap (G-VYB6HSZS5M).

import { createHash, randomUUID } from 'node:crypto';

export const GA_MEASUREMENT_ID = 'G-VYB6HSZS5M';

// 1x1 transparent GIF. Email clients must receive real image bytes, not a redirect.
export const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

const TOKEN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function sanitizeToken(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toLowerCase();
  return TOKEN.test(cleaned) ? cleaned : null;
}

function queryValue(req, key) {
  const raw = req.query?.[key];
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : null;
  if (typeof raw === 'string') return raw;
  try {
    return new URL(req.url || '/', 'https://demo.treesnap.cloud').searchParams.get(key);
  } catch {
    return null;
  }
}

export function recordEmailOpen({ campaign, shop }) {
  const entry = {
    event: 'email_open',
    id: randomUUID(),
    campaign,
    shop,
    at: new Date().toISOString(),
  };
  // One line per hit. Search function logs for EMAIL_OPEN.
  console.log(`EMAIL_OPEN ${JSON.stringify(entry)}`);
  return entry;
}

function clientIdForShop(shop) {
  const hex = createHash('sha256').update(`treesnap-email-open:${shop}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Best-effort GA4 collect, same measurement id the demo pages use via gtag.
// Never throws, and the caller must not await it before ending the image response.
// On Vercel, waitUntil keeps the invocation alive after the GIF is sent.
export function sendEmailOpenEvent({ campaign, shop }) {
  try {
    const params = new URLSearchParams({
      v: '2',
      tid: GA_MEASUREMENT_ID,
      cid: clientIdForShop(shop),
      en: 'email_open',
      _s: '1',
      dl: 'https://demo.treesnap.cloud/t/o.gif',
      'ep.campaign': campaign ?? '',
      'ep.shop_slug': shop,
    });
    const pending = fetch(`https://www.google-analytics.com/g/collect?${params}`, {
      method: 'POST',
      redirect: 'manual',
    }).then((res) => {
      if (res.status >= 400) console.error('EMAIL_OPEN_ANALYTICS', res.status);
    }).catch((err) => {
      console.error('EMAIL_OPEN_ANALYTICS', err?.message ?? err);
    });
    const ctx = globalThis[Symbol.for('@vercel/request-context')]?.get?.() ?? {};
    if (typeof ctx.waitUntil === 'function') ctx.waitUntil(pending);
    return pending;
  } catch (err) {
    console.error('EMAIL_OPEN_ANALYTICS', err?.message ?? err);
    return Promise.resolve();
  }
}

const PIXEL_HEADERS = {
  'Content-Type': 'image/gif',
  'Content-Length': String(PIXEL_GIF.length),
  'Cache-Control': 'no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'Pragma': 'no-cache',
  'Expires': '0',
  'X-Content-Type-Options': 'nosniff',
};

export default function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      Allow: 'GET, HEAD',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end('Method not allowed');
    return;
  }

  if (req.method === 'GET') {
    const campaign = sanitizeToken(queryValue(req, 'c'));
    const shop = sanitizeToken(queryValue(req, 's'));
    recordEmailOpen({ campaign, shop });
    // Shop slug is the unit of counting. Skip GA when it is missing so a bare
    // probe does not look like an open. The log line above still records the hit.
    if (shop) sendEmailOpenEvent({ campaign, shop });
  }

  res.writeHead(200, PIXEL_HEADERS);
  res.end(req.method === 'HEAD' ? undefined : PIXEL_GIF);
}
