// Vercel serverless function — multi-tenant AI tree estimate.
// Detects customer from subdomain, checks limits, generates estimate, logs to Supabase.

import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../lib/supabase.js';
import { sendLeadNotificationEmail, sendHomeownerEstimateEmail } from '../lib/emails.js';

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
// Build customer-aware system prompt
// ---------------------------------------------------------------------------
function buildSystemPrompt(customer, config) {
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

  const minJob = cfg.minimum_job ? `$${cfg.minimum_job}` : '$350';
  const emergencyMult = cfg.emergency_multiplier ?? 1.5;
  const serviceZips = cfg.service_zips?.length ? cfg.service_zips.join(', ') : 'all areas';
  const addOnsText = cfg.add_ons?.length
    ? cfg.add_ons.map(a => `${a.name} ($${a.low}–$${a.high})`).join(', ')
    : 'Stump grinding ($125–$300), Debris haul-away ($100–$250)';

  return `You are an AI assistant for ${businessName}, a professional tree service company.
Analyze the provided tree photos and generate a detailed estimate.

PRICING GUIDELINES FOR THIS COMPANY:
- Tree removal: ${removalRange} base range
- Trimming/pruning: ${trimmingRange} base range
- Minimum job: ${minJob}
- Emergency service multiplier: ${emergencyMult}x standard rates
- Service area zip codes: ${serviceZips}
- Available add-ons: ${addOnsText}

If no pricing config is set, use regional market rates for the zip code provided.

You respond ONLY with valid JSON — no markdown, no prose, no explanation outside the JSON.

When analyzing photos, assess:
1. Tree species (if identifiable from visual characteristics)
2. Approximate height and trunk diameter
3. Overall health and structural condition
4. Proximity to structures, powerlines, fences, or other obstacles
5. Ground access difficulty (slope, confined space, equipment access)
6. Any visible hazards (dead limbs, root damage, lean, rot, cracks)

Return a JSON object with this exact structure — all fields required:

{
  "species": "string — identified species or 'Unable to determine from photos'",
  "estimated_height": "string — e.g. '40–50 feet'",
  "trunk_diameter": "string — e.g. '18–24 inches at chest height'",
  "condition": "Healthy | Fair | Poor | Hazardous",
  "complexity": "Low | Medium | High | Very High",
  "complexity_factors": ["array of plain-English strings describing what drives complexity"],
  "safety_concerns": ["array of strings — leave empty array [] if none observed"],
  "line_items": [
    {
      "description": "string — plain-English line item label",
      "price_low": number,
      "price_high": number
    }
  ],
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
// Supabase logging
// ---------------------------------------------------------------------------
// NOTE: requires `alter table estimates add column is_demo boolean default false;` in Supabase
async function logEstimate(customerId, lead, estimate, photoCount, monthKey, isDemoEstimate = false) {
  const insertResult = await supabase.from('estimates').insert({
    is_demo:         isDemoEstimate,
    customer_id:     customerId,
    homeowner_name:  lead.name,
    homeowner_email: lead.email,
    homeowner_phone: lead.phone,
    zip_code:        lead.zip,
    service_type:    lead.serviceType,
    photo_count:     photoCount,
    estimate_data:   estimate,
    estimate_low:    estimate.total_low,
    estimate_high:   estimate.total_high,
    month_key:       monthKey,
  });

  if (insertResult.error) {
    console.error('Failed to log estimate:', insertResult.error);
  }

  // Demo estimates don't count against tier usage limits
  if (!isDemoEstimate) {
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
    // 5. Phase 2 — generate estimate
    // -----------------------------------------------------------------------
    const systemPrompt = buildSystemPrompt(customer, customerConfig);

    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 1024,
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

    const lead = { name, email, phone, zip, serviceType, timestamp: new Date().toISOString() };

    // -----------------------------------------------------------------------
    // 6. Log to Supabase (always log, tag demo estimates)
    // -----------------------------------------------------------------------
    if (true) {
      const monthKey = new Date().toISOString().slice(0, 7);
      logEstimate(customer.id, lead, estimate, images.length, monthKey, isDemo).catch(err => {
        console.error('Background logging error:', err);
      });
    }

    // -----------------------------------------------------------------------
    // 7. Send email notifications
    // -----------------------------------------------------------------------
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey && customer.email) {
      Promise.all([
        sendLeadNotificationEmail(customer, lead, estimate),
        sendHomeownerEstimateEmail({ ...lead }, estimate, customer),
      ]).catch(err => console.error('Email send failed:', err));
    }

    console.log('NEW ESTIMATE:', JSON.stringify({
      subdomain: extractSubdomain(host),
      customer:  customer.company_name,
      lead:      { name, email, zip, serviceType },
      range:     `${estimate.total_low}–${estimate.total_high}`,
    }));

    return res.status(200).json({ estimate });

  } catch (err) {
    console.error('Estimate error:', err);
    return res.status(500).json({ error: 'AI service error. Please try again.' });
  }
}
