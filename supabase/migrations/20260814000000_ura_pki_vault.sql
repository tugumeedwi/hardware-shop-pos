-- ============================================================================
-- URA/FDN PKI certificate storage
-- ----------------------------------------------------------------------------
-- - Adds vault path columns to tenants so the edge function can record where
--   the tenant's certificate + password live in Supabase Vault.
-- - The supabase_vault extension and its public RPC helpers
--   (vault_create_secret / vault_delete_secret / vault_get_secret) are already
--   enabled on this project.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tenants vault-path columns
-- ----------------------------------------------------------------------------
alter table public.tenants add column if not exists ura_cert_vault_path text;
alter table public.tenants add column if not exists ura_password_vault_path text;
