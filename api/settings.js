// Rates and colors settings for a tree pro (no login; see lib/billing-link.js).
//
// GET  /api/settings?c&e&s   signed link -> form prefilled with the shop's current config
// POST /api/settings         form submit (signed fields travel as hidden inputs) -> save
//
// Only rates (removal, trimming, minimum job, emergency upcharge) and the color
// theme can change here. Validation matches the admin edit-config action.

import { supabase } from '../lib/supabase.js';
import { verifySettingsLink } from '../lib/billing-link.js';

// Keys the shop page understands (js/app.js THEMES + the default).
export const THEMES = [
  ['forest-green', 'Forest Green'],
  ['deep-navy', 'Deep Navy'],
  ['slate-gray', 'Slate Gray'],
  ['burnt-orange', 'Burnt Orange'],
  ['burgundy-red', 'Burgundy Red'],
  ['charcoal-black', 'Charcoal Black'],
];
const MULTIPLIERS = ['1.25', '1.5', '1.75', '2'];

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shell(res, status, title, body) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  return res.status(status).send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:520px;margin:32px auto;padding:0 16px;color:#1f2937;line-height:1.5}
  h1{font-size:22px;color:#166534;margin:0 0 4px} .sub{color:#6b7280;margin:0 0 20px}
  fieldset{border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin:0 0 16px}
  legend{font-weight:600;padding:0 6px} label{display:block;font-size:14px;margin:8px 0 4px}
  .row{display:flex;gap:12px} .row>div{flex:1}
  input,select{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:6px;font-size:16px}
  .themes label{display:flex;align-items:center;gap:8px;margin:6px 0;font-size:15px} .themes input{width:auto}
  button{background:#166534;color:#fff;border:0;border-radius:6px;padding:12px 24px;font-size:16px;font-weight:700;cursor:pointer}
  .err{background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;padding:10px 14px;border-radius:6px;margin:0 0 16px}
  .ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;padding:10px 14px;border-radius:6px;margin:0 0 16px}
</style></head><body>${body}
<p style="color:#6b7280;font-size:14px;margin-top:24px">Questions? <a href="mailto:hello@treesnap.cloud">hello@treesnap.cloud</a></p></body></html>`);
}

async function load(customerId) {
  const { data: customer } = await supabase
    .from('customers')
    .select('id, subdomain, business_name, company_name, status')
    .eq('id', customerId)
    .single();
  if (!customer) return {};
  const { data: config } = await supabase
    .from('customer_config')
    .select('*')
    .eq('customer_id', customerId)
    .maybeSingle();
  return { customer, config: config ?? {} };
}

function form(customer, cfg, link, { error = null, saved = false } = {}) {
  const name = customer.business_name || customer.company_name || customer.subdomain;
  const theme = THEMES.some(([k]) => k === cfg.theme) ? cfg.theme : (cfg.theme === 'charcoal' ? 'charcoal-black' : 'forest-green');
  const mult = String(Number(cfg.emergency_multiplier ?? 1.5));
  const money = (id, label, value) => `<div><label for="${id}">${label}</label>
    <input id="${id}" name="${id}" type="number" inputmode="numeric" min="0" step="1" value="${esc(value ?? '')}" required></div>`;
  return `<h1>${esc(name)}</h1>
<p class="sub">Rates and colors for ${esc(customer.subdomain)}.treesnap.cloud</p>
${saved ? '<p class="ok">Saved. New estimates use these rates and colors from now on.</p>' : ''}
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/api/settings">
  <input type="hidden" name="c" value="${esc(link.c)}"><input type="hidden" name="e" value="${esc(link.e)}"><input type="hidden" name="s" value="${esc(link.s)}">
  <fieldset><legend>Tree removal</legend><div class="row">
    ${money('removal_low', 'Low end ($)', cfg.base_rate_removal_low)}${money('removal_high', 'High end ($)', cfg.base_rate_removal_high)}</div></fieldset>
  <fieldset><legend>Trimming / pruning</legend><div class="row">
    ${money('trimming_low', 'Low end ($)', cfg.base_rate_trimming_low)}${money('trimming_high', 'High end ($)', cfg.base_rate_trimming_high)}</div></fieldset>
  <fieldset><legend>Other</legend><div class="row">
    <div><label for="minimum_job">Minimum job ($)</label>
      <input id="minimum_job" name="minimum_job" type="number" inputmode="numeric" min="0" step="1" value="${esc(cfg.minimum_job ?? 350)}"></div>
    <div><label for="emergency_multiplier">Emergency upcharge</label><select id="emergency_multiplier" name="emergency_multiplier">
      ${MULTIPLIERS.map(m => `<option value="${m}"${Number(m) === Number(mult) ? ' selected' : ''}>${m}× standard rate</option>`).join('')}
    </select></div></div></fieldset>
  <fieldset class="themes"><legend>Colors</legend>
    ${THEMES.map(([k, label]) => `<label><input type="radio" name="theme" value="${k}"${k === theme ? ' checked' : ''}> ${label}</label>`).join('')}
  </fieldset>
  <button type="submit">Save</button>
</form>`;
}

// Same rules as the admin edit-config action.
export function validateSettings(body) {
  const num = v => (v === '' || v === undefined || v === null ? null : Number(v));
  const f = {
    base_rate_removal_low:   num(body.removal_low),
    base_rate_removal_high:  num(body.removal_high),
    base_rate_trimming_low:  num(body.trimming_low),
    base_rate_trimming_high: num(body.trimming_high),
    minimum_job:             num(body.minimum_job),
    emergency_multiplier:    num(body.emergency_multiplier),
    theme:                   String(body.theme ?? ''),
  };
  for (const k of ['base_rate_removal_low', 'base_rate_removal_high', 'base_rate_trimming_low', 'base_rate_trimming_high']) {
    if (f[k] === null || !Number.isFinite(f[k]) || f[k] < 0) return { error: 'Enter every rate as a whole dollar amount.' };
  }
  if (f.base_rate_removal_low >= f.base_rate_removal_high) return { error: 'Removal low end must be below the high end.' };
  if (f.base_rate_trimming_low >= f.base_rate_trimming_high) return { error: 'Trimming low end must be below the high end.' };
  if (f.minimum_job === null) f.minimum_job = 0;
  if (!Number.isFinite(f.minimum_job) || f.minimum_job < 0) return { error: 'Minimum job must be zero or more.' };
  if (!MULTIPLIERS.map(Number).includes(f.emergency_multiplier)) return { error: 'Pick an emergency upcharge from the list.' };
  if (!THEMES.some(([k]) => k === f.theme)) return { error: 'Pick a color.' };
  return { fields: f };
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const link = req.method === 'POST' ? (req.body ?? {}) : (req.query ?? {});
  const customerId = verifySettingsLink(link);
  if (!customerId) {
    return shell(res, 403, 'This link has expired',
      '<h1>This link has expired</h1><p>Reply to any TreeSnap email and we will send a new one.</p>');
  }
  const { customer, config } = await load(customerId);
  if (!customer) return shell(res, 404, 'Not found', '<h1>Shop not found</h1>');
  if (customer.status === 'canceled') {
    return shell(res, 200, 'Account closed', '<h1>This account is closed</h1><p>Reply to any TreeSnap email to restart it.</p>');
  }

  if (req.method === 'GET') return shell(res, 200, 'Rates and colors', form(customer, config, link));

  const { fields, error } = validateSettings(req.body ?? {});
  if (error) {
    // Re-show what they typed, mapped onto the stored column names.
    const b = req.body ?? {};
    const typed = { base_rate_removal_low: b.removal_low, base_rate_removal_high: b.removal_high,
      base_rate_trimming_low: b.trimming_low, base_rate_trimming_high: b.trimming_high,
      minimum_job: b.minimum_job, emergency_multiplier: b.emergency_multiplier, theme: b.theme };
    return shell(res, 400, 'Rates and colors', form(customer, { ...config, ...typed }, link, { error }));
  }
  const { error: dbErr } = await supabase.from('customer_config').update(fields).eq('customer_id', customer.id);
  if (dbErr) {
    console.error('Settings save failed:', dbErr.message);
    return shell(res, 500, 'Rates and colors', form(customer, config, link, { error: 'Could not save just now. Try again in a minute.' }));
  }
  return shell(res, 200, 'Rates and colors', form(customer, { ...config, ...fields }, link, { saved: true }));
}
