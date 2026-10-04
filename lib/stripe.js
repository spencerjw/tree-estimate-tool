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

// Trial length for a signup checkout. A promotion code (or its coupon) carrying
// metadata trial_days overrides the default, e.g. the beta-tester code: setup fee
// 100% off + 30-day trial. Any lookup failure falls back to the default trial.
export async function trialDaysForCheckout(stripe, session) {
  let s = session;
  if (!Array.isArray(s?.discounts)) {
    try {
      s = await stripe.checkout.sessions.retrieve(session.id);
    } catch (e) {
      console.error('trialDaysForCheckout: session retrieve failed:', e.message);
      return DEFAULT_TRIAL_DAYS;
    }
  }
  for (const d of s.discounts ?? []) {
    try {
      const pc = typeof d.promotion_code === 'string'
        ? await stripe.promotionCodes.retrieve(d.promotion_code)
        : d.promotion_code;
      const fromCode = parseTrialDays(pc?.metadata?.trial_days);
      if (fromCode) return fromCode;

      const couponRef = d.coupon ?? pc?.coupon ?? pc?.promotion?.coupon;
      const coupon = typeof couponRef === 'string'
        ? await stripe.coupons.retrieve(couponRef)
        : couponRef;
      const fromCoupon = parseTrialDays(coupon?.metadata?.trial_days);
      if (fromCoupon) return fromCoupon;
    } catch (e) {
      console.error('trialDaysForCheckout: discount lookup failed:', e.message);
    }
  }
  return DEFAULT_TRIAL_DAYS;
}

// Whether trial end can charge a card off-session. A 100%-off setup checkout
// collects no card, so those subscriptions have none. If Stripe can't be read,
// answer true so the customer keeps the standard "you'll be charged" wording.
export async function subscriptionHasCard(stripe, sub) {
  if (sub?.default_payment_method) return true;
  try {
    const id = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    const c = await stripe.customers.retrieve(id);
    return !c.deleted && !!c.invoice_settings?.default_payment_method;
  } catch {
    return true;
  }
}
