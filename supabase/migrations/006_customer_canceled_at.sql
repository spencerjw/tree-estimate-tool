-- Track when a subscription was canceled so the daily cleanup cron can purge
-- a canceled tenant's lead/estimate data 90 days later (per the Privacy Policy).
-- Set on customer.subscription.deleted; cleared on reactivation (see api/stripe-webhook.js).

alter table customers add column if not exists canceled_at timestamptz;

-- Speeds up the cron's "canceled 90+ days ago" lookup.
create index if not exists idx_customers_canceled_at
  on customers (canceled_at)
  where canceled_at is not null;
