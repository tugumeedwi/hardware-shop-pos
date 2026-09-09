-- ============================================================================
-- Security Hardening (final): re-assert after 20261207000000_platform_metrics
-- ----------------------------------------------------------------------------
-- Migration 20261207000000 recreates platform_metrics / platform_tenant_summary
-- WITHOUT security_invoker (it runs AFTER 20260908000000 by timestamp order),
-- which would silently undo the view hardening. This file runs last and
-- re-applies it, plus re-asserts the vault revokes in case any later file
-- re-granted them. Fully idempotent.
-- ============================================================================

-- 1. Views -> SECURITY INVOKER (same definitions as 20261207000000).
drop view if exists public.platform_metrics;
create view public.platform_metrics with (security_invoker = true) as
select
  count(distinct t.id)::int as total_tenants,
  count(distinct b.id)::int as total_branches,
  count(distinct tm.id)::int as total_employees,
  count(distinct c.id)::int as total_customers,
  coalesce(sum(s.total_amount), 0)::numeric as total_sales_amount,
  count(distinct s_sub.id) filter (where s_sub.status = 'active')::int as active_subscriptions,
  count(distinct pr.id) filter (where pr.status = 'pending')::int as pending_payment_requests
from public.tenants t
left join public.branches b on b.tenant_id = t.id
left join public.tenant_memberships tm on tm.tenant_id = t.id
left join public.customers c on c.tenant_id = t.id
left join public.sales s on s.tenant_id = t.id and s.status = 'completed'
left join public.subscriptions s_sub on s_sub.tenant_id = t.id
left join public.payment_requests pr on pr.tenant_id = t.id;

grant select on public.platform_metrics to authenticated;

drop view if exists public.platform_tenant_summary;
create view public.platform_tenant_summary with (security_invoker = true) as
select
  t.id::uuid as tenant_id,
  t.name as tenant_name,
  count(distinct b.id)::int as branches_count,
  count(distinct tm.id)::int as employees_count,
  count(distinct c.id)::int as customers_count,
  t.subscription_status as subscription_status,
  t.plan_id as plan_id,
  t.created_at::date as created_at
from public.tenants t
left join public.branches b on b.tenant_id = t.id
left join public.tenant_memberships tm on tm.tenant_id = t.id
left join public.customers c on c.tenant_id = t.id
group by t.id, t.name, t.subscription_status, t.plan_id, t.created_at;

grant select on public.platform_tenant_summary to authenticated;

-- Reporting views: also force security_invoker so PostgREST evaluates the
-- caller's RLS (defense in depth; these aggregate across tenants and should
-- gain explicit tenant scoping in a follow-up).
alter view public.v_sales_summary set (security_invoker = true);
alter view public.v_daily_sales set (security_invoker = true);
alter view public.v_sales_by_category set (security_invoker = true);
alter view public.v_inventory_valuation set (security_invoker = true);
alter view public.v_credit_outstanding set (security_invoker = true);
alter view public.v_employee_sales set (security_invoker = true);

-- 2. Re-assert search_path + revokes (idempotent).
alter function public.vault_create_secret(text, text) set search_path = public;
alter function public.vault_delete_secret(text) set search_path = public;
alter function public.vault_get_secret(text) set search_path = public;

revoke execute on function public.vault_create_secret(text, text) from anon;
revoke execute on function public.vault_delete_secret(text) from anon;
revoke execute on function public.vault_get_secret(text) from anon;
revoke execute on function public.vault_create_secret(text, text) from authenticated;
revoke execute on function public.vault_delete_secret(text) from authenticated;
revoke execute on function public.vault_get_secret(text) from authenticated;

revoke execute on function public.auth_jwt_claims() from anon;
revoke execute on function public.auth_uid() from anon;
revoke execute on function public.get_my_tenant() from anon;
revoke execute on function public.set_tenant_id() from anon;
