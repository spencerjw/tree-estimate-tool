-- TreeSnap migration 002 — onboarding token issue time
-- Applied to project yhsthbjldvnotlfyesxe on 2026-06-01 via Supabase MCP.
--
-- Token expiry previously keyed off leads.created_at, so the 72h window could be
-- shorter than intended when approval lagged application, and resend-onboarding
-- had to clobber created_at as a workaround. This column tracks the real issue
-- time; isExpired() and the approve/resend admin actions now use it.

alter table leads add column if not exists onboarding_token_issued_at timestamptz;

-- Backfill existing rows that already have a token (fall back to created_at).
update leads
   set onboarding_token_issued_at = created_at
 where onboarding_token is not null
   and onboarding_token_issued_at is null;
