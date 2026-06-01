-- TreeSnap migration 004 — customer_config.theme
-- Reconciles the committed migrations with the live schema: the live
-- customer_config table already has a `theme` column (added out-of-band during
-- the May 2026 build), and both lib/provision.js and api/config.js read/write
-- it. 001_initial_schema.sql never declared it, so a fresh DB rebuilt from the
-- migrations would break provisioning. This adds it idempotently.

alter table customer_config
  add column if not exists theme text default 'forest-green';
