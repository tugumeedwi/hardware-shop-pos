-- ============================================================================
-- Hybrid billing: manual payments (bank / MTN / Airtel) + lifetime licenses
-- ----------------------------------------------------------------------------
-- - tenants: billing cycle, payment method, subscription start/end, lifetime
-- - plans:   annual + lifetime prices and a currency (UGX)
-- - payment_requests: manual payment submissions awaiting platform review
-- - platform_admin: profile-level role (profiles.role has no CHECK constraint,
--   so no constraint change is required – only the helper below)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. tenants columns (idempotent)
-- ----------------------------------------------------------------------------
alter table public.tenants add column if not exists billing_cycle text default 'monthly';
alter table public.tenants add column if not exists payment_method text default 'manual';
alter table public.tenants add column if not exists subscription_start_date date;
alter table public.tenants add column if not exists subscription_end_date date;
alter table public.tenants add column if not exists lifetime_license boolean default false;

-- ----------------------------------------------------------------------------
-- 2. plans columns + UGX pricing
-- ----------------------------------------------------------------------------
alter table public.plans add column if not exists annual_price numeric(12,2);
alter table public.plans add column if not exists lifetime_price numeric(12,2);
alter table public.plans add column if not exists currency text default 'UGX';

update public.plans set
  price = 49000,
  annual_price = 500000,
  lifetime_price = 1500000,
  currency = 'UGX'
where id = 'starter';

update public.plans set
  price = 119000,
  annual_price = 1200000,
  lifetime_price = 2500000,
  currency = 'UGX'
where id = 'pro';

-- ----------------------------------------------------------------------------
-- 3. platform_admin helper (SECURITY DEFINER – reads profiles directly)
-- ----------------------------------------------------------------------------
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = public.auth_uid()
      and role = 'platform_admin'
  )
$$;

grant execute on function public.is_platform_admin() to authenticated;

-- ----------------------------------------------------------------------------
-- 4. payment_requests
-- ----------------------------------------------------------------------------
create table if not exists public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  plan_id text not null references public.plans(id),
  billing_cycle text not null check (billing_cycle in ('monthly', 'annual', 'lifetime')),
  amount numeric(12,2) not null,
  payment_method text default 'manual' check (payment_method in ('manual', 'bank', 'mtn', 'airtel', 'flutterwave')),
  reference_number text,
  note text,
  proof_url text,
  status text default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id)
);

create index if not exists idx_payment_requests_tenant on public.payment_requests (tenant_id);
create index if not exists idx_payment_requests_status on public.payment_requests (status, created_at desc);

-- BEFORE INSERT/UPDATE trigger:
--  * INSERT: stamps tenant_id (null-safe so a service-role edge function can
--    pass it explicitly), forces status='pending', clears review fields, and
--    recomputes amount from the plans table so the price is server-authoritative
--    even when a member inserts directly through the client.
--  * UPDATE: keeps tenant_id immutable and, on approve/reject transitions,
--    stamps reviewed_by/reviewed_at unless the caller already provided them.
create or replace function public.stamp_payment_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric(12,2);
begin
  if TG_OP = 'INSERT' then
    if NEW.tenant_id is null then
      NEW.tenant_id := public.get_my_tenant();
    end if;
    if NEW.tenant_id is null then
      raise exception 'No active tenant – cannot create payment request';
    end if;
    NEW.status := 'pending';
    NEW.reviewed_at := null;
    NEW.reviewed_by := null;
    select case NEW.billing_cycle
        when 'monthly'  then p.price
        when 'annual'   then p.annual_price
        when 'lifetime' then p.lifetime_price
      end into v_amount
      from public.plans p
     where p.id = NEW.plan_id;
    if v_amount is null then
      raise exception 'Unknown plan or missing price for cycle %', NEW.billing_cycle;
    end if;
    NEW.amount := v_amount;
  else
    NEW.tenant_id := OLD.tenant_id;
    if NEW.status is distinct from OLD.status and NEW.status in ('approved', 'rejected') then
      NEW.reviewed_at := coalesce(NEW.reviewed_at, now());
      NEW.reviewed_by := coalesce(NEW.reviewed_by, public.auth_uid());
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_stamp_payment_request on public.payment_requests;
create trigger trg_stamp_payment_request
  before insert or update on public.payment_requests
  for each row execute function public.stamp_payment_request();

-- ----------------------------------------------------------------------------
-- 5. RLS on payment_requests
-- ----------------------------------------------------------------------------
alter table public.payment_requests enable row level security;

drop policy if exists payment_requests_insert_own on public.payment_requests;
create policy payment_requests_insert_own on public.payment_requests
  for insert to authenticated
  with check (tenant_id = public.get_my_tenant());

drop policy if exists payment_requests_select_own on public.payment_requests;
create policy payment_requests_select_own on public.payment_requests
  for select to authenticated
  using (tenant_id = public.get_my_tenant());

-- Only platform admins may update (approve/reject). Deletion is not exposed.
drop policy if exists payment_requests_update_admin on public.payment_requests;
create policy payment_requests_update_admin on public.payment_requests
  for update to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- ----------------------------------------------------------------------------
-- 6. RLS on plans (readable by everyone, not writable by any client role).
--    Previously RLS was disabled, which let any authenticated client UPDATE
--    plan prices via the API – unacceptable now that prices drive payments.
-- ----------------------------------------------------------------------------
alter table public.plans enable row level security;

drop policy if exists plans_select_public on public.plans;
create policy plans_select_public on public.plans
  for select to anon, authenticated
  using (true);
