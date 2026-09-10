-- ============================================================================
-- Multi-Currency Support
-- ----------------------------------------------------------------------------
-- Creates currencies table and adds currency_code to tenants, sales, expenses.
-- One currency per tenant for MVP; no automatic conversion yet.
-- ============================================================================

-- Create currencies table
create table if not exists public.currencies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  code text not null,        -- e.g., 'UGX','KES','USD'
  name text not null,              -- e.g., 'Ugandan Shilling'
  symbol text not null,            -- e.g., 'Sh', '$'
  exchange_rate_to_base numeric default 1.0,  -- relative to tenant's base currency
  is_default boolean default false,
  created_at timestamptz default now(),
  unique (tenant_id, code)
);

create index if not exists idx_currencies_tenant on public.currencies (tenant_id);

-- Add currency_code column to tenants (default 'UGX')
alter table public.tenants
  add column if not exists currency_code text default 'UGX';

-- Add currency_code column to sales (for historical records)
alter table public.sales
  add column if not exists currency_code text default 'UGX';

-- Add currency_code column to expenses (for historical records)
alter table public.expenses
  add column if not exists currency_code text default 'UGX';

-- Grant permissions
grant select, insert on public.currencies to authenticated;

-- Add RLS policies
alter table public.currencies force row level security;

create policy "currencies_tenant_isolation" on public.currencies
  for all using (tenant_id = public.get_my_tenant());

-- Set default currency for existing tenants (ensure all have UGX)
update public.tenants set currency_code = 'UGX' where currency_code is null;

-- Comment
comment on table public.currencies is 'Currency configuration per tenant';
comment on column public.currencies.code is 'Currency code (ISO 4217 or local)';
comment on column public.currencies.name is 'Full currency name';
comment on column public.currencies.symbol is 'Currency symbol';
comment on column public.currencies.exchange_rate_to_base is 'Rate to tenant base currency (1.0 = same)';
comment on column public.currencies.is_default is 'Whether this is the tenant default';
comment on column public.tenants.currency_code is 'Tenant default currency code';
comment on column public.sales.currency_code is 'Sale transaction currency';
comment on column public.expenses.currency_code is 'Expense transaction currency';