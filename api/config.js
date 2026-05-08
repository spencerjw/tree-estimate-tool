// Returns public branding config for the current subdomain.
// Used by the frontend to update the header with the customer's business name.

import { supabase } from '../lib/supabase.js';

function isDemoHost(host) {
  const sub = host.split('.')[0].toLowerCase();
  return (
    sub === 'demo' ||
    host.includes('localhost') ||
    host.includes('127.0.0.1') ||
    host.includes('vercel.app')
  );
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=60');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const host = req.headers.host ?? '';

  if (isDemoHost(host)) {
    return res.status(200).json({ businessName: 'TreePro Demo', phone: '' });
  }

  const subdomain = host.split('.')[0].toLowerCase();

  const { data: customer } = await supabase
    .from('customers')
    .select('business_name, company_name, phone, status, customer_config(theme)')
    .eq('subdomain', subdomain)
    .single();

  if (!customer) {
    return res.status(404).json({ error: 'Not found' });
  }

  return res.status(200).json({
    businessName: customer.business_name || customer.company_name || 'Tree Service',
    phone:        customer.phone || '',
    status:       customer.status,
    theme:        customer.customer_config?.theme || 'forest-green',
  });
}
