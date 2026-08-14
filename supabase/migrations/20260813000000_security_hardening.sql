-- ============================================================================
-- Security hardening pass (post multi-tenancy + onboarding review)
-- ----------------------------------------------------------------------------
-- 1. RLS for profiles (none existed -> any authenticated user could read/write
--    every user's role/full_name across all tenants and self-escalate).
-- 2. tenant_memberships: owner-gate all management (any member could previously
--    INSERT/UPDATE/DELETE membership rows, i.e. grant themselves 'owner').
-- 3. tenants: drop the member-wide UPDATE policy; only tenants_update_owner
--    (created in 20260812010000) remains, so cashiers cannot change
--    subscription_status / plan_id / tax columns.
-- 4. plans: enable RLS, read-only for authenticated users (was wide open).
-- 5. get_my_tenant(): prefer user_metadata.tenant_id (switchable by the client
--    for multi-tenant users) over the frozen app_metadata value; the join to
--    tenant_memberships still blocks spoofing of a tenant the user does not
--    belong to. Also guard the ::uuid cast so a malformed metadata value
--    returns NULL (deny) instead of raising an exception.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. profiles: RLS
--    - A user may always read their own row (needed for cached profile).
--    - Same-tenant members may read each other's rows (ActivityLog name join,
--      UserManagement listing). Scoped through tenant_memberships.
--    - INSERT/UPDATE/DELETE only on the caller's own row.
--    NOTE: role authority for route gating is moved to tenant_memberships.role
--    (see App.jsx / Layout.jsx), so self-editing profile.role grants nothing.
-- ----------------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = public.auth_uid()
    or exists (
      select 1 from public.tenant_memberships tm
      where tm.user_id = public.profiles.id
        and tm.tenant_id = public.get_my_tenant()
    )
  );

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert to authenticated
  with check (id = public.auth_uid());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = public.auth_uid())
  with check (id = public.auth_uid());

drop policy if exists profiles_delete_self on public.profiles;
create policy profiles_delete_self on public.profiles
  for delete to authenticated
  using (id = public.auth_uid());

-- ----------------------------------------------------------------------------
-- 2. tenant_memberships: owner-only management.
--    Owners are the only role allowed to add/remove/promote members. The
--    existing memberships_read_own policy (any member or the user themself
--    can read rows of the active tenant) is unchanged and remains sufficient.
-- ----------------------------------------------------------------------------
drop policy if exists memberships_manage_active on public.tenant_memberships;
drop policy if exists memberships_manage_owner on public.tenant_memberships;
create policy memberships_manage_owner on public.tenant_memberships
  for all to authenticated
  using (
    tenant_id = public.get_my_tenant()
    and exists (
      select 1 from public.tenant_memberships tm
      where tm.tenant_id = public.get_my_tenant()
        and tm.user_id = public.auth_uid()
        and tm.role = 'owner'
    )
  )
  with check (
    tenant_id = public.get_my_tenant()
    and exists (
      select 1 from public.tenant_memberships tm
      where tm.tenant_id = public.get_my_tenant()
        and tm.user_id = public.auth_uid()
        and tm.role = 'owner'
    )
  );

-- ----------------------------------------------------------------------------
-- 3. tenants: remove the member-wide UPDATE policy.
--    Only tenants_update_owner (owner-scoped, from the URA/FDN migration)
--    remains, so sensitive columns (subscription_status, plan_id, tax_*) are
--    no longer editable by cashiers.
-- ----------------------------------------------------------------------------
drop policy if exists tenants_update_own on public.tenants;

-- ----------------------------------------------------------------------------
-- 4. plans: RLS + read-only for authenticated users (writes blocked).
--    Edge functions keep working because the service role bypasses RLS.
-- ----------------------------------------------------------------------------
alter table public.plans enable row level security;

drop policy if exists plans_select_authenticated on public.plans;
create policy plans_select_authenticated on public.plans
  for select to authenticated
  using (true);

-- ----------------------------------------------------------------------------
-- 5. get_my_tenant(): prefer user_metadata (switchable) + robust UUID cast.
-- ----------------------------------------------------------------------------
create or replace function public.get_my_tenant()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tm.tenant_id
  from (
    select (
      case
        when (public.auth_jwt_claims() -> 'user_metadata' ->> 'tenant_id')
               ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          then (public.auth_jwt_claims() -> 'user_metadata' ->> 'tenant_id')::uuid
        when (public.auth_jwt_claims() -> 'app_metadata' ->> 'tenant_id')
               ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          then (public.auth_jwt_claims() -> 'app_metadata' ->> 'tenant_id')::uuid
        else null
      end
    ) as claimed_tenant
  ) c
  join public.tenant_memberships tm
    on tm.tenant_id = c.claimed_tenant
   and tm.user_id = public.auth_uid()
  limit 1
$$;