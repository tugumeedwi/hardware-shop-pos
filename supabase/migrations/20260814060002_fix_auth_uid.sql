-- ============================================================================
-- Fix public.auth_uid() to read sub from the JWT claims JSON
-- ----------------------------------------------------------------------------
-- public.auth_uid() read only current_setting('request.jwt.claim.sub', true).
-- On this project PostgREST populates request.jwt.claims (full JWT JSON) but
-- not the per-claim setting, so auth_uid() returned NULL, get_my_tenant()
-- returned NULL, and every RLS policy that depends on them silently denied
-- authenticated access. Match Supabase's own auth.uid() fallback pattern.
-- ============================================================================

create or replace function public.auth_uid()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;
