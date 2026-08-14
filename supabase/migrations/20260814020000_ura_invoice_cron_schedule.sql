-- ============================================================================
-- Schedule ura-invoice-cron edge function every minute
-- ----------------------------------------------------------------------------
-- Requires pg_cron + pg_net. The job POSTs to the function URL. verify_jwt is
-- false for this function so no JWT is required; the apikey header is still
-- included for the gateway.
-- ============================================================================

create extension if not exists pg_cron with schema cron;
create extension if not exists pg_net;

-- Drop the key on each deploy first, then schedule every minute.
select cron.unschedule('ura-invoice-cron-every-minute') where exists (
  select 1 from cron.job where jobname = 'ura-invoice-cron-every-minute'
);

select cron.schedule(
  'ura-invoice-cron-every-minute',
  '* * * * *',
  $$
  select
    net.http_post(
      url := 'https://isyksrqsrwqblqwtbkwb.supabase.co/functions/v1/ura-invoice-cron',
      body := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json'
      ),
      timeout_milliseconds := 10000
    ) as request_id;
  $$
);