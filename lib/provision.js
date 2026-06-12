// Customer provisioning — called from stripe-webhook after setup-fee payment.
// Sequence: Cloudflare CNAME → Vercel domain → Stripe customer + subscription
//           → Supabase customers row → Supabase customer_config row
//           → mark lead provisioned → send welcome + activation emails.
// CRITICAL: every async call is awaited — no fire-and-forget.
//
// IDEMPOTENCY: Stripe retries webhooks for up to ~3 days, so provisionCustomer
// must be safe to re-run after a partial failure without creating duplicate
// Stripe customers/subscriptions or wedging the customer. Every step is
// individually find-or-create so the function fully resumes from any point:
//   - Cloudflare/Vercel: real "already exists" responses are ignored.
//   - Stripe customer: find-or-create by metadata search + a deterministic
//     idempotency key (key covers the <24h fast-retry window, search the rest).
//   - Stripe subscription: reuse the customer's existing live subscription on
//     the right price, else create with an idempotency key.
//   - Supabase customers: select-first, insert if absent; a concurrent-delivery
//     unique violation falls back to re-selecting the row.
//   - Supabase customer_config: upsert on customer_id so a retry re-runs cleanly.
//   - Emails are best-effort — a send failure must not 500 and trigger a retry.
// NOTE: there is intentionally NO early-return "already provisioned" guard.
// customers is inserted before customer_config, so returning early on a
// customers-row hit would skip config on a retry and leave a broken tenant.
// The webhook caller already skips when lead.status === 'provisioned'.

import { supabase } from './supabase.js';
import { getStripe } from './stripe.js';
import { sendWelcomeEmail, sendActivationEmail } from './emails.js';

const CLOUDFLARE_ZONE  = process.env.CLOUDFLARE_ZONE_ID;
const VERCEL_PROJECT   = process.env.VERCEL_PROJECT_ID;
const TREESNAP_TARGET  = 'cname.vercel-dns.com';

const MONTHLY_PRICE_IDS = {
  starter: 'price_1TUradGTb7xBM80FK2OjcI5D',  // $79/mo
  pro:     'price_1TUracGTb7xBM80FNCyGv4Hp',  // $129/mo
  proplus: 'price_1TUrafGTb7xBM80FVV4J21Cr',  // $179/mo
};

async function addCloudflareCname(subdomain) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const resp  = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE}/dns_records`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type:    'CNAME',
        name:    subdomain,
        content: TREESNAP_TARGET,
        proxied: false,
        ttl:     1,
      }),
    }
  );
  const data = await resp.json();
  if (!data.success) {
    // Ignore "record already exists" — idempotent on retry
    const isDupe = data.errors?.some(e => e.code === 81057);
    if (!isDupe) throw new Error(`Cloudflare: ${JSON.stringify(data.errors)}`);
  }
}

async function addVercelDomain(subdomain) {
  const token  = process.env.VERCEL_API_TOKEN;
  const domain = `${subdomain}.treesnap.cloud`;
  const resp   = await fetch(
    `https://api.vercel.com/v10/projects/${VERCEL_PROJECT}/domains`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: domain }),
    }
  );
  const data = await resp.json();
  if (resp.status >= 400 && data.error?.code !== 'domain_already_in_use') {
    throw new Error(`Vercel: ${JSON.stringify(data.error)}`);
  }
}

// Find an existing Stripe customer tagged with this subdomain, else create one.
// The metadata search catches orphans from attempts older than the 24h
// idempotency-key TTL; the key catches fast retries before search is consistent.
export async function findOrCreateStripeCustomer(stripe, lead) {
  // Prefer the id already stored on the lead (set in onboarding when the setup-fee
  // customer + card-on-file was created). This guarantees provisioning creates the
  // subscription on the SAME customer the webhook set the default payment method on,
  // instead of risking a different match from the eventually-consistent search below.
  if (lead.stripe_customer_id) {
    try {
      const existing = await stripe.customers.retrieve(lead.stripe_customer_id);
      if (existing && !existing.deleted) return existing;
    } catch {
      // Stored id is stale/unretrievable — fall through to search/create.
    }
  }

  const found = await stripe.customers.search({
    query: `metadata['subdomain']:'${lead.subdomain}'`,
    limit: 1,
  });
  if (found.data.length) return found.data[0];

  return stripe.customers.create(
    {
      email:    lead.email,
      name:     lead.company,
      metadata: { subdomain: lead.subdomain, tier: lead.tier },
    },
    { idempotencyKey: `treesnap-cust-${lead.id}` }
  );
}

// Reuse the customer's existing subscription if a prior attempt already created
// a live one on the correct price, else create it. Skips terminal-status subs
// (canceled / incomplete_expired) so a retry never adopts a dead subscription.
// Idempotency key guards the fast-retry window.
async function findOrCreateSubscription(stripe, stripeCustomerId, priceId, trialEnd, leadId) {
  const existing = await stripe.subscriptions.list({
    customer: stripeCustomerId, status: 'all', limit: 100,
  });
  const reusable = existing.data.find(
    s => !['canceled', 'incomplete_expired'].includes(s.status)
      && s.items.data.some(i => i.price.id === priceId)
  );

  // The card the customer saved during the setup-fee checkout, which the
  // stripe-webhook set as the customer's default before provisioning runs. The
  // 14-day trial-end invoice is charged off-session (nobody is at a checkout page),
  // so the subscription needs this pinned or the charge falls through to "no
  // payment method". A DeletedCustomer has no invoice_settings → leave it undefined.
  const fullCustomer = await stripe.customers.retrieve(stripeCustomerId);
  const defaultPm = (fullCustomer && !fullCustomer.deleted)
    ? (fullCustomer.invoice_settings?.default_payment_method ?? undefined)
    : undefined;

  if (reusable) {
    // A prior attempt created this sub before the card was pinned (e.g. the
    // webhook PM-set failed/raced on the first delivery). Backfill so trial-end
    // can still auto-charge; if the patch fails, the existing sub still stands.
    if (defaultPm && !reusable.default_payment_method) {
      try {
        return await stripe.subscriptions.update(reusable.id, { default_payment_method: defaultPm });
      } catch {
        return reusable;
      }
    }
    return reusable;
  }

  return stripe.subscriptions.create(
    {
      customer:               stripeCustomerId,
      items:                  [{ price: priceId }],
      trial_end:              trialEnd,
      default_payment_method: defaultPm,
      payment_settings:       { save_default_payment_method: 'on_subscription' },
    },
    { idempotencyKey: `treesnap-sub-${leadId}` }
  );
}

// Mark the originating lead provisioned + onboarding-complete. Idempotent.
async function markLeadProvisioned(leadId, stripeCustomerId) {
  await supabase
    .from('leads')
    .update({
      status:                  'provisioned',
      stripe_customer_id:      stripeCustomerId,
      onboarding_completed_at: new Date().toISOString(),
    })
    .eq('id', leadId);
}

export async function provisionCustomer(lead) {
  const stripe = getStripe();

  const priceId = MONTHLY_PRICE_IDS[lead.tier];
  if (!priceId) throw new Error(`Unknown tier: ${lead.tier}`);

  // 1. Cloudflare CNAME (idempotent — ignores "record already exists")
  await addCloudflareCname(lead.subdomain);

  // 2. Vercel domain (idempotent — ignores "domain_already_in_use")
  await addVercelDomain(lead.subdomain);

  // 3. Stripe customer (find-or-create — never duplicates on retry)
  const stripeCustomer = await findOrCreateStripeCustomer(stripe, lead);

  // 4. Stripe subscription with 14-day trial (reused if already created)
  const trialEnd     = Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60;
  const subscription = await findOrCreateSubscription(
    stripe, stripeCustomer.id, priceId, trialEnd, lead.id
  );

  const trialEndIso = new Date(trialEnd * 1000).toISOString();
  const now         = new Date().toISOString();

  // 5. Supabase customers row — select-first so a retry reuses the prior row and
  //    continues to config/lead-mark instead of stopping. prefer names/phone
  //    from onboarding config if set.
  const cfg = lead.onboarding_config ?? {};
  const businessName = cfg.business_name || lead.company;
  const phone        = cfg.phone         || lead.phone;

  let { data: customer } = await supabase
    .from('customers').select('*').eq('subdomain', lead.subdomain).maybeSingle();

  if (!customer) {
    const { data: inserted, error: custError } = await supabase
      .from('customers')
      .insert({
        company_name:           businessName,
        business_name:          businessName,
        owner_name:             lead.name,
        email:                  lead.email,
        phone,
        subdomain:              lead.subdomain,
        tier:                   lead.tier,
        status:                 'trialing',
        stripe_customer_id:     stripeCustomer.id,
        stripe_subscription_id: subscription.id,
        trial_end:              trialEndIso,
        current_period_start:   now,
        current_period_end:     trialEndIso,
      })
      .select()
      .single();

    if (custError) {
      // A concurrent webhook delivery may have inserted this subdomain's row
      // between our select and insert (Postgres unique violation = 23505).
      // Re-select by subdomain and continue. If nothing matches the subdomain,
      // the 23505 is a genuine cross-lead conflict (a different lead already
      // holds this email / Stripe id) — that must fail loudly, not be adopted.
      if (custError.code === '23505') {
        const { data: raced } = await supabase
          .from('customers').select('*').eq('subdomain', lead.subdomain).maybeSingle();
        if (!raced) throw new Error(`Supabase customers insert (cross-lead unique conflict): ${custError.message}`);
        customer = raced;
      } else {
        throw new Error(`Supabase customers insert: ${custError.message}`);
      }
    } else {
      customer = inserted;
    }
  }

  // 6. Supabase customer_config row — upsert so a retry after a partial failure
  //    re-runs cleanly (unique on customer_id).
  const { error: configError } = await supabase.from('customer_config').upsert({
    customer_id:             customer.id,
    base_rate_removal_low:   cfg.removal_low    ?? 300,
    base_rate_removal_high:  cfg.removal_high   ?? 5500,
    base_rate_trimming_low:  cfg.trimming_low   ?? 150,
    base_rate_trimming_high: cfg.trimming_high  ?? 1200,
    emergency_multiplier:    cfg.emergency_multiplier ?? 1.5,
    minimum_job:             cfg.minimum_job    ?? 350,
    market:                  cfg.market         ?? null,
    service_zips:            cfg.service_zips   ?? [],
    add_ons:                 cfg.add_ons        ?? [],
    theme:                   cfg.theme          ?? 'forest-green',
    custom_disclaimer:       cfg.custom_disclaimer ?? null,
  }, { onConflict: 'customer_id' });

  if (configError) throw new Error(`Supabase customer_config upsert: ${configError.message}`);

  // 7. Mark lead as provisioned + onboarding complete.
  //    onboarding_completed_at is set HERE (post-payment), not in the onboarding
  //    POST, so a customer who abandons at Stripe checkout can resume their link.
  await markLeadProvisioned(lead.id, stripeCustomer.id);

  // 8. Welcome + activation emails — best-effort. The customer is fully
  //    provisioned by now; an email failure must not 500 and re-trigger the
  //    whole webhook. Log and move on.
  try {
    await sendWelcomeEmail({ ...customer, trial_end: trialEndIso });
    await sendActivationEmail(customer);
  } catch (emailErr) {
    console.error(`Provision: welcome/activation email failed for ${customer.subdomain}:`, emailErr);
  }

  return customer;
}
