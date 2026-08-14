-- ============================================================================
-- Signup rate limiting
-- ----------------------------------------------------------------------------
-- - signup_attempts tracks signups per client IP within a sliding minute
--   window. The edge function increments/checks it transactionally so an
--   attacker cannot wipe the counter or bypass the 5/min/IP limit.
-- ============================================================================

create table if not exists public.signup_attempts (
  ip text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (ip, window_start)
);

-- Prune windows older than 1 hour on each check to keep the table small.
create index if not exists idx_signup_attempts_window on public.signup_attempts (window_start);

alter table public.signup_attempts enable row level security;

-- Only the service role (via edge functions) touches this table; no policies
-- grant access to authenticated users.

-- ----------------------------------------------------------------------------
-- Atomic rate-limit check: prune stale windows, then increment the counter for
-- the caller's IP within the current minute window. Returns allowed=false when
-- the 5/min/IP cap is already reached.
-- ----------------------------------------------------------------------------
create or replace function public.check_signup_rate_limit(client_ip text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  _window_start timestamptz;
  _count integer;
begin
  delete from public.signup_attempts where window_start < now() - interval '1 hour';

  _window_start := date_trunc('minute', now());

  insert into public.signup_attempts (ip, window_start, count)
  values (client_ip, _window_start, 1)
  on conflict (ip, window_start)
  do update set count = public.signup_attempts.count + 1
  returning count into _count;

  if _count is null then
    _count := 1;
  end if;

  return _count <= 5;
end;
$$;