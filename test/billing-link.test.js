import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
const { billingLinkUrl, verifyBillingLink, LINK_TTL_DAYS } = await import('../lib/billing-link.js');

const params = (url) => Object.fromEntries(new URL(url).searchParams);

test('a fresh link verifies to its customer', () => {
  const url = billingLinkUrl('cust-123', { appUrl: 'https://app.treesnap.cloud' });
  assert.ok(url.startsWith('https://app.treesnap.cloud/api/billing?'));
  assert.equal(verifyBillingLink(params(url)), 'cust-123');
});

test('tampered customer id or expiry fails', () => {
  const p = params(billingLinkUrl('cust-123'));
  assert.equal(verifyBillingLink({ ...p, c: 'cust-999' }), null);
  assert.equal(verifyBillingLink({ ...p, e: String(Number(p.e) + 86400) }), null);
  assert.equal(verifyBillingLink({ ...p, s: p.s.slice(0, -1) + (p.s.endsWith('A') ? 'B' : 'A') }), null);
});

test('expired link fails', () => {
  const issued = Date.now() - (LINK_TTL_DAYS + 1) * 86400000;
  const p = params(billingLinkUrl('cust-123', { now: issued }));
  assert.equal(verifyBillingLink(p), null);
});

test('missing params fail', () => {
  assert.equal(verifyBillingLink({}), null);
  assert.equal(verifyBillingLink(), null);
});
