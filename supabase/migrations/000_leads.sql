-- TreeSnap migration 000 — leads table (schema reconciliation)
-- The leads table was created out-of-band during the May 2026 build and never
-- committed, so a fresh rebuild from migrations/ would fail at 002 (which ALTERs
-- leads). This recreates the table's CURRENT live shape so migrations/ is the
-- source of truth again. Numbered 000 so it runs BEFORE 002's ALTERs, and
-- IF NOT EXISTS so it is a safe no-op against the live DB. Generated from the
-- live schema (project yhsthbjldvnotlfyesxe) on 2026-06-11.

create table if not exists leads (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null,
  email                       text not null,
  phone                       text not null,
  company                     text not null,
  subdomain                   text not null,
  tier                        text not null,
  zip                         text,
  status                      text not null default 'pending',
  checkout_session_id         text,
  stripe_customer_id          text,
  notes                       text,
  created_at                  timestamptz not null default now(),
  onboarding_token            text unique,
  onboarding_completed_at     timestamptz,
  onboarding_config           jsonb,
  onboarding_token_issued_at  timestamptz
);

create index if not exists idx_leads_subdomain on leads(subdomain);
create index if not exists idx_leads_status    on leads(status);

-- Service role key bypasses RLS; there are no public/anon policies — the leads
-- table is backend-only, same posture as the rest of the schema.
alter table leads enable row level security;
