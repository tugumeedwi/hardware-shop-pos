-- ============================================================================
-- Public API / Developer Platform
-- ----------------------------------------------------------------------------
-- Creates api_keys table for API key authentication.
-- Creates Edge Function `public-api` that proxies selected Supabase queries.
-- ============================================================================

-- Create api_keys table
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  key_hash text unique not null,
  scopes text[] default '{}',
  last_used_at timestamptz,
  created_at timestamptz default now()
);

-- Grant permissions
grant select, insert on public.api_keys to authenticated;

-- Add RLS policies
alter table public.api_keys force row level security;

create policy "api_keys_tenant_isolation" on public.api_keys
  for all using (tenant_id = public.get_my_tenant());

-- Comment
comment on table public.api_keys is 'API keys for developer platform access';
comment on column public.api_keys.tenant_id is 'Tenant scope';
comment on column public.api_keys.name is 'Human-readable key name';
comment on column public.api_keys.key_hash is 'Hashed API key (plaintext never stored)';
comment on column public.api_keys.scopes is 'Array of allowed scopes (e.g., products, sales, customers)';
comment on column public.api_keys.last_used_at is 'Timestamp of last API usage';