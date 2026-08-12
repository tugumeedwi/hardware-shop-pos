-- ============================================================================
-- Generic POS verticals (phone shops / general retail)
-- ----------------------------------------------------------------------------
-- - tenants.business_type: 'hardware' | 'phones' | 'general' (default hardware)
-- - products.attributes: jsonb holding vertical-specific fields such as IMEI,
--   colour, storage and condition for phone-shop products.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. tenants.business_type
-- ----------------------------------------------------------------------------
alter table public.tenants add column if not exists business_type text default 'hardware';

-- Defaults are only applied to the share of rows created before this column
-- was added; make sure the default is set going forward too.
alter table public.tenants alter column business_type set default 'hardware';

-- ----------------------------------------------------------------------------
-- 2. products.attributes
-- ----------------------------------------------------------------------------
alter table public.products add column if not exists attributes jsonb default '{}'::jsonb;
alter table public.products alter column attributes set default '{}'::jsonb;

-- GIN index so `attributes ->> 'imei'` filters can be indexed later at scale.
create index if not exists idx_products_attributes on public.products using gin (attributes jsonb_path_ops);