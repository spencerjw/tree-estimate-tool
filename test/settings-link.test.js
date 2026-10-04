import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role';
process.env.SUPABASE_URL ??= 'http://fake.invalid';
const links = await import('../lib/billing-link.js');
const { validateSettings, THEMES } = await import('../api/settings.js');

const params = url => Object.fromEntries(new URL(url).searchParams);

test('a settings link opens settings and nothing else', () => {
  const s = params(links.settingsLinkUrl('cust-1', { appUrl: 'https://app.treesnap.cloud' }));
  assert.equal(links.verifySettingsLink(s), 'cust-1');
  assert.equal(links.verifyBillingLink(s), null);
  const b = params(links.billingLinkUrl('cust-1'));
  assert.equal(links.verifyBillingLink(b), 'cust-1');
  assert.equal(links.verifySettingsLink(b), null);
});

test('settings links last a year, billing links 14 days', () => {
  const now = Date.now();
  const s = params(links.settingsLinkUrl('c', { now }));
  const b = params(links.billingLinkUrl('c', { now }));
  assert.equal(Number(s.e) - Math.floor(now / 1000), 365 * 86400);
  assert.equal(Number(b.e) - Math.floor(now / 1000), 14 * 86400);
  assert.equal(links.verifySettingsLink(s, now + 366 * 86400000), null);
});

test('settings validation', () => {
  const ok = { removal_low: '500', removal_high: '2500', trimming_low: '300', trimming_high: '1200', minimum_job: '350', emergency_multiplier: '1.5', theme: 'slate-gray' };
  assert.deepEqual(validateSettings(ok).fields.theme, 'slate-gray');
  assert.match(validateSettings({ ...ok, removal_low: '3000' }).error, /Removal low end/);
  assert.match(validateSettings({ ...ok, trimming_high: '' }).error, /every rate/);
  assert.match(validateSettings({ ...ok, emergency_multiplier: '9' }).error, /emergency upcharge/);
  assert.match(validateSettings({ ...ok, theme: 'charcoal' }).error, /color/);
  assert.equal(validateSettings({ ...ok, minimum_job: '' }).fields.minimum_job, 0);
  assert.ok(THEMES.some(([k]) => k === 'charcoal-black'));
});
