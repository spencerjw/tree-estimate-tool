import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SUPABASE_URL ??= 'http://fake.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'x';
const { enforceScope, applySpeciesGate } = await import('../api/estimate.js');

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
  assert.deepEqual([e.total_low, e.total_high], [1000, 1450]);
  assert.match(e.notes, /Not included in this estimate: Complete hazard tree removal — standing trunk; Stump grinding/);
});

test('no emergency wording or pricing outside the emergency service', () => {
  const e = enforceScope(stormRun(), 'storm_damage', {});
  assert.doesNotMatch(e.notes, /emergency (service )?rates/i);
  assert.match(e.notes, /^This tree has suffered catastrophic failure\. Complete removal/);
  assert.ok(e.line_items.every(i => !/^emergency/i.test(i.description)));
  assert.equal(e.line_items[0].description[0], 'S');
});

test('a decimal elsewhere in the notes survives the emergency scrub', () => {
  const e = enforceScope({ notes: 'Clean break on a 1.5 ft limb. Emergency rates of 1.5x do not apply here. Haul included.',
    line_items: [{ description: 'Cleanup', scope: 'cleanup', price_low: 400, price_high: 600 }] }, 'storm_damage', {});
  assert.match(e.notes, /^Clean break on a 1\.5 ft limb\. Haul included\./);
});

test('emergency multiplier is applied by code, only for the emergency service', () => {
  const item = { description: 'Remove tree from roof', scope: 'removal', price_low: 1000, price_high: 2000 };
  const em = enforceScope({ notes: '', line_items: [{ ...item }] }, 'emergency', { emergency_multiplier: 1.5 });
  assert.deepEqual([em.total_low, em.total_high], [1500, 3000]);
  assert.match(em.notes, /1\.5x standard rates/);
  const rm = enforceScope({ notes: '', line_items: [{ ...item }] }, 'removal', { emergency_multiplier: 1.5 });
  assert.deepEqual([rm.total_low, rm.total_high], [1000, 2000]);
});

test('minimum job raises the total and says so; default minimum matches the prompt', () => {
  const e = enforceScope({ notes: '', total_low: 9999, total_high: 99999,
    line_items: [{ description: 'Prune one limb', scope: 'trimming', price_low: 150, price_high: 250 }] }, 'trimming', {});
  assert.deepEqual([e.total_low, e.total_high], [350, 350]);
  assert.match(e.notes, /minimum job is \$350/);
});

test('a missing scope defaults to the service, never empties the estimate', () => {
  const e = enforceScope({ notes: '', line_items: [{ description: 'Cut up and remove the downed limb', price_low: 500, price_high: 800 }] }, 'storm_damage', {});
  assert.equal(e.line_items.length, 1);
  assert.equal(e.line_items[0].scope, 'cleanup');
  assert.deepEqual([e.total_low, e.total_high], [500, 800]);
});

test('if nothing is in scope, quote an assessment at the minimum and list the rest', () => {
  const e = enforceScope({ notes: 'Emergency rates apply.', total_low: 2000, total_high: 3000,
    line_items: [{ description: 'Remove standing tree', scope: 'removal', price_low: 2000, price_high: 3000 }] }, 'storm_damage', {});
  assert.deepEqual([e.total_low, e.total_high], [350, 350]);
  assert.equal(e.line_items[0].description, 'Starting price. Exact price set after an on-site look.');
  assert.match(e.notes, /Not included in this estimate: Remove standing tree\./);
  assert.doesNotMatch(e.notes, /Emergency rates/);
});

test('no line items at all still produces an estimate, never an error', () => {
  const e = enforceScope({ notes: '', recommended_followups: ['Remove the damaged tree'], line_items: [] }, 'storm_damage', {});
  assert.deepEqual([e.total_low, e.total_high], [350, 350]);
  assert.match(e.notes, /Not included in this estimate: Remove the damaged tree\./);
});

test('other-scope add-ons are priced', () => {
  const e = enforceScope({ notes: '', line_items: [
    { description: 'Cleanup', scope: 'cleanup', price_low: 400, price_high: 600 },
    { description: 'Wood chipping', scope: 'other', price_low: 100, price_high: 200 }] }, 'storm_damage', {});
  assert.deepEqual([e.total_low, e.total_high], [500, 800]);
  const back = enforceScope({ notes: '', line_items: [
    { description: 'Cleanup', scope: 'cleanup', price_low: 400, price_high: 600 },
    { description: 'Crane rental', scope: 'other', price_low: 1000, price_high: 2000 },
    { description: 'Hazard tree removal', scope: 'other', price_low: 2000, price_high: 3000 }] }, 'storm_damage', {});
  assert.deepEqual([back.total_low, back.total_high], [400, 600]);
  assert.match(back.notes, /Not included in this estimate: Crane rental; Hazard tree removal\./);
});

test('place names with tree words survive the species scrub', () => {
  const e = applySpeciesGate({ species: 'Unable to determine', species_confidence: 0,
    notes: 'Common in the Cedar Park area and near Oak Hill. The cedar elm is split.',
    line_items: [{ description: 'Cleanup', price_low: 1, price_high: 2 }] });
  assert.equal(e.notes, 'Common in the Cedar Park area and near Oak Hill. The tree is split.');
});

test('string prices are parsed; unpriced items go to followups', () => {
  const e = enforceScope({ notes: '', line_items: [
    { description: 'Haul', scope: 'haul', price_low: '$500', price_high: '1,200' },
    { description: 'Mystery fee', scope: 'haul', price_low: null, price_high: 'call us' },
  ] }, 'removal', {});
  assert.deepEqual([e.line_items[0].price_low, e.line_items[0].price_high], [500, 1200]);
  assert.match(e.notes, /Not included in this estimate: Mystery fee\./);
});

test('model followups and unknown scopes land in notes, not the total', () => {
  const e = enforceScope({ notes: 'Clean break.', recommended_followups: ['Cable the remaining co-dominant leader'],
    line_items: [{ description: 'Crown thinning', scope: 'trimming', price_low: 400, price_high: 600 },
                 { description: 'Mystery', scope: 'banana', price_low: 1, price_high: 2 }] }, 'trimming', {});
  assert.equal(e.line_items.length, 1);
  assert.match(e.notes, /Not included in this estimate: Cable the remaining co-dominant leader; Mystery\./);
  assert.equal(e.recommended_followups, undefined);
});

test('small prices are not rounded to $0 outside the emergency multiplier', () => {
  const e = enforceScope({ notes: '', line_items: [
    { description: 'Cleanup', scope: 'cleanup', price_low: 400, price_high: 600 },
    { description: 'Disposal fee', scope: 'haul', price_low: 10, price_high: 12 }] }, 'storm_damage', {});
  assert.deepEqual([e.line_items[1].price_low, e.line_items[1].price_high], [10, 12]);
});

test('a gated species never reappears in a line item or the notes (2026-10-04 removal run)', () => {
  const e = applySpeciesGate({
    species: 'Unable to determine', species_confidence: 0,
    notes: 'The cedar elm has a split trunk. Possibly a live oak nearby.',
    line_items: [{ description: 'Emergency hazardous tree removal — storm-damaged cedar elm with major trunk failure', price_low: 1, price_high: 2 }],
  });
  assert.equal(e.species, 'Not determinable from photos');
  assert.equal(e.line_items[0].description, 'Emergency hazardous tree removal — storm-damaged tree with major trunk failure');
  assert.equal(e.notes, 'The tree has a split trunk. Possibly a tree nearby.');
  assert.doesNotMatch(JSON.stringify(e.line_items) + e.notes, /elm|oak/i);
});

test('a confident species is left alone everywhere', () => {
  const e = applySpeciesGate({ species: 'Live oak', species_confidence: 95, notes: 'Live oak, prune outside oak wilt season.',
    line_items: [{ description: 'Prune live oak', price_low: 1, price_high: 2 }] });
  assert.equal(e.species, 'Live oak');
  assert.equal(e.line_items[0].description, 'Prune live oak');
});

test('an explicit minimum of 0 means no floor', () => {
  const e = enforceScope({ notes: '', line_items: [{ description: 'Prune one limb', scope: 'trimming', price_low: 150, price_high: 250 }] }, 'trimming', { minimum_job: 0 });
  assert.deepEqual([e.total_low, e.total_high], [150, 250]);
  assert.doesNotMatch(e.notes, /minimum/);
});

test('emergency scrub keeps a following sentence that starts with a digit, and keeps paragraphs', () => {
  const e = enforceScope({ notes: 'Emergency rates apply. 3 limbs are down on the fence.\n\nAccess is open.',
    line_items: [{ description: 'Cleanup', scope: 'cleanup', price_low: 400, price_high: 600 }] }, 'storm_damage', {});
  assert.equal(e.notes, '3 limbs are down on the fence.\n\nAccess is open.');
});

test('blank and negative prices are not priced as $0 or discounts', () => {
  const e = enforceScope({ notes: '', line_items: [
    { description: 'Cleanup', scope: 'cleanup', price_low: 400, price_high: 600 },
    { description: 'Haul away', scope: 'haul', price_low: '', price_high: '' },
    { description: 'Discount', scope: 'haul', price_low: -100, price_high: -100 }] }, 'storm_damage', {});
  assert.equal(e.line_items.length, 1);
  assert.match(e.notes, /Not included in this estimate: Haul away; Discount\./);
});

test('other-scope items are parsed and multiplied on the emergency service', () => {
  const em = enforceScope({ notes: '', line_items: [{ description: 'Travel fee', scope: 'other', price_low: '$1,000', price_high: '2,000' }] }, 'emergency', { emergency_multiplier: 1.5 });
  assert.deepEqual([em.total_low, em.total_high], [1500, 3000]);
  assert.match(em.notes, /1\.5x standard rates/);
});

test('species scrub leaves arborist terms alone and keeps grammar and paragraphs', () => {
  const e = applySpeciesGate({
    species: 'Unable to determine', species_confidence: 0,
    notes: 'Watch for Dutch elm disease and southern pine beetle near the red cedar privacy fence.\n\nAn eastern red cedar nearby.',
    complexity_factors: ['Spanish oak leaning toward fence'],
    recommended_followups: ['Cedar elm stump grinding'],
    line_items: [{ description: 'Remove two live oak trees', price_low: 1, price_high: 2 }],
  });
  assert.equal(e.line_items[0].description, 'Remove two trees');
  assert.equal(e.notes, 'Watch for Dutch elm disease and southern pine beetle near the red cedar privacy fence.\n\nA tree nearby.');
  assert.equal(e.complexity_factors[0], 'Tree leaning toward fence');
  assert.equal(e.recommended_followups[0], 'Tree stump grinding');
});

test('bare species names, hedged raw names and botanical names are scrubbed', () => {
  const e = applySpeciesGate({ species: 'Pecan (likely)', species_confidence: 60,
    notes: 'Live oak (Quercus virginiana) with decay. Hackberry nearby.',
    line_items: [{ description: 'Oak removal', price_low: 1, price_high: 2 }, { description: 'Pecan limb cleanup', price_low: 1, price_high: 2 }] });
  assert.deepEqual(e.line_items.map(i => i.description), ['Tree removal', 'Tree limb cleanup']);
  assert.equal(e.notes, 'Tree with decay. Tree nearby.');
});

test('oak-specific advice is dropped when the species is hidden', () => {
  const e = applySpeciesGate({ species: 'Live oak', species_confidence: 70,
    notes: 'Clean cuts needed. Paint wounds on the oak right away; avoid pruning Feb-June (oak wilt).',
    line_items: [{ description: 'Prune', price_low: 1, price_high: 2 }] });
  assert.equal(e.notes, 'Clean cuts needed.');
});

test('a priced item is never also listed as not included', () => {
  const e = enforceScope({ notes: '', recommended_followups: ['Remove tree'],
    line_items: [{ description: 'Remove tree', scope: 'removal', price_low: 1000, price_high: 2000 }] }, 'removal', {});
  assert.doesNotMatch(e.notes, /Not included/);
});

test('the raw species the model gave is scrubbed even if not in the list', () => {
  const e = applySpeciesGate({ species: 'Chinese tallow', species_confidence: 40, notes: 'Chinese tallow is invasive.',
    line_items: [{ description: 'Remove Chinese tallow', price_low: 1, price_high: 2 }] });
  assert.equal(e.line_items[0].description, 'Remove tree');
});

test('emergency fallback: a priced item is not also listed as not included', () => {
  const e = enforceScope({ notes: '', line_items: [{ description: 'Emergency travel fee', scope: 'other', price_low: 1000, price_high: 2000 }] }, 'emergency', { emergency_multiplier: 1.5 });
  assert.doesNotMatch(e.notes, /Not included/);
});

test('title-case line items are still scrubbed; explicit place names are kept', () => {
  const e = applySpeciesGate({ species: 'Unable to determine', species_confidence: 0,
    notes: 'Serving Cedar Park and the City of Live Oak.',
    line_items: [{ description: 'Hanging Pecan Branch Cleanup', price_low: 1, price_high: 2 }] });
  assert.equal(e.line_items[0].description, 'Hanging tree Branch Cleanup');
  assert.equal(e.notes, 'Serving Cedar Park and the City of Live Oak.');
});

test('emergency fallback applies the multiplier its note claims', () => {
  const e = enforceScope({ notes: '', line_items: [] }, 'emergency', { emergency_multiplier: 1.5 });
  assert.deepEqual([e.total_low, e.total_high], [525, 525]);
  assert.match(e.notes, /1\.5x standard rates/);
});

test('emergency notes: the model rate claim is removed, only the code surcharge line remains', () => {
  const e = enforceScope({ notes: 'Limb is on the roof. Emergency rates (2x) have been applied to all line items.',
    line_items: [{ description: 'Remove limb from roof', scope: 'cleanup', price_low: 800, price_high: 1200 }] }, 'emergency', { emergency_multiplier: 1.5 });
  assert.equal(e.notes, 'Limb is on the roof. Emergency response pricing (1.5x standard rates) is included.');
});

test('other: removal permits, disposal fees and configured add-ons are priced; crane is not', () => {
  const e = enforceScope({ notes: '', line_items: [
    { description: 'Remove tree', scope: 'removal', price_low: 1000, price_high: 2000 },
    { description: 'City tree removal permit', scope: 'other', price_low: 50, price_high: 100 },
    { description: 'Debris removal and disposal fee', scope: 'other', price_low: 100, price_high: 150 },
    { description: 'Stump grinding add-on', scope: 'other', price_low: 150, price_high: 250 },
    { description: 'Crane rental fee', scope: 'other', price_low: 1500, price_high: 2500 }] }, 'removal', { add_ons: [{ name: 'Stump grinding' }] });
  assert.deepEqual([e.total_low, e.total_high], [1300, 2500]);
  assert.match(e.notes, /Not included in this estimate: Crane rental fee\./);
});

test('street and place names with tree words survive the scrub', () => {
  const e = applySpeciesGate({ species: 'Unable to determine', species_confidence: 0,
    notes: 'Access from Oak Hills Dr. Serving Cypress Creek and Live Oak, TX.',
    line_items: [{ description: 'Cleanup', price_low: 1, price_high: 2 }] });
  assert.equal(e.notes, 'Access from Oak Hills Dr. Serving Cypress Creek and Live Oak, TX.');
});
