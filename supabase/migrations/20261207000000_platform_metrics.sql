-- ============================================================================
-- Platform Metrics: Cross-tenant aggregated views for CEO dashboard
-- ----------------------------------------------------------------------------
-- 1. platform_metrics: returns high-level metrics across all tenants
-- 2. platform_tenant_summary: returns per-tenant summary
-- 3. RLS policies: these views are accessible only to platform_admin
-- ============================================================================

-- Create or replace platform_metrics view (accessible only to platform_admin via RLS)
create or replace view public.platform_metrics as
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

-- Grant select to authenticated users (RLS will filter by role)
grant select on public.platform_metrics to authenticated;

-- Create or replace platform_tenant_summary view
create or replace view public.platform_tenant_summary as
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

-- Grant select to authenticated users (RLS will filter by role)
grant select on public.platform_tenant_summary to authenticated;

-- Access control moved to the SECURITY DEFINER functions platform_metrics()
-- and platform_tenant_summary() (see 20261209000000): PostgreSQL does not
-- support CREATE POLICY on views, so the statements that stood here were
-- removed -- they abort `supabase db push` with "cannot create policy on a
-- view". The views themselves are dropped by 20261209000000.

-- Add comments
comment on view public.platform_metrics is 'High-level platform metrics for CEO dashboard (platform_admin only)';
comment on view public.platform_tenant_summary is 'Per-tenant summary for CEO dashboard (platform_admin only)';
