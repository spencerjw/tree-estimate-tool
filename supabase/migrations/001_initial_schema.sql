-- TreeSnap initial schema
-- Run this in the Supabase SQL editor for project: yhsthbjldvnotlfyesxe

-- ============================================================
-- TABLES
-- ============================================================

create table customers (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  company_name text not null,
  owner_name text not null,
  email text not null unique,
  phone text,
  subdomain text not null unique,
  tier text not null check (tier in ('starter', 'pro', 'proplus')),
  status text not null default 'trialing' check (status in ('trialing', 'active', 'past_due', 'paused', 'canceled')),
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  trial_start timestamptz default now(),
  trial_end timestamptz default (now() + interval '14 days'),
  trial_extended boolean default false,
  current_period_start timestamptz,
  current_period_end timestamptz,
  logo_url text,
  business_name text
);

create table customer_config (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete cascade unique,
  base_rate_removal_low integer,
  base_rate_removal_high integer,
  base_rate_trimming_low integer,
  base_rate_trimming_high integer,
  emergency_multiplier numeric default 1.5,
  minimum_job integer default 350,
  service_zips text[],
  add_ons jsonb,
  custom_disclaimer text,
  updated_at timestamptz default now()
);

create table estimates (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  customer_id uuid references customers(id) on delete cascade,
  homeowner_name text,
  homeowner_email text,
  homeowner_phone text,
  zip_code text,
  service_type text,
  photo_count integer,
  estimate_data jsonb,
  estimate_low integer,
  estimate_high integer,
  month_key text
);

create table monthly_usage (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete cascade,
  month_key text not null,
  estimate_count integer default 0,
  unique(customer_id, month_key)
);

create table email_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  customer_id uuid references customers(id) on delete cascade,
  email_type text not null,
  recipient text not null,
  status text default 'sent'
);

-- ============================================================
-- INDEXES
-- ============================================================

create index idx_customers_subdomain on customers(subdomain);
create index idx_customers_stripe_customer_id on customers(stripe_customer_id);
create index idx_estimates_customer_month on estimates(customer_id, month_key);
create index idx_monthly_usage_customer_month on monthly_usage(customer_id, month_key);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table customers enable row level security;
alter table customer_config enable row level security;
alter table estimates enable row level security;
alter table monthly_usage enable row level security;
alter table email_log enable row level security;

-- Service role key bypasses RLS — no additional policies needed for backend access.
-- Deny all direct public/anon access.

-- ============================================================
-- RPC: atomic monthly usage increment
-- ============================================================

create or replace function increment_estimate_count(p_customer_id uuid, p_month_key text)
returns void
language plpgsql
security definer
as $$
begin
  insert into monthly_usage (customer_id, month_key, estimate_count)
  values (p_customer_id, p_month_key, 1)
  on conflict (customer_id, month_key)
  do update set estimate_count = monthly_usage.estimate_count + 1;
end;
$$;
