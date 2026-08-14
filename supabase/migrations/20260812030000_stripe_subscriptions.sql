-- ============================================================================
-- Stripe subscription billing
-- ----------------------------------------------------------------------------
-- - tenants: stripe_customer_id, subscription_status (default 'inactive'),
--   plan_id, subscription_end_date
-- - subscriptions: one row per active/past subscription per tenant
-- - RLS: tenant isolation, reusing the set_tenant_id() stamping trigger
-- ============================================================================

alter table public.tenants add column if not exists stripe_customer_id text;
alter table public.tenants add column if not exists subscription_status text default 'inactive';
alter table public.tenants add column if not exists plan_id text;
alter table public.tenants add column if not exists subscription_end_date timestamptz;

alter table public.tenants alter column subscription_status set default 'inactive';

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  stripe_subscription_id text,
  status text not null default 'inactive',
  plan_id text,
  current_period_end timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_subscriptions_tenant on public.subscriptions (tenant_id);
create unique index if not exists uq_subscriptions_stripe on public.subscriptions (stripe_subscription_id);
create index if not exists idx_subscriptions_status on public.subscriptions (status);

-- ----------------------------------------------------------------------------
-- RLS: tenant isolation
-- ----------------------------------------------------------------------------
alter table public.subscriptions enable row level security;

drop policy if exists tenant_isolation_all on public.subscriptions;
drop policy if exists tenant_isolation_select on public.subscriptions;
drop policy if exists tenant_isolation_insert on public.subscriptions;
drop policy if exists tenant_isolation_update on public.subscriptions;
drop policy if exists tenant_isolation_delete on public.subscriptions;

create policy tenant_isolation_all on public.subscriptions
  for all to authenticated
  using (tenant_id = public.get_my_tenant())
  with check (tenant_id = public.get_my_tenant());

-- Stamp tenant_id automatically on client inserts too
drop trigger if exists trg_set_tenant_id on public.subscriptions;
create trigger trg_set_tenant_id
  before insert on public.subscriptions
  for each row execute function public.set_tenant_id();