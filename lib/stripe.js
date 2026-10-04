import Stripe from 'stripe';

// Pin the Stripe API version so the SDK's API calls return a deterministic
// response shape regardless of the Stripe account's dashboard default. This is a
// pre-Basil version in which subscription-level current_period_start/end and
// invoice.subscription still exist — the shapes the code reads.
//
// NOTE: webhook EVENT payloads are versioned by the webhook endpoint's dashboard
// setting, NOT by this pin, so stripe-webhook.js additionally reads those fields
// defensively (subPeriodStart/End, invoiceSubscriptionId) to work under either the
// pre-Basil or Basil shape. Bump this only alongside that code.
export const STRIPE_API_VERSION = '2024-06-20';

export function getStripe(key = process.env.STRIPE_SECRET_KEY) {
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION });
}

export const DEFAULT_TRIAL_DAYS = 14;
const MAX_TRIAL_DAYS = 90;

function parseTrialDays(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_TRIAL_DAYS ? n : null;
}

const idOf = (ref) => (typeof ref === 'string' ? ref : ref?.id);

// A code or coupon deleted after checkout will 404 on every redelivery; skip it
// (default trial) instead of failing provisioning forever. Anything else throws.
async function retrieveOrSkip(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e?.code === 'resource_missing') {
      console.error('trialDaysForCheckout: discount object missing, using default trial:', e.message);
      return null;
    }
    throw e;
  }
}

// Trial length for a signup checkout. A promotion code (or its coupon) carrying
// metadata trial_days overrides the default, e.g. BETA30: setup fee 100% off +
// 30-day trial. Codes typed at Checkout (allow_promotion_codes) are read from the
// expanded discount breakdown, the shape Stripe documents for them.
//
// Transient Stripe errors are THROWN, not swallowed: the webhook then returns 500 and Stripe
// redelivers, instead of quietly provisioning a 14-day trial for someone promised 30.
export async function trialDaysForCheckout(stripe, session) {
  const full = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ['total_details.breakdown'],
  });

  const promoIds = new Set();
  const couponIds = new Set();
  for (const b of full.total_details?.breakdown?.discounts ?? []) {
    if (b.discount?.promotion_code) promoIds.add(idOf(b.discount.promotion_code));
    if (b.discount?.coupon) couponIds.add(idOf(b.discount.coupon));
  }
  for (const d of full.discounts ?? []) {
    if (d.promotion_code) promoIds.add(idOf(d.promotion_code));
    if (d.coupon) couponIds.add(idOf(d.coupon));
  }

  for (const id of promoIds) {
    const pc = await retrieveOrSkip(() => stripe.promotionCodes.retrieve(id));
    if (!pc) continue;
    const days = parseTrialDays(pc.metadata?.trial_days);
    if (days) return days;
    const c = idOf(pc.coupon ?? pc.promotion?.coupon);
    if (c) couponIds.add(c);
  }
  for (const id of couponIds) {
    const coupon = await retrieveOrSkip(() => stripe.coupons.retrieve(id));
    if (!coupon) continue;
    const days = parseTrialDays(coupon.metadata?.trial_days);
    if (days) return days;
  }
  return DEFAULT_TRIAL_DAYS;
}

// Whether the subscription can be charged off-session: a card on the subscription
// or as the customer's default. Throws on a Stripe error so the caller can retry
// rather than guess. Used for the trial-ending copy and the billing-portal return.
export async function hasCardOnFile(stripe, subOrCustomerId) {
  if (typeof subOrCustomerId !== 'string' && subOrCustomerId?.default_payment_method) return true;
  const customerId = typeof subOrCustomerId === 'string' ? subOrCustomerId : idOf(subOrCustomerId.customer);
  const c = await stripe.customers.retrieve(customerId);
  return !c.deleted && !!(c.invoice_settings?.default_payment_method || c.default_source);
}
