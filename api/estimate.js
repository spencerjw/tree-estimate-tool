// Vercel serverless function — proxies Claude API to keep the API key server-side.
// Receives: JSON body with { name, email, phone, zip, serviceType, images[] }
// images[]: array of { data: base64string, mediaType: "image/jpeg"|"image/png"|"image/webp" }

import Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// SYSTEM PROMPT — edit this section to tune pricing ranges or assessment logic
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are an expert arborist and estimator for a professional tree service company \
operating in Central Texas and the broader Southern US. You analyze customer-submitted photos of trees \
and produce realistic preliminary price estimates for tree services.

You respond ONLY with valid JSON — no markdown, no prose, no explanation outside the JSON.

When analyzing photos, assess:
1. Tree species (if identifiable from visual characteristics)
2. Approximate height and trunk diameter
3. Overall health and structural condition
4. Proximity to structures, powerlines, fences, or other obstacles
5. Ground access difficulty (slope, confined space, equipment access)
6. Any visible hazards (dead limbs, root damage, lean, rot, cracks)

PRICING GUIDE — Central Texas / Southern US market rates (adjust line items to match):

TREE REMOVAL:
  - Small tree (under 25 ft):          $300 – $650
  - Medium tree (25–50 ft):            $650 – $1,400
  - Large tree (50–75 ft):             $1,400 – $2,800
  - Very large tree (75 ft+):          $2,800 – $5,500
  - Near structure or powerline:       add 40–80% to base
  - Stump grinding (standard):         $125 – $300
  - Debris haul-away:                  $100 – $250

TREE TRIMMING / PRUNING:
  - Small tree (under 25 ft):          $150 – $350
  - Medium tree (25–50 ft):            $350 – $700
  - Large tree (50–75 ft):             $700 – $1,200
  - Crown thinning or raise:           add $100 – $250
  - Dead-wooding:                      included

STORM DAMAGE CLEANUP:
  - Debris removal / limb cleanup:     $250 – $600
  - Partial tree removal (split):      base removal rate × 0.6–0.8
  - Emergency tarping / board-up:      $150 – $350

EMERGENCY SERVICE (after-hours / same-day):
  - Apply 50–100% premium to all line items above
  - Minimum charge:                    $450

Return JSON in this exact shape — all fields required:

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
// ---------------------------------------------------------------------------

/**
 * Build the user-facing message that accompanies the uploaded photos.
 * @param {string} serviceType - removal | trimming | storm_damage | emergency
 * @param {string} zip - customer zip code
 */
function buildUserMessage(serviceType, zip) {
  const serviceLabels = {
    removal: 'tree removal',
    trimming: 'tree trimming / pruning',
    storm_damage: 'storm damage cleanup',
    emergency: 'emergency tree service',
  };
  const label = serviceLabels[serviceType] || serviceType;
  return `Please analyze the tree(s) shown in these photos and provide a preliminary estimate for ${label}. \
The property is located in zip code ${zip} (Central Texas / Southern US market). \
Return only the JSON estimate as described.`;
}

// ---------------------------------------------------------------------------
// Vercel serverless handler
// ---------------------------------------------------------------------------
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '12mb', // base64-encoded images can be large; 3 × ~4 MB = 12 MB max
    },
  },
};

export default async function handler(req, res) {
  // CORS headers — restrict to your own domain in production
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, phone, zip, serviceType, images } = req.body ?? {};

  // Basic input validation
  if (!name || !email || !phone || !zip || !serviceType || !images?.length) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (images.length > 3) {
    return res.status(400).json({ error: 'Maximum 3 images allowed.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set');
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  try {
    const client = new Anthropic({ apiKey });

    // Build image content blocks for Claude's vision input
    const imageBlocks = images.map((img) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: img.data,
      },
    }));

    const message = await client.messages.create({
      model: 'claude-sonnet-4-5', // upgrade to claude-sonnet-4-6 for latest version
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            ...imageBlocks,
            { type: 'text', text: buildUserMessage(serviceType, zip) },
          ],
        },
      ],
    });

    let estimate;
    try {
      // Strip markdown code fences if Claude wraps the JSON (e.g. ```json ... ```)
      let rawText = message.content[0].text.trim();
      rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      estimate = JSON.parse(rawText);
    } catch {
      const rawResp = message.content[0].text;
      console.error('Claude returned non-JSON:', rawResp);
      return res.status(500).json({ error: 'Failed to parse estimate from AI response. Raw: ' + rawResp.slice(0, 200) });
    }

    // -----------------------------------------------------------------------
    // LEAD CAPTURE — replace console.log with your webhook / CRM call
    // -----------------------------------------------------------------------
    // TODO: POST to Zapier / Make / your CRM webhook instead of console.log
    // Example:
    //   await fetch(process.env.LEAD_WEBHOOK_URL, {
    //     method: 'POST',
    //     headers: { 'Content-Type': 'application/json' },
    //     body: JSON.stringify(lead),
    //   });
    const lead = {
      timestamp: new Date().toISOString(),
      name,
      email,
      phone,
      zip,
      serviceType,
      estimateRange: `$${estimate.total_low} – $${estimate.total_high}`,
    };
    console.log('NEW LEAD:', JSON.stringify(lead, null, 2));
    // -----------------------------------------------------------------------

    return res.status(200).json({ estimate });
  } catch (err) {
    console.error('Claude API error:', err);
    return res.status(500).json({ error: 'AI service error. Please try again.' });
  }
}
