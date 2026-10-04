import assert from 'node:assert/strict';
import test from 'node:test';
import { trialDaysForCheckout, hasCardOnFile, DEFAULT_TRIAL_DAYS } from '../lib/stripe.js';

// sessions: id -> session as returned by retrieve(id, { expand: ['total_details.breakdown'] })
function fakeStripe({ codes = {}, coupons = {}, sessions = {}, customers = {} } = {}) {
  const get = (map, id) => {
    if (!(id in map)) throw new Error(`No such object: ${id}`);
    return map[id];
  };
  return {
    promotionCodes: { retrieve: async (id) => get(codes, id) },
    coupons:        { retrieve: async (id) => get(coupons, id) },
    checkout:       { sessions: { retrieve: async (id, opts) => {
      assert.deepEqual(opts?.expand, ['total_details.breakdown']);
      return get(sessions, id);
    } } },
    customers:      { retrieve: async (id) => get(customers, id) },
  };
}

const viaBreakdown = (promo, coupon) => ({
  id: 'cs_1',
  discounts: null,
  total_details: { breakdown: { discounts: [{ amount: 29900, discount: { promotion_code: promo, coupon } }] } },
});

test('no discount gives the default 14-day trial', async () => {
  const stripe = fakeStripe({ sessions: { cs_1: { id: 'cs_1', discounts: [], total_details: { breakdown: { discounts: [] } } } } });
  assert.equal(await trialDaysForCheckout(stripe, { id: 'cs_1' }), DEFAULT_TRIAL_DAYS);
  assert.equal(DEFAULT_TRIAL_DAYS, 14);
});

test('BETA30 typed at Checkout is read from the breakdown', async () => {
  const stripe = fakeStripe({
    sessions: { cs_1: viaBreakdown('promo_b', { id: 'c1', metadata: {} }) },
    codes: { promo_b: { metadata: { trial_days: '30' } } },
  });
  assert.equal(await trialDaysForCheckout(stripe, { id: 'cs_1' }), 30);
});

test('session.discounts also works', async () => {
  const stripe = fakeStripe({
    sessions: { cs_1: { id: 'cs_1', discounts: [{ coupon: 'c1', promotion_code: 'promo_b' }] } },
    codes: { promo_b: { metadata: { trial_days: '30' } } },
  });
  assert.equal(await trialDaysForCheckout(stripe, { id: 'cs_1' }), 30);
});

test('coupon metadata is the fallback', async () => {
  const stripe = fakeStripe({
    sessions: { cs_1: viaBreakdown('promo_x', 'c1') },
    codes: { promo_x: { metadata: {}, coupon: { id: 'c1' } } },
    coupons: { c1: { metadata: { trial_days: '30' } } },
  });
  assert.equal(await trialDaysForCheckout(stripe, { id: 'cs_1' }), 30);
});

test('FREETEST-style code with no trial_days keeps 14', async () => {
  const stripe = fakeStripe({
    sessions: { cs_1: viaBreakdown('promo_f', 'c2') },
    codes: { promo_f: { metadata: {}, coupon: 'c2' } },
    coupons: { c2: { metadata: {} } },
  });
  assert.equal(await trialDaysForCheckout(stripe, { id: 'cs_1' }), 14);
});

test('out-of-range or junk trial_days is ignored', async () => {
  for (const v of ['0', '91', '30.5', 'thirty', '']) {
    const stripe = fakeStripe({
      sessions: { cs_1: viaBreakdown('p', 'c') },
      codes: { p: { metadata: { trial_days: v } } },
      coupons: { c: { metadata: {} } },
    });
    assert.equal(await trialDaysForCheckout(stripe, { id: 'cs_1' }), 14, v);
  }
});

test('a Stripe lookup failure throws so the webhook is retried', async () => {
  const missingCode = fakeStripe({ sessions: { cs_1: viaBreakdown('missing', 'c') } });
  await assert.rejects(trialDaysForCheckout(missingCode, { id: 'cs_1' }));
  await assert.rejects(trialDaysForCheckout(fakeStripe(), { id: 'gone' }));
});

test('a code deleted after checkout (resource_missing) falls back to 14', async () => {
  const stripe = fakeStripe({ sessions: { cs_1: viaBreakdown('promo_gone', null) } });
  stripe.promotionCodes.retrieve = async () => {
    throw Object.assign(new Error('No such promotion code'), { code: 'resource_missing' });
  };
  assert.equal(await trialDaysForCheckout(stripe, { id: 'cs_1' }), 14);
});

test('hasCardOnFile', async () => {
  const stripe = fakeStripe({
    customers: {
      cus_card:   { invoice_settings: { default_payment_method: 'pm_1' } },
      cus_source: { invoice_settings: {}, default_source: 'card_1' },
      cus_none:   { invoice_settings: { default_payment_method: null } },
      cus_del:    { deleted: true },
    },
  });
  assert.equal(await hasCardOnFile(stripe, { default_payment_method: 'pm', customer: 'cus_none' }), true);
  assert.equal(await hasCardOnFile(stripe, { customer: 'cus_card' }), true);
  assert.equal(await hasCardOnFile(stripe, { customer: 'cus_source' }), true);
  assert.equal(await hasCardOnFile(stripe, { customer: 'cus_none' }), false);
  assert.equal(await hasCardOnFile(stripe, { customer: 'cus_del' }), false);
  assert.equal(await hasCardOnFile(stripe, 'cus_card'), true);
  await assert.rejects(hasCardOnFile(stripe, { customer: 'cus_unknown' }));
});
