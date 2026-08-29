-- ============================================================================
-- Customer Loyalty Program (Optional per tenant)
-- ----------------------------------------------------------------------------
-- Adds loyalty_enabled column to tenants. If false (default), all loyalty
-- logic is skipped for backward compatibility.
-- ============================================================================

-- Add loyalty_enabled column to tenants (default false for backward compat)
alter table public.tenants
  add column if not exists loyalty_enabled boolean default false;
