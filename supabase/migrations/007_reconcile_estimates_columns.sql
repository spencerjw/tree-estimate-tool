-- TreeSnap migration 007 — reconcile estimates columns with live schema
-- is_demo and photo_paths were added out-of-band during the build (see the NOTE
-- comments in api/estimate.js) and never committed. 001 created estimates without
-- them, so a fresh rebuild would break estimate logging and the photo-cleanup
-- cron. Add idempotently; safe no-op against the live DB.

alter table estimates add column if not exists is_demo     boolean default false;
alter table estimates add column if not exists photo_paths text[];
