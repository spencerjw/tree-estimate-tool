// Vercel serverless function — proxies Claude API to keep the API key server-side.
// Receives: JSON body with { name, email, phone, zip, serviceType, images[] }
// images[]: array of { data: base64string, mediaType: "image/jpeg"|"image/png"|"image/webp" }

import Anthropic from '@anthropic-ai/sdk';
import { Resend } from 'resend';
import path from 'path';
import { readFileSync } from 'fs';

// ---------------------------------------------------------------------------
// CLIENT CONFIG LOADER
// Reads subdomain from request host header, loads matching clients/*.json
// Falls back to clients/default.json if no match found
// ---------------------------------------------------------------------------
function loadClientConfig(host) {
  const subdomain = host?.split('.')[0] ?? 'default';
  const candidates = [subdomain, 'default'];

  for (const name of candidates) {
    try {
      const filePath = path.join(process.cwd(), 'clients', `${name}.json`);
      return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      // try next
    }
  }
  // Absolute fallback
  return {
    businessName: 'TreeSnap',
    businessEmail: process.env.DEFAULT_BUSINESS_EMAIL ?? '',
    fromName: 'TreeSnap Estimator',
    fromEmail: 'estimates@treesnap.cloud',
    market: 'Central Texas',
    smsEnabled: false,
    zapierWebhook: null,
    tier: 'starter',
  };
}

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
// EMAIL TEMPLATES
// ---------------------------------------------------------------------------
function formatMoney(n) {
  return '$' + Number(n).toLocaleString('en-US');
}

function serviceLabel(serviceType) {
  const map = {
    removal: 'Tree Removal',
    trimming: 'Trimming / Pruning',
    storm_damage: 'Storm Damage Cleanup',
    emergency: 'Emergency Service',
  };
  return map[serviceType] || serviceType;
}

function buildLineItemsHtml(lineItems) {
  return lineItems.map(item => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${item.description}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;">
        ${formatMoney(item.price_low)} – ${formatMoney(item.price_high)}
      </td>
    </tr>`).join('');
}

// Email to business owner: new lead notification
function buildBusinessEmail(client, lead, estimate) {
  const service = serviceLabel(lead.serviceType);
  return {
    from: `${client.fromName} <${client.fromEmail}>`,
    to: client.businessEmail,
    replyTo: lead.email,
    subject: `New Lead: ${lead.name} — ${service} — ${formatMoney(estimate.total_low)}–${formatMoney(estimate.total_high)}`,
    html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#111;">
  <div style="background:#2d6a2d;padding:24px 32px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:20px;">New Lead from ${client.businessName} Estimator</h1>
  </div>
  <div style="padding:24px 32px;background:#f9fafb;border:1px solid #e5e7eb;border-top:none;">
    <h2 style="margin:0 0 16px;font-size:16px;color:#374151;">Customer Info</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr><td style="padding:6px 0;color:#6b7280;width:120px;">Name</td><td style="padding:6px 0;font-weight:600;">${lead.name}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Phone</td><td style="padding:6px 0;font-weight:600;"><a href="tel:${lead.phone}" style="color:#2d6a2d;">${lead.phone}</a></td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Email</td><td style="padding:6px 0;font-weight:600;"><a href="mailto:${lead.email}" style="color:#2d6a2d;">${lead.email}</a></td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Zip Code</td><td style="padding:6px 0;">${lead.zip}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Service</td><td style="padding:6px 0;">${service}</td></tr>
    </table>

    <h2 style="margin:0 0 16px;font-size:16px;color:#374151;">Estimate Shown to Customer</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:8px;background:#fff;border:1px solid #e5e7eb;border-radius:6px;">
      ${buildLineItemsHtml(estimate.line_items)}
      <tr style="background:#f0fdf4;">
        <td style="padding:10px 12px;font-weight:700;">Total Estimate</td>
        <td style="padding:10px 12px;font-weight:700;text-align:right;color:#2d6a2d;">
          ${formatMoney(estimate.total_low)} – ${formatMoney(estimate.total_high)}
        </td>
      </tr>
    </table>
    <p style="font-size:13px;color:#6b7280;margin:8px 0 24px;">
      Tree: ${estimate.species} | Height: ${estimate.estimated_height} | Condition: ${estimate.condition} | Complexity: ${estimate.complexity}
    </p>

    ${estimate.safety_concerns?.length ? `
    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:12px 16px;margin-bottom:24px;">
      <strong style="color:#dc2626;">Safety Concerns Flagged:</strong>
      <ul style="margin:8px 0 0;padding-left:20px;color:#dc2626;">
        ${estimate.safety_concerns.map(c => `<li>${c}</li>`).join('')}
      </ul>
    </div>` : ''}

    <p style="color:#374151;margin:0;">
      <strong>AI Notes:</strong> ${estimate.notes}
    </p>
  </div>
  <div style="padding:16px 32px;background:#f3f4f6;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;font-size:12px;color:#9ca3af;">
    Sent by TreeSnap &bull; Preliminary estimate only — subject to in-person assessment
  </div>
</div>`,
  };
}

// Email to customer: estimate confirmation
function buildCustomerEmail(client, lead, estimate) {
  const service = serviceLabel(lead.serviceType);
  return {
    from: `${client.fromName} <${client.fromEmail}>`,
    to: lead.email,
    replyTo: client.businessEmail,
    subject: `Your Tree Estimate from ${client.businessName}`,
    html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#111;">
  <div style="background:#2d6a2d;padding:24px 32px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:20px;">Your Estimate is Ready</h1>
    <p style="color:#bbf7d0;margin:8px 0 0;font-size:14px;">${client.businessName}</p>
  </div>
  <div style="padding:24px 32px;background:#fff;border:1px solid #e5e7eb;border-top:none;">
    <p style="margin:0 0 20px;">Hi ${lead.name.split(' ')[0]}, here's the preliminary estimate for your <strong>${service}</strong> request.</p>

    <table style="width:100%;border-collapse:collapse;margin-bottom:8px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
      ${buildLineItemsHtml(estimate.line_items)}
      <tr style="background:#f0fdf4;">
        <td style="padding:10px 12px;font-weight:700;">Estimated Total</td>
        <td style="padding:10px 12px;font-weight:700;text-align:right;color:#2d6a2d;">
          ${formatMoney(estimate.total_low)} – ${formatMoney(estimate.total_high)}
        </td>
      </tr>
    </table>

    <p style="font-size:13px;color:#6b7280;margin:8px 0 24px;">
      Based on: ${estimate.species} | ${estimate.estimated_height} | Condition: ${estimate.condition}
    </p>

    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:16px 20px;margin-bottom:24px;">
      <p style="margin:0;font-size:14px;color:#166534;">${estimate.notes}</p>
    </div>

    <div style="background:#fefce8;border:1px solid #fde68a;border-radius:6px;padding:12px 16px;margin-bottom:24px;font-size:13px;color:#92400e;">
      <strong>Disclaimer:</strong> This is a preliminary estimate based on submitted photos only. Final pricing is subject to an in-person assessment.
    </div>

    <div style="text-align:center;margin-top:8px;">
      <p style="margin:0 0 16px;font-weight:600;">Ready to book your free on-site visit?</p>
      ${client.businessPhone ? `<a href="tel:${client.businessPhone}" style="display:inline-block;background:#2d6a2d;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:16px;">Call ${client.businessPhone}</a>` : ''}
      ${client.businessEmail ? `<p style="margin:12px 0 0;font-size:13px;color:#6b7280;">Or email us at <a href="mailto:${client.businessEmail}" style="color:#2d6a2d;">${client.businessEmail}</a></p>` : ''}
    </div>
  </div>
  <div style="padding:16px 32px;background:#f3f4f6;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;font-size:12px;color:#9ca3af;">
    Powered by TreeSnap &bull; This estimate was generated by AI based on your submitted photos
  </div>
</div>`,
  };
}

// ---------------------------------------------------------------------------
// User message builder
// ---------------------------------------------------------------------------
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
      sizeLimit: '12mb',
    },
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Load client config based on subdomain
  const host = req.headers.host ?? '';
  const clientConfig = loadClientConfig(host);

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
    const client = new Anthropic({ apiKey });

    const imageBlocks = images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    }));

    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [...imageBlocks, { type: 'text', text: buildUserMessage(serviceType, zip) }],
      }],
    });

    let estimate;
    try {
      let rawText = message.content[0].text.trim();
      rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      estimate = JSON.parse(rawText);
    } catch {
      const rawResp = message.content[0].text;
      console.error('Claude returned non-JSON:', rawResp);
      return res.status(500).json({ error: 'Failed to parse estimate from AI response.' });
    }

    const lead = { timestamp: new Date().toISOString(), name, email, phone, zip, serviceType };

    // -----------------------------------------------------------------------
    // EMAIL NOTIFICATIONS via Resend
    // -----------------------------------------------------------------------
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey && clientConfig.businessEmail) {
      try {
        const resend = new Resend(resendKey);

        // Fire both emails in parallel
        await Promise.all([
          resend.emails.send(buildBusinessEmail(clientConfig, lead, estimate)),
          resend.emails.send(buildCustomerEmail(clientConfig, lead, estimate)),
        ]);
        console.log('Emails sent for lead:', name);
      } catch (emailErr) {
        // Don't fail the request if email fails — log and continue
        console.error('Email send failed:', emailErr);
      }
    }

    // -----------------------------------------------------------------------
    // ZAPIER WEBHOOK (Pro+ tier)
    // -----------------------------------------------------------------------
    if (clientConfig.zapierWebhook) {
      try {
        await fetch(clientConfig.zapierWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...lead,
            estimateRange: `${formatMoney(estimate.total_low)} – ${formatMoney(estimate.total_high)}`,
            businessName: clientConfig.businessName,
          }),
        });
      } catch (webhookErr) {
        console.error('Zapier webhook failed:', webhookErr);
      }
    }

    console.log('NEW LEAD:', JSON.stringify({ ...lead, estimateRange: `${estimate.total_low}–${estimate.total_high}` }));

    return res.status(200).json({ estimate });
  } catch (err) {
    console.error('Claude API error:', err);
    return res.status(500).json({ error: 'AI service error. Please try again.' });
  }
}
