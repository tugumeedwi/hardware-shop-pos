-- ============================================================================
-- Fix broken tenants_update_owner policy
-- ----------------------------------------------------------------------------
-- The original policy (20260812010000) wrote `tm.tenant_id = id`, but because
-- tenant_memberships has its own `id` column, PostgreSQL bound `id` to the
-- inner subquery's `tm.id`, yielding the never-true predicate
-- `tm.tenant_id = tm.id`. Owners therefore could not UPDATE their tenant row
-- (Tax Settings save, etc.) through RLS. Qualify the column as tenants.id so
-- the membership check compares against the outer row.
-- ============================================================================

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
