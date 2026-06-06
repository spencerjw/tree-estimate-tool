-- Service area / market label (e.g. "Central Texas", "Greater Atlanta").
-- Shown on the tenant estimate page: "<market> Tree Experts" header tagline
-- and "Calculating <market> market rates…" loading copy. NULL → generic copy.
-- Applied to the live project via Supabase MCP on 2026-06-06.
alter table customer_config add column if not exists market text;
