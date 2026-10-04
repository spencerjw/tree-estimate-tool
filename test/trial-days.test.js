import assert from 'node:assert/strict';
import test from 'node:test';
import { trialDaysForCheckout, subscriptionHasCard, DEFAULT_TRIAL_DAYS } from '../lib/stripe.js';

function fakeStripe({ codes = {}, coupons = {}, sessions = {}, customers = {} } = {}) {
  const get = (map, id) => {
    if (!(id in map)) throw new Error(`no such object: ${id}`);
    return map[id];
  };
  return {
    promotionCodes: { retrieve: async (id) => get(codes, id) },
    coupons:        { retrieve: async (id) => get(coupons, id) },
    checkout:       { sessions: { retrieve: async (id) => get(sessions, id) } },
    customers:      { retrieve: async (id) => get(customers, id) },
  };
}

test('no discount gives the default trial', async () => {
  assert.equal(await trialDaysForCheckout(fakeStripe(), { id: 'cs_1', discounts: [] }), DEFAULT_TRIAL_DAYS);
  assert.equal(DEFAULT_TRIAL_DAYS, 14);
});

test('promotion code metadata sets the trial', async () => {
  const stripe = fakeStripe({ codes: { promo_b: { metadata: { trial_days: '30' } } } });
  const session = { id: 'cs_1', discounts: [{ coupon: 'c1', promotion_code: 'promo_b' }] };
  assert.equal(await trialDaysForCheckout(stripe, session), 30);
});

test('coupon metadata is the fallback', async () => {
  const stripe = fakeStripe({
    codes: { promo_x: { metadata: {} } },
    coupons: { c1: { metadata: { trial_days: '30' } } },
  });
  assert.equal(await trialDaysForCheckout(stripe, { id: 'cs_1', discounts: [{ coupon: 'c1', promotion_code: 'promo_x' }] }), 30);
});

test('FREETEST-style code with no trial_days keeps 14', async () => {
  const stripe = fakeStripe({ codes: { promo_f: { metadata: { source: 'founder-test' } } }, coupons: { c2: { metadata: {} } } });
  assert.equal(await trialDaysForCheckout(stripe, { id: 'cs_1', discounts: [{ coupon: 'c2', promotion_code: 'promo_f' }] }), 14);
});

test('out-of-range or junk trial_days is ignored', async () => {
  for (const v of ['0', '91', '30.5', 'thirty', '']) {
    const stripe = fakeStripe({ codes: { p: { metadata: { trial_days: v } } }, coupons: { c: { metadata: {} } } });
    assert.equal(await trialDaysForCheckout(stripe, { id: 'cs', discounts: [{ coupon: 'c', promotion_code: 'p' }] }), 14, v);
  }
});

test('session without discounts field is re-fetched', async () => {
  const stripe = fakeStripe({
    sessions: { cs_9: { id: 'cs_9', discounts: [{ promotion_code: 'p' }] } },
    codes: { p: { metadata: { trial_days: '30' } } },
  });
  assert.equal(await trialDaysForCheckout(stripe, { id: 'cs_9' }), 30);
});

test('Stripe lookup failure falls back to 14', async () => {
  assert.equal(await trialDaysForCheckout(fakeStripe(), { id: 'cs_1', discounts: [{ promotion_code: 'missing' }] }), 14);
  assert.equal(await trialDaysForCheckout(fakeStripe(), { id: 'gone' }), 14);
});

test('subscriptionHasCard', async () => {
  const stripe = fakeStripe({
    customers: {
      cus_card: { invoice_settings: { default_payment_method: 'pm_1' } },
      cus_none: { invoice_settings: { default_payment_method: null } },
      cus_del:  { deleted: true },
    },
  });
  assert.equal(await subscriptionHasCard(stripe, { default_payment_method: 'pm_x', customer: 'cus_none' }), true);
  assert.equal(await subscriptionHasCard(stripe, { default_payment_method: null, customer: 'cus_card' }), true);
  assert.equal(await subscriptionHasCard(stripe, { default_payment_method: null, customer: 'cus_none' }), false);
  assert.equal(await subscriptionHasCard(stripe, { default_payment_method: null, customer: 'cus_del' }), false);
  assert.equal(await subscriptionHasCard(stripe, { default_payment_method: null, customer: 'cus_unknown' }), true);
});
