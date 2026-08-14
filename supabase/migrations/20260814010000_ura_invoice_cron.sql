-- ============================================================================
-- URA invoice cron worker
-- ----------------------------------------------------------------------------
-- - Adds next_retry_at to tax_invoices so a scheduled worker can pick up
--   failed/pending invoices on an exponential backoff instead of retrying
--   every run.
-- ============================================================================

alter table public.tax_invoices add column if not exists next_retry_at timestamptz;

create index if not exists idx_tax_invoices_retry_due
  on public.tax_invoices (status, next_retry_at)
  where status in ('pending', 'failed');
