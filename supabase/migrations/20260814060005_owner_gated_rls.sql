-- Owner-gated RLS + server-authoritative activity_log.
--
-- Findings from the security review:
--  * products / customers / expenses / sync_conflict_log allowed ANY tenant
--    member to UPDATE/DELETE any row (the tenant_isolation_all policy). Route
--    gating in App.jsx is cosmetic; only RLS can make "owner-only" real.
--  * activity_log.user_id was client-supplied (activityLogger.js sends the
--    JWT sub, but nothing stops a tampered client from spoofing another user's
--    id). A BEFORE INSERT trigger now always stamps the authenticated user.
--
-- This migration:
--  * adds is_tenant_owner() helper
--  * keeps member-wide SELECT + INSERT, but makes UPDATE/DELETE owner-only on
--    the four tables above (cashiers may still read and create; only the owner
--    may edit/remove catalog, customers, expenses and resolve conflicts)
--  * adds the activity_log user_id override trigger

create or replace function public.is_tenant_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.tenant_memberships tm
     where tm.tenant_id = public.get_my_tenant()
       and tm.user_id = public.auth_uid()
       and tm.role = 'owner'
  )
$$;

grant execute on function public.is_tenant_owner() to authenticated;

-- Owner-only UPDATE/DELETE on business-owner tables.
-- Pattern: keep a member-wide INSERT, but the UPDATE/DELETE policies are gated
-- on is_tenant_owner(). PostgreSQL requires a single all-inclusive policy for
-- UPDATE unless separate ones are named per command; we drop the combined
-- tenant_isolation_all and recreate explicit per-command policies so UPDATE
-- and DELETE can be owner-gated while INSERT stays member-wide.

do $$
declare t text;
begin
  foreach t in array array['products', 'customers', 'expenses', 'sync_conflict_log'] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('drop policy if exists tenant_isolation_all on public.%I', t);
      execute format('drop policy if exists tenant_isolation_select on public.%I', t);
      execute format('drop policy if exists tenant_isolation_insert on public.%I', t);
      execute format('drop policy if exists tenant_isolation_update on public.%I', t);
      execute format('drop policy if exists tenant_isolation_delete on public.%I', t);
      execute format(
        'create policy tenant_isolation_select on public.%I
         for select to authenticated
         using (tenant_id = public.get_my_tenant())', t
      );
      execute format(
        'create policy tenant_isolation_insert on public.%I
         for insert to authenticated
         with check (tenant_id = public.get_my_tenant())', t
      );
      execute format(
        'create policy tenant_isolation_update_owner on public.%I
         for update to authenticated
         using (tenant_id = public.get_my_tenant() and public.is_tenant_owner())
         with check (tenant_id = public.get_my_tenant() and public.is_tenant_owner())', t
      );
      execute format(
        'create policy tenant_isolation_delete_owner on public.%I
         for delete to authenticated
         using (tenant_id = public.get_my_tenant() and public.is_tenant_owner())', t
      );
    end if;
  end loop;
end $$;

-- activity_log: keep member-wide SELECT (cashiers see the feed) and INSERT,
-- but server-authoritatively stamp the acting user and tenant.

create or replace function public.stamp_activity_actor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  NEW.user_id := public.auth_uid();
  NEW.tenant_id := public.get_my_tenant();
  return NEW;
end;
$$;

drop trigger if exists trg_stamp_activity_actor on public.activity_log;
create trigger trg_stamp_activity_actor
  before insert on public.activity_log
  for each row execute function public.stamp_activity_actor();