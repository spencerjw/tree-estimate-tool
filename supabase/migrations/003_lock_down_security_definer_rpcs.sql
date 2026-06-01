-- TreeSnap migration 003 — lock down SECURITY DEFINER RPCs
-- Applied to project yhsthbjldvnotlfyesxe on 2026-06-01 via Supabase MCP.
--
-- Supabase security advisors flagged increment_estimate_count and rls_auto_enable
-- as SECURITY DEFINER functions executable by anon/authenticated via /rest/v1/rpc.
-- increment_estimate_count is called only by the backend (service_role key), so
-- restrict EXECUTE to service_role and pin a stable search_path. rls_auto_enable
-- is a maintenance function never called from the app — remove public EXECUTE.

revoke execute on function public.increment_estimate_count(uuid, text) from public, anon, authenticated;
grant  execute on function public.increment_estimate_count(uuid, text) to service_role;
alter function public.increment_estimate_count(uuid, text) set search_path = public, pg_temp;

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
