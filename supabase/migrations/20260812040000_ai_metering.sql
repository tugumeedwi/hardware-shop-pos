-- ============================================================================
-- AI feature metering & cost control
-- ----------------------------------------------------------------------------
-- - usage_records: daily token/cost aggregation per tenant (unique per tenant
--   + date for idempotent upserts). RLS tenant isolation + stamping trigger.
-- - plans: tier definitions used for monthly token limits.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. usage_records
-- ----------------------------------------------------------------------------
create table if not exists public.usage_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  date date not null default current_date,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  cost numeric(6,4) not null default 0,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_usage_records_tenant_date on public.usage_records (tenant_id, date);
create index if not exists idx_usage_records_tenant on public.usage_records (tenant_id);
create index if not exists idx_usage_records_tenant_month on public.usage_records (tenant_id, date);

-- ----------------------------------------------------------------------------
-- 2. plans
-- ----------------------------------------------------------------------------
create table if not exists public.plans (
  id text primary key,
  name text not null,
  monthly_token_limit integer not null default 0,
  price numeric(12,2) not null default 0,
  stripe_price_id text
);

insert into public.plans (id, name, monthly_token_limit, price, stripe_price_id) values
  ('starter', 'Starter', 10000, 10, 'price_1U4IIYRzHqbMcdYRJmIBb1yt'),
  ('pro', 'Pro', 100000, 30, 'price_PRO_PLACEHOLDER')
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- 3. RLS (tenant isolation)
-- ----------------------------------------------------------------------------
alter table public.usage_records enable row level security;

drop policy if exists tenant_isolation_all on public.usage_records;
drop policy if exists tenant_isolation_select on public.usage_records;
drop policy if exists tenant_isolation_insert on public.usage_records;
drop policy if exists tenant_isolation_update on public.usage_records;
drop policy if exists tenant_isolation_delete on public.usage_records;

create policy tenant_isolation_all on public.usage_records
  for all to authenticated
  using (tenant_id = public.get_my_tenant())
  with check (tenant_id = public.get_my_tenant());

-- Stamp tenant_id automatically so client inserts never need to send it.
drop trigger if exists trg_set_tenant_id on public.usage_records;
create trigger trg_set_tenant_id
  before insert on public.usage_records
  for each row execute function public.set_tenant_id();