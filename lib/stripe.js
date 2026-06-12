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
