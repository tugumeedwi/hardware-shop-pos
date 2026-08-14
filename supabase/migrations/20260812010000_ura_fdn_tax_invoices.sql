-- ============================================================================
-- URA/FDN e-invoicing
-- ----------------------------------------------------------------------------
-- - Ensures tax columns on tenants (tax_enabled, tax_tin, tax_device_serial,
--   tax_provider, tax_config) exist with sensible defaults.
-- - Creates the tax_invoices table (pending/sent/failed + retry_count).
-- - Enables RLS + tenant isolation for tax_invoices and reuses the existing
--   set_tenant_id() trigger so client inserts are stamped automatically.
-- - Adds an owner-only UPDATE policy on tenants so the Settings page can save
--   tax configuration through the normal Supabase client.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tenants tax columns (idempotent)
-- ----------------------------------------------------------------------------
alter table public.tenants add column if not exists tax_enabled boolean default false;
alter table public.tenants add column if not exists tax_tin text;
alter table public.tenants add column if not exists tax_device_serial text;
alter table public.tenants add column if not exists tax_provider text default 'ura_fdn';
alter table public.tenants add column if not exists tax_config jsonb default '{}'::jsonb;

-- Existing columns (from an earlier migration) need the defaults set too
alter table public.tenants alter column tax_enabled set default false;
alter table public.tenants alter column tax_provider set default 'ura_fdn';
alter table public.tenants alter column tax_config set default '{}'::jsonb;

-- ----------------------------------------------------------------------------
-- 2. Owners may update their tenant row (used by the tax Settings page).
--    Uses membership role so only the active tenant's owner can save config.
-- ----------------------------------------------------------------------------
drop policy if exists tenants_update_own on public.tenants;
create policy tenants_update_own on public.tenants
  for update to authenticated
  using (id = public.get_my_tenant())
  with check (id = public.get_my_tenant());

drop policy if exists tenants_update_owner on public.tenants;
create policy tenants_update_owner on public.tenants
  for update to authenticated
  using (
    id = public.get_my_tenant()
    and exists (
      select 1 from public.tenant_memberships tm
      where tm.tenant_id = public.tenants.id
        and tm.user_id = public.auth_uid()
        and tm.role = 'owner'
    )
  )
  with check (
    id = public.get_my_tenant()
    and exists (
      select 1 from public.tenant_memberships tm
      where tm.tenant_id = public.tenants.id
        and tm.user_id = public.auth_uid()
        and tm.role = 'owner'
    )
  );

-- ----------------------------------------------------------------------------
-- 3. tax_invoices table
-- ----------------------------------------------------------------------------
create table if not exists public.tax_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sale_id uuid references public.sales(id) on delete set null,
  invoice_number text not null,
  fiscal_id text,
  status text not null default 'pending',  -- pending | sent | failed
  retry_count integer not null default 0,
  request_body jsonb,
  response_body jsonb,
  created_at timestamptz not null default now(),
  last_retry_at timestamptz
);

create unique index if not exists uq_tax_invoices_tenant_number on public.tax_invoices (tenant_id, invoice_number);
create index if not exists idx_tax_invoices_tenant on public.tax_invoices (tenant_id);
create index if not exists idx_tax_invoices_sale on public.tax_invoices (sale_id);
create index if not exists idx_tax_invoices_status on public.tax_invoices (status);

-- ----------------------------------------------------------------------------
-- 4. RLS + tenant isolation
-- ----------------------------------------------------------------------------
alter table public.tax_invoices enable row level security;

drop policy if exists tenant_isolation_all on public.tax_invoices;
drop policy if exists tenant_isolation_select on public.tax_invoices;
drop policy if exists tenant_isolation_insert on public.tax_invoices;
drop policy if exists tenant_isolation_update on public.tax_invoices;
drop policy if exists tenant_isolation_delete on public.tax_invoices;

create policy tenant_isolation_all on public.tax_invoices
  for all to authenticated
  using (tenant_id = public.get_my_tenant())
  with check (tenant_id = public.get_my_tenant());

-- Reuse the existing tenant-stamping trigger so client inserts never need to
-- send tenant_id explicitly.
drop trigger if exists trg_set_tenant_id on public.tax_invoices;
create trigger trg_set_tenant_id
  before insert on public.tax_invoices
  for each row execute function public.set_tenant_id();