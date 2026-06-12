-- TreeSnap migration 008 — rate limiting (fixed-window, atomic)
-- Backs lib/rate-limit.js. The public endpoints (/api/estimate, /api/contact)
-- are unauthenticated; /api/estimate costs two Claude vision calls per request
-- and the demo/preview path has no tier cap. This table + RPC throttle per-IP.
-- Apply via Supabase MCP or the SQL editor before the rate-limit code can enforce
-- (until then lib/rate-limit.js fails open — no throttling, no breakage).

create table if not exists rate_limits (
  bucket       text        not null,
  identifier   text        not null,
  window_start timestamptz not null,
  count        integer     not null default 0,
  primary key (bucket, identifier, window_start)
);

create index if not exists idx_rate_limits_window_start on rate_limits(window_start);

-- Backend-only, same posture as every other table: RLS on with no policies denies
-- anon/authenticated via PostgREST, while the service-role key and the SECURITY
-- DEFINER function below bypass it.
alter table rate_limits enable row level security;

-- Atomic check-and-increment. Buckets now() into fixed windows of p_window_seconds,
-- upserts the counter, and returns the post-increment count + whether it's allowed.
-- The single upsert is race-safe under concurrent serverless invocations.
create or replace function check_rate_limit(
  p_bucket text, p_identifier text, p_window_seconds integer, p_max integer
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window_start timestamptz;
  v_count        integer;
begin
  v_window_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into rate_limits (bucket, identifier, window_start, count)
  values (p_bucket, p_identifier, v_window_start, 1)
  on conflict (bucket, identifier, window_start)
  do update set count = rate_limits.count + 1
  returning count into v_count;

  return jsonb_build_object(
    'allowed',  v_count <= p_max,
    'count',    v_count,
    'limit',    p_max,
    'reset_at', v_window_start + make_interval(secs => p_window_seconds)
  );
end;
$$;

-- Backend-only (service_role). Same lockdown posture as migration 003.
revoke execute on function public.check_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant  execute on function public.check_rate_limit(text, text, integer, integer) to service_role;

-- NOTE: old rate_limits rows can be swept by the daily cleanup cron later
-- (delete where window_start < now() - interval '2 days'). Not wired yet.
