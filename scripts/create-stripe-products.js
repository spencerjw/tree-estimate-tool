// Run once to create Stripe setup-fee and upgrade-fee prices.
// Usage: STRIPE_SECRET_KEY=sk_live_... node scripts/create-stripe-products.js
// Copy the printed env var lines to your Vercel dashboard.

import { getStripe } from '../lib/stripe.js';

const stripe = getStripe();

const PRODUCTS = [
  { name: 'TreeSnap Starter Setup',        envKey: 'STRIPE_SETUP_PRICE_STARTER',            amount: 29900 },
  { name: 'TreeSnap Pro Setup',            envKey: 'STRIPE_SETUP_PRICE_PRO',                amount: 39900 },
  { name: 'TreeSnap Pro+ Setup',           envKey: 'STRIPE_SETUP_PRICE_PROPLUS',            amount: 49900 },
  { name: 'TreeSnap Upgrade: Starter→Pro', envKey: 'STRIPE_UPGRADE_PRICE_STARTER_TO_PRO',   amount: 15000 },
  { name: 'TreeSnap Upgrade: Starter→Pro+',envKey: 'STRIPE_UPGRADE_PRICE_STARTER_TO_PROPLUS',amount: 25000 },
  { name: 'TreeSnap Upgrade: Pro→Pro+',    envKey: 'STRIPE_UPGRADE_PRICE_PRO_TO_PROPLUS',   amount: 12500 },
];

async function main() {
  console.log('Creating Stripe products and prices...\n');

  for (const p of PRODUCTS) {
    const product = await stripe.products.create({ name: p.name });
    const price   = await stripe.prices.create({
      product:     product.id,
      unit_amount: p.amount,
      currency:    'usd',
    });
    console.log(`${p.envKey}=${price.id}`);
  }

  console.log('\nDone. Add the lines above as Vercel environment variables.');
}

main().catch(err => { console.error(err); process.exit(1); });
