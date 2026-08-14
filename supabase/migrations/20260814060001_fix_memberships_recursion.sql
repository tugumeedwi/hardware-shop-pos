-- ============================================================================
-- Fix RLS infinite recursion on tenant_memberships
-- ----------------------------------------------------------------------------
-- memberships_manage_owner was `for all` (includes SELECT). When the
-- tenants_update_owner policy SELECTs tenant_memberships to verify the owner,
-- RLS evaluated memberships_manage_owner on that scan, whose EXISTS subquery
-- re-scans tenant_memberships -> infinite recursion (42P17) on any owner
-- UPDATE of tenants.
--
-- Fix: split the policy into INSERT/UPDATE/DELETE commands only. Reads are
-- already covered by memberships_read_own, which does not self-query.
-- ============================================================================

drop policy if exists memberships_manage_owner on public.tenant_memberships;

create policy memberships_insert_owner on public.tenant_memberships
  for insert to authenticated
  with check (
    tenant_id = public.get_my_tenant()
    and exists (
      select 1 from public.tenant_memberships tm
      where tm.tenant_id = public.get_my_tenant()
        and tm.user_id = public.auth_uid()
        and tm.role = 'owner'
    )
  );

create policy memberships_update_owner on public.tenant_memberships
  for update to authenticated
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

create policy memberships_delete_owner on public.tenant_memberships
  for delete to authenticated
  using (
    tenant_id = public.get_my_tenant()
    and exists (
      select 1 from public.tenant_memberships tm
      where tm.tenant_id = public.get_my_tenant()
        and tm.user_id = public.auth_uid()
        and tm.role = 'owner'
    )
  );
