-- ============================================================================
-- Supermarket retail vertical
-- ----------------------------------------------------------------------------
-- - tenants.business_type: allow 'supermarket' alongside hardware/phones/general
-- - products: optional barcode (EAN/UPC), brand, supplier and per-product
--   tax_rate for supermarket catalogue items.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. tenants.business_type – add 'supermarket' to the allowed set
-- ----------------------------------------------------------------------------
-- The column has no CHECK constraint today (it was added as a plain text
-- column); enforce the whitelist now so future inserts stay valid, including
-- rows created through the signup edge function.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tenants_business_type_check'
  ) then
    alter table public.tenants
      add constraint tenants_business_type_check
      check (business_type in ('hardware', 'phones', 'general', 'supermarket'));
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. products – supermarket catalogue columns
-- ----------------------------------------------------------------------------
alter table public.products add column if not exists barcode text;
alter table public.products add column if not exists brand text;
alter table public.products add column if not exists supplier text;
alter table public.products add column if not exists tax_rate numeric(5,2) default 0;

-- Barcode lookups are the hot path at the till: index per tenant so the scan
-- stays a fast index scan even with tens of thousands of SKUs.
create index if not exists idx_products_tenant_barcode
  on public.products (tenant_id, barcode)
  where barcode is not null and coalesce(is_deleted, false) = false;

-- Common filters for supermarket catalogue browsing.
create index if not exists idx_products_tenant_category
  on public.products (tenant_id, category)
  where coalesce(is_deleted, false) = false;

-- Give products tables a partial unique guard against duplicate barcodes per
-- tenant (duplicate scans at the till would silently charge the wrong item).
create unique index if not exists uidx_products_tenant_barcode_active
  on public.products (tenant_id, barcode)
  where barcode is not null and barcode <> '' and coalesce(is_deleted, false) = false;

-- ----------------------------------------------------------------------------
-- 3. products.attributes – add tax category/brand placeholders consumers use
-- ----------------------------------------------------------------------------
-- Attributes already exist as jsonb; nothing to migrate. The supermarket
-- product form stores brand/supplier in dedicated columns above.

grant execute on function public.is_tenant_owner() to authenticated;