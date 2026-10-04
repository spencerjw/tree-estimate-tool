// Vercel serverless function — multi-tenant AI tree estimate.
// Detects customer from subdomain, checks limits, generates estimate, logs to Supabase.

import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import { supabase } from '../lib/supabase.js';
import { sendLeadNotificationEmail, sendHomeownerEstimateEmail } from '../lib/emails.js';
import { rateLimit, clientIp } from '../lib/rate-limit.js';

// ---------------------------------------------------------------------------
// Tier limits (estimates per month)
// ---------------------------------------------------------------------------
const TIER_LIMITS = { starter: 50, pro: 250, proplus: Infinity };

// ---------------------------------------------------------------------------
// Demo customer — used for demo subdomain and local/preview environments.
// No Supabase lookup, no usage logging.
// ---------------------------------------------------------------------------
const DEMO_CUSTOMER = {
  id: null,
  business_name: 'TreeSnap Demo',
  company_name: 'TreeSnap Demo',
  owner_name: 'Demo',
  email: process.env.DEFAULT_BUSINESS_EMAIL ?? '',
  phone: '',
  subdomain: 'demo',
  tier: 'proplus', // give demo all features
  status: 'active',
};

const DEMO_CONFIG = {
  base_rate_removal_low:    300,
  base_rate_removal_high:   5500,
  base_rate_trimming_low:   150,
  base_rate_trimming_high:  1200,
  emergency_multiplier:     1.5,
  minimum_job:              350,
  service_zips:             [],
  add_ons:                  [],
  custom_disclaimer:        null,
};

// ---------------------------------------------------------------------------
// Subdomain helpers
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Species confidence gate
//
// A certified arborist reads these estimates, and species is the one field he
// can disprove on sight (it was wrong on both of Matt Roberts' jobs, 2026-08-29).
// So the model must earn the right to name it. Enforced here rather than only in
// the prompt, because a prompt is a request and this is a rule.
// ---------------------------------------------------------------------------
const SPECIES_CONFIDENCE_MIN = 85;

// A model asked for a species will sometimes answer with its own uncertainty at
// high confidence ("Unidentifiable", 95). That is not a species name.
const NON_ANSWER = /unidentif|unable to (determine|identify)|not (determinable|clear|certain|sure|visible)|undetermined|indeterminate|unknown|unclear|hard to tell|difficult to|cannot identify|can'?t identify|likely|possibly|probably|appears? to be|perhaps|maybe|\bor\b|\?|^n\/?a$/i;

// ...or with a category rather than a species. "Deciduous hardwood" carries no
// hedge word but tells an arborist nothing he did not already know.
const CATEGORY_ONLY = /^(?:(?:a|an|the|large|small|young|mature|native|common|deciduous|evergreen|broad-?leaf(?:ed)?|conifer(?:ous)?|hardwood|softwood|shade|ornamental|fruit|tree|shrub|species|type)\s*)+$/i;

export function applySpeciesGate(estimate) {
  const rawName = typeof estimate?.species === 'string' ? estimate.species.trim() : null;
  const rawPct  = estimate?.species_confidence ?? null;

  // "92%" / "92 percent" are plausible given the schema only promises a number.
  let pct = Number(typeof rawPct === 'string' ? rawPct.replace(/\s*(%|percent)\s*$/i, '').trim() : rawPct);
  // The sibling VALIDATION_PROMPT in this file uses a 0.0-1.0 scale, so a 0-1
  // answer here is a live risk. Treat it as a fraction rather than suppressing
  // every estimate. Exactly 1 stays 1: it is ambiguous, and 1% is the safe read.
  if (Number.isFinite(pct) && pct > 0 && pct < 1) {
    console.log('SPECIES CONFIDENCE looked like a 0-1 fraction, scaled:', rawPct);
    pct = pct * 100;
  }

  // Keep what the model actually said. Without this we can never answer "how
  // often does the gate fire" or "is 85 the right number" from real traffic.
  // Stripped from the HTTP response; retained in the stored estimate_data.
  estimate.species_raw = rawName;
  estimate.species_confidence_raw = rawPct;

  // A real species name is short: "Live oak", "Eastern red cedar", "Bald cypress".
  const wordCount = rawName ? rawName.split(/\s+/).length : 0;
  const usable = rawName
    && wordCount <= 4
    && !NON_ANSWER.test(rawName)
    && !CATEGORY_ONLY.test(rawName)
    && Number.isFinite(pct) && pct >= SPECIES_CONFIDENCE_MIN;

  if (usable) {
    estimate.species = rawName;
    estimate.species_confidence = Math.min(100, Math.round(pct));
  } else {
    if (rawName) {
      console.log('SPECIES SUPPRESSED:', JSON.stringify({ species: rawName, confidence: rawPct }));
    }
    estimate.species = 'Not determinable from photos';
    estimate.species_confidence = null;
    scrubSuppressedSpecies(estimate, rawName);
  }
  return estimate;
}

// When the gate hides the species, no species name may appear anywhere else in
// the estimate (2026-10-04: "Not determinable from photos" next to a line item
// reading "storm-damaged cedar elm").
//
// Arborist terms that contain a tree name are set aside first and restored after,
// so "oak wilt", "southern pine beetle", "Dutch elm disease" or a "cedar fence"
// are never rewritten.
const PROTECTED_TERMS = /\b(?:(?:texas\s+)?oak\s+wilt|(?:southern|mountain|western|ips)?\s*pine\s+(?:beetles?|bark\s+beetles?)|pine\s+wilt|dutch\s+elm\s+disease|elm\s+(?:leaf\s+)?beetles?|emerald\s+ash\s+borers?|ash\s+borers?|(?:red\s+)?cedar\s+(?:privacy\s+)?(?:fence|fencing|lumber|posts?|boards?|pickets?|siding|mulch|shingles?)|pine\s+(?:straw|needles?\s+mulch)|live\s+oak,\s*(?:tx|texas))\b/gi;
// Texas place names that contain a tree word. An explicit list, case-sensitive:
// a pattern would also protect title-case line items like "Pecan Branch Cleanup".
const PLACE_NAMES = new RegExp(
  '\\b(?:Cedar Park|Cedar Hill|Oak Cliff|Shavano Park|Live Oak County|City of Live Oak|Live Oak, (?:TX|Texas)' +
  // A tree word followed by a place or street word: "Oak Hills Dr", "Cypress Creek".
  '|(?:Live Oak|Cedar|Oak|Pecan|Elm|Pine|Cypress|Walnut|Willow|Magnolia|Hickory|Mesquite)\\s+' +
  '(?:Hills?|Creek|Park|Valley|Grove|Springs?|Heights|Village|Ridge|Cliff|Bluff|Point|Lake|Dr|Drive|Rd|Road|St|Street|Ln|Lane|Blvd|Ave|Trail|Way|Pkwy))\\b',
  'g',
);

const SPECIES_HEADS = 'oak|elm|maple|ash|pine|cypress|cedar|pecan|hackberry|mesquite|juniper|sycamore|cottonwood|' +
  'willow|magnolia|walnut|hickory|sweetgum|redbud|myrtle|palm|birch|poplar|locust|mulberry|chinaberry|ligustrum|' +
  'pistache|tallow|laurel|pear|bois d\'arc';
const SPECIES_QUALIFIERS = 'american|cedar|chinese|siberian|lacebark|winged|slippery|live|post|red|white|water|' +
  'shumard|bur|pin|laurel|texas|lacey|chinkapin|blackjack|spanish|mountain|desert|bigtooth|silver|sugar|bald|' +
  'loblolly|slash|longleaf|shortleaf|eastern|ashe|green|arizona|mexican|bradford|callery|crape|southern|sweet|' +
  'black|honey|common|cherry';
// Qualifiers are optional: a bare "Oak" or "Pecan" is a species call too.
const SPECIES_MENTION = new RegExp(
  `\\b(?:(?:${SPECIES_QUALIFIERS})\\s+){0,2}(?:${SPECIES_HEADS})(s|es)?(\\s+trees?)?\\b`, 'gi');
// A botanical name in parentheses: "(Quercus virginiana)".
const BOTANICAL = /\s*\((?:[A-Z][a-z]+\s+[a-z]+(?:\s+(?:var\.|subsp\.)\s+[a-z]+)?)\)/g;
// Advice that only makes sense if the species call were right.
const SPECIES_ADVICE = /\boak\s+wilt\b/i;

// Capitalize only at the start of a sentence: "Oak removal" -> "Tree removal",
// but "Remove Chinese tallow" -> "Remove tree".
const keepCase = (str, offset, word) =>
  (offset === 0 || /[.!?\n]\s*$/.test(str.slice(0, offset)) ? word[0].toUpperCase() + word.slice(1) : word);

function scrubText(text, rawName) {
  const saved = [];
  const keep = m => `\u0000${saved.push(m) - 1}\u0000`;
  let out = text.replace(PROTECTED_TERMS, keep).replace(PLACE_NAMES, keep);
  out = out.replace(BOTANICAL, '');
  if (rawName && rawName.length >= 3) {
    const esc = rawName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![\\w])${esc}(?![\\w])`, 'gi'), (_m, offset, str) => keepCase(str, offset, 'tree'));
  }
  out = out.replace(SPECIES_MENTION, (_m, plural, treeWord, offset, str) =>
    keepCase(str, offset, plural || (treeWord && /trees$/i.test(treeWord)) ? 'trees' : 'tree'));
  out = out
    .replace(/\btrees?(?:\s+trees?)+\b/gi, m => (/s$/i.test(m) ? 'trees' : 'tree'))
    .replace(/\b(a|A)n (trees?)\b/g, '$1 $2')
    .replace(/\u0000(\d+)\u0000/g, (_m, i) => saved[Number(i)])
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return out.replace(/^[a-z]/, c => (/^[A-Z]/.test(text.trim()) ? c.toUpperCase() : c));
}

function dropSpeciesAdvice(notes) {
  return notes
    .split(/\n/)
    .map(para => para.split(/(?<=[.!?])\s+(?=\S)/).filter(s => !SPECIES_ADVICE.test(s)).join(' '))
    .join('\n')
    .trim();
}

function scrubSuppressedSpecies(estimate, rawName) {
  const raw = (rawName || '').trim();
  const name = raw.length >= 3 && !NON_ANSWER.test(raw) && !CATEGORY_ONLY.test(raw) ? raw : null;
  for (const item of Array.isArray(estimate.line_items) ? estimate.line_items : []) {
    if (typeof item?.description === 'string') item.description = scrubText(item.description, name);
  }
  for (const key of ['recommended_followups', 'complexity_factors', 'safety_concerns']) {
    if (Array.isArray(estimate[key])) estimate[key] = estimate[key].map(x => (typeof x === 'string' ? scrubText(x, name) : x));
  }
  if (typeof estimate.notes === 'string') estimate.notes = scrubText(dropSpeciesAdvice(estimate.notes), name);
}

function extractSubdomain(host) {
  return host.split('.')[0].toLowerCase();
}

function isDemoHost(host) {
  const sub = extractSubdomain(host);
  return (
    sub === 'demo' ||
    host.includes('localhost') ||
    host.includes('127.0.0.1') ||
    host.includes('vercel.app')
  );
}

// ---------------------------------------------------------------------------
// Scope and pricing rules
//
// The model used to price whatever it imagined: a storm-damage request for one
// dropped limb came back as "Complete hazard tree removal" + stump grinding with
// "Emergency service rates applied" (2026-10-04), the same worst-case pattern as
// Matt Roberts' runs (crane, power lines, flat 50-60 ft; 2026-09-10). These are
// enforced here, not only asked for in the prompt:
//   - a line item is priced only if its scope belongs to the requested service;
//     anything else becomes a "not included" follow-up, outside the total
//   - the emergency multiplier is applied by this code, and only on the
//     emergency service; the model prices everything at standard rates
//   - totals are recomputed from the line items, with the minimum job applied
// ---------------------------------------------------------------------------
// 'other' is allowed for every service, but only for the shop's configured
// add-ons and fee-type lines (permit, travel, disposal); see isAllowedOther.
export const SERVICE_SCOPES = {
  removal:      ['removal', 'stump', 'haul', 'cleanup', 'other'],
  trimming:     ['trimming', 'haul', 'cleanup', 'other'],
  storm_damage: ['cleanup', 'haul', 'trimming', 'other'],
  emergency:    ['removal', 'cleanup', 'haul', 'trimming', 'stump', 'other'],
};
// Order matters: the shop's own add-ons are always priced; fee-type lines are
// priced unless they are crane/bucket-truck equipment; anything else tagged
// "other" (e.g. an untagged tree removal) is not.
const OTHER_FEE = /\b(permit|travel|trip|disposal|dump|chipping|chips?|mulch|fee)\b/i;
const EQUIPMENT = /\b(crane|bucket truck)\b/i;
function isAllowedOther(description, config) {
  const addOns = Array.isArray(config?.add_ons) ? config.add_ons : [];
  const d = description.toLowerCase();
  if (addOns.some(a => a?.name && d.includes(String(a.name).toLowerCase()))) return true;
  return OTHER_FEE.test(description) && !EQUIPMENT.test(description);
}
const ALL_SCOPES = ['removal', 'trimming', 'cleanup', 'haul', 'stump', 'other'];

// A sentence in notes that claims emergency pricing. Matched per sentence, so a
// decimal ("1.5 ft") elsewhere in the notes is never cut in half.
const EMERGENCY_CLAIM = /\bemergency (?:service |response )?(?:rate|rates|pricing|multiplier|surcharge|premium)\b/i;
const DEFAULT_MINIMUM_JOB = 350;
const DEFAULT_SCOPE = { removal: 'removal', trimming: 'trimming', storm_damage: 'cleanup', emergency: 'removal' };

const roundTo25 = n => Math.round(n / 25) * 25;

// An explicit 0 means "no minimum"; only a missing or unusable value takes the
// default. Used by both the prompt and the totals so they always agree.
function resolveMinimumJob(config = {}) {
  const v = config?.minimum_job;
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) || n < 0 ? DEFAULT_MINIMUM_JOB : n;
}
// A usable price: a finite, non-negative number. '' and null are NOT zero.
const stripEmergencyPrefix = t => t.replace(/^emergency\s+/i, '').replace(/^./, c => c.toUpperCase());

const toPrice = v => {
  if (v === null || v === undefined) return NaN;
  const n = Number(typeof v === 'string' ? v.replace(/[$,\s]/g, '') : v);
  return typeof v === 'string' && !v.replace(/[$,\s]/g, '') ? NaN : (n >= 0 ? n : NaN);
};
const money = n => `$${Number(n).toLocaleString('en-US')}`;

// Drops only the sentences that claim emergency pricing. Splits on sentence ends
// followed by any non-space start (digits and lowercase too), and keeps line
// breaks between paragraphs.
function stripEmergencyClaims(notes) {
  return notes
    .split(/\n/)
    .map(para => para
      .split(/(?<=[.!?])\s+(?=\S)/)
      .filter(sentence => !EMERGENCY_CLAIM.test(sentence))
      .join(' ')
      .trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Pruning is one job: separate pruning lines (crown cleaning, thinning,
// selective pruning...) read as charging three times. Merge them into one line
// that names the work; the price is the sum. Ball moss lines become a notes
// observation. "Flush" cuts are rewritten to the branch collar.
const EPIPHYTE = /\b(ball moss|spanish moss|epiphytes?|lichen)\b/i;
const lowerFirst = t => t.replace(/^[A-Z](?![A-Z])/, c => c.toLowerCase());

export function mergePruning(estimate) {
  const items = Array.isArray(estimate.line_items) ? estimate.line_items : [];
  const observations = [];
  const kept = [];
  for (const item of items) {
    if (EPIPHYTE.test(item?.description ?? '')) {
      observations.push(item.description.match(EPIPHYTE)[0].toLowerCase());
      continue;
    }
    kept.push(item);
  }
  const pruning = kept.filter(i => i.scope === 'trimming');
  if (pruning.length > 1) {
    const merged = {
      description: `Prune: ${pruning.map(i => lowerFirst(i.description.replace(/^prune:\s*/i, ''))).join('; ')}`,
      scope: 'trimming',
      price_low: pruning.reduce((t, i) => t + i.price_low, 0),
      price_high: pruning.reduce((t, i) => t + i.price_high, 0),
    };
    const first = kept.indexOf(pruning[0]);
    estimate.line_items = kept.filter(i => i.scope !== 'trimming');
    estimate.line_items.splice(Math.min(first, estimate.line_items.length), 0, merged);
  } else {
    estimate.line_items = kept;
  }
  if (observations.length) {
    const what = [...new Set(observations)].join(' and ');
    const note = `${what[0].toUpperCase()}${what.slice(1)} is visible in the canopy.`;
    if (!new RegExp(what.split(' and ')[0], 'i').test(estimate.notes || '')) {
      estimate.notes = `${estimate.notes ? estimate.notes + ' ' : ''}${note}`;
    }
  }
  return estimate;
}

function collarCuts(text) {
  return text
    .replace(/\bflush\s+(?:with|to|against)\s+(?:the\s+)?(?:trunk|stem|parent (?:limb|branch))\b/gi, 'to the branch collar')
    .replace(/\bflush[- ]cut(s?)\b/gi, 'collar cut$1')
    .replace(/\bcut(s?)\s+flush\b/gi, 'cut$1 to the branch collar');
}

// What the height was judged against goes into the notes; with no basis the
// height is marked as unscaled rather than presented as a measurement.
function applyHeightBasis(estimate) {
  const basis = typeof estimate.height_basis === 'string' ? estimate.height_basis.trim().replace(/\.$/, '') : '';
  const noScale = !basis || /\b(no|nothing)\b.*\b(scale|reference)\b|not visible|out of frame/i.test(basis);
  if (typeof estimate.estimated_height === 'string' && noScale && !/no scale/i.test(estimate.estimated_height)) {
    estimate.estimated_height = `${estimate.estimated_height} (no scale reference visible)`;
  }
  if (basis && !noScale) {
    estimate.notes = `${estimate.notes ? estimate.notes + ' ' : ''}Height judged against: ${lowerFirst(basis)}.`;
  }
  return estimate;
}

export function enforceScope(estimate, serviceType, config = {}) {
  const allowed = SERVICE_SCOPES[serviceType] ?? ALL_SCOPES;
  const isEmergency = serviceType === 'emergency';
  const mult = isEmergency ? Number(config.emergency_multiplier) || 1.5 : 1;
  const original = Array.isArray(estimate.line_items) ? estimate.line_items : [];

  const kept = [];
  const followups = Array.isArray(estimate.recommended_followups)
    ? estimate.recommended_followups.filter(f => typeof f === 'string' && f.trim()).map(f => f.trim())
    : [];

  for (const item of original) {
    let description = String(item?.description ?? '').trim();
    if (!description) continue;
    const low = toPrice(item?.price_low ?? item?.low);
    const high = toPrice(item?.price_high ?? item?.high);
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      console.error('ESTIMATE ITEM UNPRICED:', JSON.stringify(item));
      followups.push(description);
      continue;
    }
    // A missing scope is the model forgetting the field, not out-of-scope work.
    let scope = String(item?.scope ?? '').toLowerCase().trim();
    if (!scope) scope = DEFAULT_SCOPE[serviceType] ?? 'other';
    if (!allowed.includes(scope) || (scope === 'other' && !isAllowedOther(description, config))) {
      followups.push(description);
      continue;
    }
    if (!isEmergency) description = stripEmergencyPrefix(description);
    const lo = Math.min(low, high) * mult;
    const hi = Math.max(low, high) * mult;
    kept.push({
      description,
      scope,
      price_low:  mult === 1 ? lo : roundTo25(lo),
      price_high: mult === 1 ? hi : roundTo25(hi),
    });
  }

  if (!kept.length) {
    // Nothing the model priced fits what the customer asked for. Don't price the
    // out-of-scope work (that is the 2026-10-04 bug) and don't fail the request
    // (that loses the lead): quote an on-site assessment at the minimum job and
    // list the rest as not included. Logged so the scope rules can be tuned.
    console.error('ENFORCE SCOPE: nothing priced in scope; assessment fallback:', JSON.stringify({ serviceType, original }));
    // A starting number, not a charge for the visit, and no promise about what
    // the visit costs (that is the shop's call). A shop with no minimum still
    // needs a starting number, so the default stands in.
    const min = (resolveMinimumJob(config) || DEFAULT_MINIMUM_JOB) * mult;
    kept.push({
      description: 'Starting price. Exact price set after an on-site look.',
      scope: DEFAULT_SCOPE[serviceType] ?? 'other',
      price_low: mult === 1 ? min : roundTo25(min),
      price_high: mult === 1 ? min : roundTo25(min),
    });
  }

  // Anything priced must not also be listed as "not included" (two items can
  // read the same after the species scrub, or across the emergency prefix).
  const bare = t => stripEmergencyPrefix(t).toLowerCase();
  const priced = new Set(kept.map(i => bare(i.description)));
  for (let i = followups.length - 1; i >= 0; i--) if (priced.has(bare(followups[i]))) followups.splice(i, 1);

  estimate.line_items = kept;
  const sumLow = kept.reduce((t, i) => t + i.price_low, 0);
  const sumHigh = kept.reduce((t, i) => t + i.price_high, 0);
  const minimum = resolveMinimumJob(config);
  estimate.total_low = Math.max(sumLow, minimum);
  estimate.total_high = Math.max(sumHigh, minimum);

  let notes = typeof estimate.notes === 'string' ? estimate.notes : '';
  // The model's own emergency-pricing claims are removed on every service; the
  // code's surcharge line is the only one. (Safety concerns have their own list.)
  notes = stripEmergencyClaims(notes);
  if (sumLow < minimum) {
    notes = `${notes}${notes ? ' ' : ''}The minimum job is ${money(minimum)}, so the total starts there.`;
  }
  if (followups.length) {
    const list = [...new Set(followups)].join('; ');
    notes = `${notes}${notes ? ' ' : ''}Not included in this estimate: ${list}. An on-site visit will confirm whether any of it is needed.`;
  }
  if (isEmergency && mult !== 1) {
    notes = `${notes}${notes ? ' ' : ''}Emergency response pricing (${mult}x standard rates) is included.`;
  }
  estimate.notes = notes;
  delete estimate.recommended_followups;
  mergePruning(estimate);
  applyHeightBasis(estimate);
  for (const item of estimate.line_items) item.description = collarCuts(item.description);
  estimate.notes = collarCuts(estimate.notes);
  // Totals follow the line items (a ball-moss line may have been removed).
  const lo = estimate.line_items.reduce((t, i) => t + i.price_low, 0);
  const hi = estimate.line_items.reduce((t, i) => t + i.price_high, 0);
  const min = resolveMinimumJob(config);
  estimate.total_low = Math.max(lo, min);
  estimate.total_high = Math.max(hi, min);
  return estimate;
}

// ---------------------------------------------------------------------------
// Build customer-aware system prompt
// ---------------------------------------------------------------------------
function buildSystemPrompt(customer, config, serviceType) {
  const businessName = customer.business_name || customer.company_name || 'this tree service company';
  const cfg = config ?? {};

  const removalRange =
    cfg.base_rate_removal_low && cfg.base_rate_removal_high
      ? `$${cfg.base_rate_removal_low}–$${cfg.base_rate_removal_high}`
      : 'regional market rate';

  const trimmingRange =
    cfg.base_rate_trimming_low && cfg.base_rate_trimming_high
      ? `$${cfg.base_rate_trimming_low}–$${cfg.base_rate_trimming_high}`
      : 'regional market rate';

  const minJob = `$${resolveMinimumJob(cfg)}`;
  const scopes = (SERVICE_SCOPES[serviceType] ?? ALL_SCOPES).join(', ');
  const serviceZips = cfg.service_zips?.length ? cfg.service_zips.join(', ') : 'all areas';
  const addOnsText = cfg.add_ons?.length
    ? cfg.add_ons.map(a => `${a.name} ($${a.low}–$${a.high})`).join(', ')
    : 'Stump grinding ($125–$300), Debris haul-away ($100–$250)';

  const marketLine = cfg.market ? `\n- Market / service region: ${cfg.market}` : '';

  return `You are an AI assistant for ${businessName}, a professional tree service company.
Analyze the provided tree photos and generate a detailed estimate.

PRICING GUIDELINES FOR THIS COMPANY:
- Tree removal: ${removalRange} base range
- Trimming/pruning: ${trimmingRange} base range
- Minimum job: ${minJob}
- Price every line at STANDARD rates. Never apply an emergency, storm, or rush
  multiplier yourself and never mention emergency rates; the system applies any
  surcharge after you answer.${marketLine}
- Service area zip codes: ${serviceZips}
- Available add-ons: ${addOnsText}

If no pricing config is set, use regional market rates for the zip code provided.

You respond ONLY with valid JSON — no markdown, no prose, no explanation outside the JSON.

SCOPE. Price only the work the customer asked for. Every line item has a "scope",
and for this request the allowed scopes are: ${scopes}.
Scope meanings: "removal" = taking down a tree that is still standing.
"cleanup" = cutting up and clearing wood that is already down, including a whole
tree that has fallen, and cutting back torn stubs. "trimming" = pruning live
limbs. "haul" = hauling debris away. "stump" = stump grinding. Work the photos suggest
but the customer did not ask for (for example removing a standing tree when they
asked for storm cleanup, or a stump they did not mention) goes in
"recommended_followups" as a short plain phrase, never in line_items.

EVIDENCE. A certified arborist reads this. Every complexity factor and safety
concern must be something visible in these photos. Do not assume power lines, a
crane, structures, decay, or access limits you cannot see. One broken limb on a
tree that is otherwise standing is a cleanup job, not a catastrophe. Describe
damage exactly as it appears: if you see one split, say one split, not
"multiple broken limbs"; do not mention hanging limbs you cannot point to.

EQUIPMENT. Most residential removals are climbed and rigged. Do not recommend
or price a crane unless the photos show the tree cannot be climbed or rigged
(for example it is leaning on a house with no drop zone). A fence or a house
nearby means careful rigging, not a crane.

OAKS. Only if you name an oak in the species field with confidence of 85 or
more, say in notes that pruning wounds should be painted right away and that
pruning is best avoided February through June (oak wilt). Otherwise give no
species-specific advice.

CONDITION, chosen strictly:
- Healthy: no visible defects.
- Fair: minor defects, or one failed limb on an otherwise sound tree.
- Poor: multiple defects, significant dieback, or visible decay in the trunk.
- Hazardous: failure of what is still standing looks likely soon AND a target
  (house, vehicle, road, people) is within reach. Damage alone is not hazardous.

HEIGHT. Measure against something in frame: a privacy fence is about 6 ft, a
door about 7 ft, a single-story eave about 9-10 ft, a two-story roofline about
20-25 ft, a car about 5 ft tall. Never fall back on a typical or stock range.
In "height_basis", say exactly what you measured against and in which photo
(for example "6 ft fence in photo 2, tree about 5 fence-heights"). If the top
is out of frame or nothing gives scale, say so in height_basis and give a wide
range.

TRIMMING. Price all pruning as ONE line item with scope "trimming" whose
description names the work (for example "Prune: remove deadwood, thin the
crown, raise lower limbs over the structure"). Do not split crown cleaning,
thinning and selective pruning into separate lines; that reads as charging
three times for one job. Ball moss or other epiphytes are an observation for
the notes, not a line item.

CUTS. Pruning and cleanup cuts go to the branch collar. Never write "flush cut"
or "flush to the trunk".

When analyzing photos, assess:
1. Tree species, with an honest confidence percentage
2. Approximate height and trunk diameter
3. Overall health and structural condition
4. Proximity to structures, powerlines, fences, or other obstacles
5. Ground access difficulty (slope, confined space, equipment access)
6. Any visible hazards (dead limbs, root damage, lean, rot, cracks)

On species, be conservative. A certified arborist reads these estimates and a
wrong species call costs the company credibility. Report species_confidence as
your genuine probability the call is correct, not a hedge and not a boast. Bark,
leaf shape, branching habit and silhouette are evidence; a bare or distant tree
is usually not identifiable. Low confidence is a correct answer.

Give species_confidence as a whole percent from 0 to 100, e.g. 92. Do not use a
0.0-1.0 scale here.

If you cannot identify the tree, return species as null and species_confidence as
0. Never put the uncertainty itself in the species field: "Unidentifiable" and
"Unable to determine" are not species names.

Name the species ONLY in the species field. Everywhere else (line items, notes,
factors, concerns) call it "the tree".

Return a JSON object with this exact structure — all fields required:

{
  "species": "string — your best species call, e.g. 'Live oak'",
  "species_confidence": number from 0 to 100 (a whole percent, e.g. 92 — NOT 0.92),
  "estimated_height": "string — a range in feet from your own measurement",
  "height_basis": "string — what in which photo you measured height against, or that nothing gave scale",
  "trunk_diameter": "string — a range in inches at chest height",
  "condition": "Healthy | Fair | Poor | Hazardous",
  "complexity": "Low | Medium | High | Very High",
  "complexity_factors": ["array of plain-English strings describing what drives complexity"],
  "safety_concerns": ["array of strings — leave empty array [] if none observed"],
  "line_items": [
    {
      "description": "string — plain-English line item label",
      "scope": "one of: removal | trimming | cleanup | haul | stump | other",
      "price_low": number,
      "price_high": number
    }
  ],
  "recommended_followups": ["array of short phrases for work outside the requested scope — [] if none"],
  "total_low": number,
  "total_high": number,
  "notes": "string — 1–2 sentences with any important context or caveats for the customer"
}`;
}

// ---------------------------------------------------------------------------
// Validation prompt — checks photos before estimate
// ---------------------------------------------------------------------------
const VALIDATION_PROMPT = `You are a quality-control system for a tree service estimate tool.
Your job is to evaluate submitted photos BEFORE an estimate is generated.

Analyze all submitted photos and return ONLY valid JSON — no markdown, no prose.

Check for two things:
1. SUBJECT: Do the photos show trees, tree limbs, stumps, storm-damaged trees, or other tree-related subjects appropriate for a tree service company to estimate?
2. QUALITY: Are the photos clear enough, well-lit enough, and close enough to a tree to make a meaningful assessment? (Extremely blurry, pitch-black, or showing only sky/ground with no tree visible would fail.)

Be reasonably lenient on quality — a slightly blurry phone photo of a real tree should pass. Only reject if it's genuinely impossible to assess.

Return JSON in this exact shape:
{
  "valid": true | false,
  "confidence": number between 0.0 and 1.0,
  "subject_detected": "brief description of what is actually in the photos",
  "rejection_reason": "plain English explanation for the customer — null if valid is true"
}

Confidence threshold: if confidence is below 0.65, set valid to false.`;

async function validateImages(anthropicClient, imageBlocks) {
  const result = await anthropicClient.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 256,
    system: VALIDATION_PROMPT,
    messages: [{
      role: 'user',
      content: [
        ...imageBlocks,
        { type: 'text', text: 'Please validate these photos for a tree service estimate submission.' },
      ],
    }],
  });

  let raw = result.content[0].text.trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// User message for estimate generation
// ---------------------------------------------------------------------------
function buildUserMessage(serviceType, zip) {
  const labels = {
    removal:      'tree removal',
    trimming:     'tree trimming / pruning',
    storm_damage: 'storm damage cleanup',
    emergency:    'emergency tree service',
  };
  return `Please analyze the tree(s) shown in these photos and provide a preliminary estimate for ${labels[serviceType] || serviceType}. \
The property is in zip code ${zip}. Return only the JSON estimate as described.`;
}

// ---------------------------------------------------------------------------
// Supabase Storage photo upload
// ---------------------------------------------------------------------------
// NOTE: requires bucket 'estimate-photos' created in Supabase dashboard (private, 10MB limit)
async function uploadPhotos(images, estimateId, isDemo) {
  const folder = isDemo ? 'demo' : estimateId;
  const paths = [];
  const MAX_SIZE_BYTES = 8 * 1024 * 1024; // 8MB per photo

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const ext = img.mediaType.split('/')[1] || 'jpg';
    const path = `${folder}/${estimateId}/${i + 1}.${ext}`;
    const buffer = Buffer.from(img.data, 'base64');

    if (buffer.length > MAX_SIZE_BYTES) {
      console.warn(`Photo ${i + 1} exceeds 8MB limit (${(buffer.length / 1024 / 1024).toFixed(1)}MB), skipping`);
      continue;
    }

    const { error } = await supabase.storage
      .from('estimate-photos')
      .upload(path, buffer, { contentType: img.mediaType, upsert: true });

    if (error) {
      console.error(`Failed to upload photo ${i + 1}:`, error.message);
    } else {
      paths.push(path);
    }
  }

  return paths;
}

// ---------------------------------------------------------------------------
// Supabase logging
// ---------------------------------------------------------------------------
// NOTE: requires:
//   alter table estimates add column is_demo boolean default false;
//   alter table estimates add column photo_paths text[];
async function logEstimate(customerId, lead, estimate, photoCount, monthKey, isDemoEstimate = false, photoPaths = [], estimateId = null) {
  const insertResult = await supabase.from('estimates').insert({
    id:              estimateId || undefined,
    is_demo:         isDemoEstimate,
    customer_id:     customerId,
    homeowner_name:  lead.name,
    homeowner_email: lead.email,
    homeowner_phone: lead.phone,
    zip_code:        lead.zip,
    service_type:    lead.serviceType,
    photo_count:     photoCount,
    photo_paths:     photoPaths.length > 0 ? photoPaths : null,
    estimate_data:   estimate,
    estimate_low:    estimate.total_low,
    estimate_high:   estimate.total_high,
    month_key:       monthKey,
  });

  if (insertResult.error) {
    console.error('Failed to log estimate:', JSON.stringify(insertResult.error));
  }

  // Demo estimates don't count against tier usage limits
  if (!isDemoEstimate && customerId) {
    const rpcResult = await supabase.rpc('increment_estimate_count', {
      p_customer_id: customerId,
      p_month_key:   monthKey,
    });

    if (rpcResult.error) {
      console.error('Failed to increment usage:', rpcResult.error);
    }
  }
}

// ---------------------------------------------------------------------------
// Vercel handler config
// ---------------------------------------------------------------------------
export const config = {
  api: { bodyParser: { sizeLimit: '12mb' } },
};

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const host = req.headers.host ?? '';
  const isDemo = isDemoHost(host);
  const estimateId = randomUUID();

  // -------------------------------------------------------------------------
  // 0. Rate limit (before any paid Claude calls). Each estimate = 2 vision
  //    calls. Per-IP cap on all paths; a stricter daily cap on the demo/preview
  //    path, which has no tier limit and would otherwise be free unlimited AI.
  // -------------------------------------------------------------------------
  const ip = clientIp(req);
  const burst = await rateLimit({ bucket: 'estimate', identifier: ip, windowSeconds: 600, max: 10 });
  if (!burst.allowed) {
    return res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
  }
  if (isDemo) {
    const demoDaily = await rateLimit({ bucket: 'estimate_demo', identifier: ip, windowSeconds: 86400, max: 20 });
    if (!demoDaily.allowed) {
      return res.status(429).json({ error: 'Demo limit reached for today. Please try again tomorrow.' });
    }
  }

  // -------------------------------------------------------------------------
  // 1. Load customer config
  // -------------------------------------------------------------------------
  let customer, customerConfig;

  if (isDemo) {
    customer = DEMO_CUSTOMER;
    customerConfig = DEMO_CONFIG;
  } else {
    const subdomain = extractSubdomain(host);

    const { data, error } = await supabase
      .from('customers')
      .select('*, customer_config(*)')
      .eq('subdomain', subdomain)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'No estimate tool found for this domain.' });
    }

    customer = data;
    customerConfig = data.customer_config ?? null;

    // Reject paused / canceled tools
    if (!['trialing', 'active'].includes(customer.status)) {
      return res.status(403).json({
        error: 'This estimate tool is not currently active. Please contact the business for assistance.',
      });
    }

    // -----------------------------------------------------------------------
    // 2. Check monthly usage limit
    // -----------------------------------------------------------------------
    const monthKey = new Date().toISOString().slice(0, 7); // "2026-05"

    const { data: usage } = await supabase
      .from('monthly_usage')
      .select('estimate_count')
      .eq('customer_id', customer.id)
      .eq('month_key', monthKey)
      .single();

    const count = usage?.estimate_count ?? 0;
    const limit = TIER_LIMITS[customer.tier] ?? 50;

    if (isFinite(limit) && count >= limit) {
      return res.status(429).json({
        error: 'limit_reached',
        tier:  customer.tier,
        limit,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 3. Validate request body
  // -------------------------------------------------------------------------
  const { name, email, phone, zip, serviceType, images } = req.body ?? {};

  if (!name || !email || !phone || !zip || !serviceType || !images?.length) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (images.length > 3) {
    return res.status(400).json({ error: 'Maximum 3 images allowed.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  try {
    const anthropic = new Anthropic({ apiKey });

    const imageBlocks = images.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    }));

    // -----------------------------------------------------------------------
    // 4. Phase 1 — validate photos
    // -----------------------------------------------------------------------
    let validation;
    try {
      validation = await validateImages(anthropic, imageBlocks);
    } catch (valErr) {
      console.error('Validation parse error:', valErr);
      validation = { valid: true, confidence: 1.0 };
    }

    if (!validation.valid) {
      return res.status(422).json({
        error: validation.rejection_reason
          ?? 'We could not identify tree-related content in your photos. Please upload clear photos of the tree or damage you need assessed.',
        validation_failed: true,
        confidence:        validation.confidence,
        subject_detected:  validation.subject_detected,
      });
    }

    // -----------------------------------------------------------------------
    // 4b. Upload photos to Supabase Storage
    // -----------------------------------------------------------------------
    let photoPaths = [];
    try {
      photoPaths = await uploadPhotos(images, estimateId, isDemo);
      console.log(`Uploaded ${photoPaths.length} photos for estimate ${estimateId}`);
    } catch (err) {
      console.error('Photo upload error:', err?.message ?? err);
      // Non-fatal — continue without photos
    }

    // -----------------------------------------------------------------------
    // 5. Phase 2 — generate estimate
    // -----------------------------------------------------------------------
    const systemPrompt = buildSystemPrompt(customer, customerConfig, serviceType);

    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 2048,
      system:     systemPrompt,
      messages: [{
        role: 'user',
        content: [...imageBlocks, { type: 'text', text: buildUserMessage(serviceType, zip) }],
      }],
    });

    let estimate;
    try {
      let raw = message.content[0].text.trim();
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      estimate = JSON.parse(raw);
    } catch {
      console.error('Claude returned non-JSON:', message.content[0].text);
      return res.status(500).json({ error: 'Failed to parse estimate from AI response.' });
    }
    // A refusal or error object (no estimate fields at all) is a failed estimate.
    // A real estimate that only lacks line_items goes on to the fallback, so the
    // lead is kept.
    const looksLikeEstimate = estimate && typeof estimate === 'object' && !Array.isArray(estimate)
      && (Array.isArray(estimate.line_items) || estimate.condition || estimate.estimated_height);
    if (!looksLikeEstimate) {
      console.error('Claude returned JSON that is not an estimate object:', message.content[0].text);
      return res.status(500).json({ error: 'Failed to parse estimate from AI response.' });
    }
    applySpeciesGate(estimate);
    enforceScope(estimate, serviceType, customerConfig ?? {});

    const lead = { name, email, phone, zip, serviceType, timestamp: new Date().toISOString() };

    // -----------------------------------------------------------------------
    // 6. Log to Supabase (always log, tag demo estimates)
    // -----------------------------------------------------------------------
    const monthKey = new Date().toISOString().slice(0, 7);
    try {
      await logEstimate(customer.id, lead, estimate, images.length, monthKey, isDemo, photoPaths, estimateId);
    } catch (err) {
      console.error('logEstimate error:', err?.message ?? err);
    }

    // -----------------------------------------------------------------------
    // 6b. Generate signed URLs for photos (7-day expiry)
    // -----------------------------------------------------------------------
    let photoSignedUrls = [];
    if (photoPaths.length > 0) {
      for (const path of photoPaths) {
        const { data, error } = await supabase.storage
          .from('estimate-photos')
          .createSignedUrl(path, 604800);
        if (data?.signedUrl) {
          photoSignedUrls.push(data.signedUrl);
        } else {
          console.error('Failed to sign URL for:', path, error?.message);
        }
      }
    }

    // -----------------------------------------------------------------------
    // 7. Send email notifications
    // -----------------------------------------------------------------------
    const resendKey = process.env.RESEND_API_KEY;
    // On the demo the tester's own emails must send even if DEFAULT_BUSINESS_EMAIL
    // is unset, so the demo is gated separately from the business notification.
    if (resendKey && (customer.email || isDemo)) {
      if (customer.email) {
        try {
          await sendLeadNotificationEmail(customer, lead, estimate, photoSignedUrls, { demoCopy: isDemo });
        } catch (err) {
          console.error('Lead notification failed:', err?.message ?? err);
        }
      }
      try {
        await sendHomeownerEstimateEmail({ ...lead }, estimate, customer, { demo: isDemo });
      } catch (err) {
        console.error('Homeowner email failed:', err?.message ?? err);
      }
      // On the demo the submitter is a tree pro evaluating the product, not a
      // homeowner. The lead alert above went to us; send them a copy too so they
      // see both halves of what they'd get as a customer. Real tenants never do
      // this — their leads stay between them and the homeowner.
      const demoCopyTo = (lead.email || '').trim().toLowerCase();
      if (isDemo && demoCopyTo && demoCopyTo !== (customer.email || '').trim().toLowerCase()) {
        try {
          await sendLeadNotificationEmail(
            { ...customer, email: lead.email }, lead, estimate, photoSignedUrls, { demoCopy: isDemo },
          );
        } catch (err) {
          console.error('Demo lead copy failed:', err?.message ?? err);
        }
      }
    }

    console.log('NEW ESTIMATE:', JSON.stringify({
      subdomain: extractSubdomain(host),
      customer:  customer.company_name,
      lead:      { name, email, zip, serviceType },
      range:     `${estimate.total_low}–${estimate.total_high}`,
    }));

    // The raw model call is kept for tuning, not shown to anyone.
    const { species_raw, species_confidence_raw, ...publicEstimate } = estimate;
    return res.status(200).json({ estimate: publicEstimate });

  } catch (err) {
    console.error('Estimate error:', err);
    return res.status(500).json({ error: 'AI service error. Please try again.' });
  }
}
