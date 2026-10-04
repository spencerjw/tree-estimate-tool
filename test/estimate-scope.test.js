import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SUPABASE_URL ??= 'http://fake.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'x';
const { enforceScope } = await import('../api/estimate.js');

// The 2026-10-04 storm-damage run, as the model returned it before this change.
const stormRun = () => ({
  notes: 'This tree has suffered catastrophic failure. Complete removal is strongly recommended. Emergency service rates applied due to active hazard condition.',
  line_items: [
    { description: 'Emergency storm damage cleanup — remove fallen limbs from driveway, sidewalk, and lawn', scope: 'cleanup', price_low: 800, price_high: 1200 },
    { description: 'Complete hazard tree removal — standing trunk', scope: 'removal', price_low: 2800, price_high: 3800 },
    { description: 'Stump grinding (30-36 inch diameter)', scope: 'stump', price_low: 250, price_high: 300 },
    { description: 'Debris haul-away (large volume)', scope: 'haul', price_low: 200, price_high: 250 },
  ],
  total_low: 4050,
  total_high: 5550,
});

test('storm damage keeps only cleanup-scope work in the total', () => {
  const e = enforceScope(stormRun(), 'storm_damage', { minimum_job: 350 });
  assert.deepEqual(e.line_items.map(i => i.scope), ['cleanup', 'haul']);
  assert.equal(e.total_low, 1000);
  assert.equal(e.total_high, 1450);
  assert.match(e.notes, /Not included in this estimate: Complete hazard tree removal — standing trunk; Stump grinding/);
});

test('no emergency wording or pricing outside the emergency service', () => {
  const e = enforceScope(stormRun(), 'storm_damage', {});
  assert.doesNotMatch(e.notes, /emergency (service )?rates/i);
  assert.ok(e.line_items.every(i => !/^emergency/i.test(i.description)));
  assert.equal(e.line_items[0].description[0], 'S');
});

test('emergency multiplier is applied by code, only for the emergency service', () => {
  const item = { description: 'Remove tree from roof', scope: 'removal', price_low: 1000, price_high: 2000 };
  const em = enforceScope({ notes: '', line_items: [{ ...item }] }, 'emergency', { emergency_multiplier: 1.5 });
  assert.deepEqual([em.total_low, em.total_high], [1500, 3000]);
  assert.match(em.notes, /1\.5x standard rates/);
  const rm = enforceScope({ notes: '', line_items: [{ ...item }] }, 'removal', { emergency_multiplier: 1.5 });
  assert.deepEqual([rm.total_low, rm.total_high], [1000, 2000]);
});

test('totals are recomputed from line items and respect the minimum job', () => {
  const e = enforceScope({ notes: '', total_low: 9999, total_high: 99999,
    line_items: [{ description: 'Prune one limb', scope: 'trimming', price_low: 150, price_high: 250 }] }, 'trimming', { minimum_job: 350 });
  assert.deepEqual([e.total_low, e.total_high], [350, 350]);
});

test('model followups and unscoped items land in notes, not the total', () => {
  const e = enforceScope({ notes: 'Clean break.', recommended_followups: ['Cable the remaining co-dominant leader'],
    line_items: [{ description: 'Crown thinning', scope: 'trimming', price_low: 400, price_high: 600 },
                 { description: 'Mystery', scope: 'banana', price_low: 1, price_high: 2 }] }, 'trimming', {});
  assert.equal(e.line_items.length, 1);
  assert.match(e.notes, /Not included in this estimate: Cable the remaining co-dominant leader; Mystery\./);
  assert.equal(e.recommended_followups, undefined);
});
