// Customer provisioning — called from stripe-webhook after setup-fee payment.
// Sequence: Cloudflare CNAME → Vercel domain → Stripe customer + subscription
//           → Supabase customers row → Supabase customer_config row
//           → mark lead provisioned → send welcome + activation emails.
// CRITICAL: every async call is awaited — no fire-and-forget.

import Stripe from 'stripe';
import { supabase } from './supabase.js';
import { sendWelcomeEmail, sendActivationEmail } from './emails.js';

const CLOUDFLARE_ZONE  = '12db7968100781b690956e8b8b12cd7f';
const VERCEL_PROJECT   = 'prj_PCyJmYARqA1sFbPfdKgPz8634Xhh';
const TREESNAP_TARGET  = 'treesnap-main.vercel.app';

const MONTHLY_PRICE_IDS = {
  starter: 'price_1TUSnhK2K8Vtuj3t4JNdUWpH',
  pro:     'price_1TUSniK2K8Vtuj3tuy9DaHtP',
  proplus: 'price_1TUSniK2K8Vtuj3tfZTjKOPH',
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

export async function provisionCustomer(lead) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  // 1. Cloudflare CNAME
  await addCloudflareCname(lead.subdomain);

  // 2. Vercel domain
  await addVercelDomain(lead.subdomain);

  // 3. Stripe customer
  const stripeCustomer = await stripe.customers.create({
    email:    lead.email,
    name:     lead.company,
    metadata: { subdomain: lead.subdomain, tier: lead.tier },
  });

  // 4. Stripe subscription with 30-day trial
  const trialEnd   = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  const priceId    = MONTHLY_PRICE_IDS[lead.tier];
  if (!priceId) throw new Error(`Unknown tier: ${lead.tier}`);

  const subscription = await stripe.subscriptions.create({
    customer:         stripeCustomer.id,
    items:            [{ price: priceId }],
    trial_end:        trialEnd,
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
  });

  const trialEndIso = new Date(trialEnd * 1000).toISOString();
  const now         = new Date().toISOString();

  // 5. Supabase customers row
  const { data: customer, error: custError } = await supabase
    .from('customers')
    .insert({
      company_name:           lead.company,
      business_name:          lead.company,
      owner_name:             lead.name,
      email:                  lead.email,
      phone:                  lead.phone,
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

  if (custError) throw new Error(`Supabase customers insert: ${custError.message}`);

  // 6. Supabase customer_config row (sensible defaults)
  const { error: configError } = await supabase.from('customer_config').insert({
    customer_id:             customer.id,
    base_rate_removal_low:   300,
    base_rate_removal_high:  5500,
    base_rate_trimming_low:  150,
    base_rate_trimming_high: 1200,
    emergency_multiplier:    1.5,
    minimum_job:             350,
    service_zips:            [],
    add_ons:                 [],
  });

  if (configError) throw new Error(`Supabase customer_config insert: ${configError.message}`);

  // 7. Mark lead as provisioned
  await supabase
    .from('leads')
    .update({ status: 'provisioned', stripe_customer_id: stripeCustomer.id })
    .eq('id', lead.id);

  // 8. Welcome + activation emails
  await sendWelcomeEmail({ ...customer, trial_end: trialEndIso });
  await sendActivationEmail(customer);

  return customer;
}
