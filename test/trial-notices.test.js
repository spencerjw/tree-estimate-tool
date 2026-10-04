import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SUPABASE_URL ??= 'http://fake.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'x';
const { dueForNotice, noticeType, NOTICE_DAYS } = await import('../api/cron/trial-notices.js');

const DAY = 86400000;
const now = Date.parse('2026-10-29T14:00:00Z');
const shop = (id, daysOut, extra = {}) => ({
  id, subdomain: id, status: 'trialing', stripe_subscription_id: `sub_${id}`,
  trial_end: new Date(now + daysOut * DAY).toISOString(), ...extra,
});

test('due when the trial ends within 5 days and has not ended', () => {
  const due = dueForNotice([shop('a', 5), shop('b', 4.9), shop('c', 0.5), shop('d', 5.16), shop('e', -0.1), shop('f', 5.6)], new Set(), now);
  assert.deepEqual(due.map(c => c.id), ['a', 'b', 'c', 'd']);
  assert.equal(NOTICE_DAYS, 5);
});

test('once per subscription: a sent notice is not repeated; a new subscription gets its own', () => {
  const sent = new Set([noticeType('sub_a')]);
  assert.deepEqual(dueForNotice([shop('a', 3)], sent, now), []);
  assert.deepEqual(dueForNotice([shop('a', 3, { stripe_subscription_id: 'sub_a2' })], sent, now).length, 1);
});

test('only trialing shops with a subscription', () => {
  const due = dueForNotice([shop('p', 3, { status: 'paused' }), shop('x', 3, { stripe_subscription_id: null }), shop('t', 3)], new Set(), now);
  assert.deepEqual(due.map(c => c.id), ['t']);
});
