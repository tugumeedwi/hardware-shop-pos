-- ============================================================================
-- Security Hardening: views, functions, extensions
-- ----------------------------------------------------------------------------
-- SAFE, NON-DESTRUCTIVE version.
--
-- What the previous version of this file got wrong (and why it was replaced):
--  1. It used DROP FUNCTION + CREATE OR REPLACE with SIMPLIFIED bodies
--     (e.g. a stub create_sale that ignores items/stock/branches). That would
--     have silently destroyed business logic. This version NEVER touches
--     function bodies: it uses ALTER FUNCTION ... SET search_path instead.
--  2. It ran `ALTER VIEW ... ENABLE ROW LEVEL SECURITY` and
--     `CREATE POLICY ... ON <view>`. RLS policies are not supported on views;
--     both statements fail. Views are fixed with WITH (security_invoker=true).
--  3. It granted EXECUTE on functions with WRONG signatures
--     (convert_quotation(jsonb), record_credit_payment(jsonb)) which do not
--     exist (real signatures are uuid / uuid+numeric) -- those GRANTs fail.
--  4. It revoked EXECUTE on RLS helpers (get_my_tenant, auth_uid, ...). Every
--     RLS policy calls those helpers, and PostgreSQL requires EXECUTE
--     privilege even for indirect calls from policies. Revoking them breaks
--     every authenticated query. They stay granted to `authenticated`.
--
-- What this migration does:
--  1. Recreate platform_metrics / platform_tenant_summary WITH
--     (security_invoker = true) so they respect the caller's RLS.
--  2. ALTER all SECURITY DEFINER functions: SET search_path = public
--     (idempotent, does not touch bodies).
--  3. REVOKE EXECUTE FROM anon on all SECURITY DEFINER functions.
--  4. REVOKE EXECUTE FROM authenticated ONLY on functions that must never be
--     called directly by clients (raw vault wrappers without owner checks +
--     trigger-only functions). Frontend/RLS/edge-as-user functions keep their
--     grants (see allow-list below with justification).
--  5. pg_trgm / pg_net stay in public (accepted linter warning, documented).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Views -> SECURITY INVOKER.
-- NOTE: RLS policies cannot be attached to views, so there is intentionally
-- no CREATE POLICY here. Access control = GRANT SELECT (kept, so the existing
-- PlatformDashboard keeps working) + underlying tables' RLS via invoker.
-- Residual risk (documented): any authenticated user can read the aggregate
-- numbers. A future step should replace these views with a SECURITY DEFINER
-- function that asserts profiles.role = 'platform_admin'.
-- ----------------------------------------------------------------------------
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
comment on view public.platform_metrics is 'High-level platform metrics for CEO dashboard (platform_admin only; security_invoker, see migration 20260908000000 for residual-risk note)';

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
comment on view public.platform_tenant_summary is 'Per-tenant summary for CEO dashboard (platform_admin only; security_invoker, see migration 20260908000000 for residual-risk note)';

-- ----------------------------------------------------------------------------
-- 2. Pin search_path on every SECURITY DEFINER function (non-destructive).
-- All of these already declare SET search_path = public at creation time;
-- ALTER is idempotent and protects against any function that was created
-- without it (linter: function_search_path_mutable).
-- ----------------------------------------------------------------------------
alter function public.auth_jwt_claims() set search_path = public;
alter function public.auth_uid() set search_path = public;
alter function public.get_my_tenant() set search_path = public;
alter function public.set_tenant_id() set search_path = public;
alter function public.deduct_stock(uuid, numeric) set search_path = public;
alter function public.convert_quotation(uuid) set search_path = public;
alter function public.create_sale(jsonb) set search_path = public;
alter function public.check_signup_rate_limit(text) set search_path = public;
alter function public.protect_tenant_billing_columns() set search_path = public;
alter function public.record_credit_payment(uuid, numeric) set search_path = public;
alter function public.is_tenant_owner() set search_path = public;
alter function public.stamp_activity_actor() set search_path = public;
alter function public.track_usage(integer, integer, numeric) set search_path = public;
alter function public.expire_quotations() set search_path = public;
alter function public.vault_create_secret(text, text) set search_path = public;
alter function public.vault_delete_secret(text) set search_path = public;
alter function public.vault_get_secret(text) set search_path = public;
alter function public.save_tax_auth_token(text) set search_path = public;
alter function public.has_tax_auth_token() set search_path = public;
alter function public.dashboard_summary() set search_path = public;
alter function public.is_platform_admin() set search_path = public;
alter function public.stamp_payment_request() set search_path = public;
alter function public.default_branch_id(uuid) set search_path = public;
alter function public.my_default_branch_id() set search_path = public;
alter function public.ensure_default_branch(uuid) set search_path = public;
alter function public.tenants_create_default_branch() set search_path = public;
alter function public.branches_single_head_office() set search_path = public;
alter function public.branches_guard_delete() set search_path = public;
alter function public.products_sync_branch_stock() set search_path = public;
alter function public.memberships_validate_branch() set search_path = public;
alter function public.assigned_branch_id(uuid, uuid) set search_path = public;
alter function public.my_branch_id() set search_path = public;
alter function public.products_sync_batch_stock() set search_path = public;
alter function public.get_batches_by_product_branch(uuid, uuid) set search_path = public;
alter function public.total_batch_qty(uuid, uuid) set search_path = public;
alter function public.seed_default_accounts() set search_path = public;

-- ----------------------------------------------------------------------------
-- 3. REVOKE EXECUTE FROM anon on all SECURITY DEFINER functions.
-- (REVOKE warns instead of erroring when no grant exists, so this is safe to
-- run even for functions never granted to anon. Only 4 functions were ever
-- granted to anon: get_my_tenant, auth_jwt_claims, auth_uid, set_tenant_id.)
-- ----------------------------------------------------------------------------
revoke execute on function public.auth_jwt_claims() from anon;
revoke execute on function public.auth_uid() from anon;
revoke execute on function public.get_my_tenant() from anon;
revoke execute on function public.set_tenant_id() from anon;
revoke execute on function public.deduct_stock(uuid, numeric) from anon;
revoke execute on function public.convert_quotation(uuid) from anon;
revoke execute on function public.create_sale(jsonb) from anon;
revoke execute on function public.check_signup_rate_limit(text) from anon;
revoke execute on function public.protect_tenant_billing_columns() from anon;
revoke execute on function public.record_credit_payment(uuid, numeric) from anon;
revoke execute on function public.is_tenant_owner() from anon;
revoke execute on function public.stamp_activity_actor() from anon;
revoke execute on function public.track_usage(integer, integer, numeric) from anon;
revoke execute on function public.expire_quotations() from anon;
revoke execute on function public.vault_create_secret(text, text) from anon;
revoke execute on function public.vault_delete_secret(text) from anon;
revoke execute on function public.vault_get_secret(text) from anon;
revoke execute on function public.save_tax_auth_token(text) from anon;
revoke execute on function public.has_tax_auth_token() from anon;
revoke execute on function public.dashboard_summary() from anon;
revoke execute on function public.is_platform_admin() from anon;
revoke execute on function public.stamp_payment_request() from anon;
revoke execute on function public.default_branch_id(uuid) from anon;
revoke execute on function public.my_default_branch_id() from anon;
revoke execute on function public.ensure_default_branch(uuid) from anon;
revoke execute on function public.tenants_create_default_branch() from anon;
revoke execute on function public.branches_single_head_office() from anon;
revoke execute on function public.branches_guard_delete() from anon;
revoke execute on function public.products_sync_branch_stock() from anon;
revoke execute on function public.memberships_validate_branch() from anon;
revoke execute on function public.assigned_branch_id(uuid, uuid) from anon;
revoke execute on function public.my_branch_id() from anon;
revoke execute on function public.products_sync_batch_stock() from anon;
revoke execute on function public.get_batches_by_product_branch(uuid, uuid) from anon;
revoke execute on function public.total_batch_qty(uuid, uuid) from anon;
revoke execute on function public.seed_default_accounts() from anon;

-- ----------------------------------------------------------------------------
-- 4. REVOKE FROM authenticated -- DENY LIST ONLY (not a blanket revoke).
--
-- A blanket "revoke from authenticated, re-grant frontend RPCs" would break
-- the app because RLS POLICIES themselves call helper functions and Postgres
-- requires EXECUTE privilege even for indirect policy calls. The helpers
-- below MUST stay executable by authenticated:
--   get_my_tenant, auth_uid, auth_jwt_claims, is_tenant_owner,
--   is_platform_admin  (called from RLS policies on every tenant table)
-- Likewise get_my_tenant is called as `authenticated` (anon key + user JWT)
-- from edge functions (_shared/auth.ts getTenantId), and track_usage is
-- called as `authenticated` from the track-usage edge function.
--
-- Frontend RPC audit (src/**/*.jsx|js, `supabase.rpc('...')`):
--   create_sale(jsonb)             POS.jsx, syncManager.js, QuotationForm.jsx
--   convert_quotation(uuid)        Quotations.jsx
--   record_credit_payment(uuid,numeric)  Payments.jsx
--   expire_quotations()            Quotations.jsx
--   dashboard_summary()            Dashboard.jsx
--   save_tax_auth_token(text)      TaxSettings.jsx (owner check inside)
--   has_tax_auth_token()           TaxSettings.jsx
--   track_usage(int,int,numeric)   via track-usage edge fn as auth user
--   get_my_tenant()                via edge _shared/auth.ts as auth user
-- NOT frontend-called (no grant change, keep existing RLS-helper grants):
--   auth_uid, auth_jwt_claims, is_tenant_owner, is_platform_admin,
--   deduct_stock, default/my_default/ensure_default_branch, assigned/my_branch,
--   get_batches_by_product_branch, total_batch_qty
-- BROKEN frontend calls (RPC does not exist in any migration -- no GRANT
-- possible, left for a follow-up to implement or rewrite the pages):
--   create_sales_return   (SalesHistory.jsx)
--   create_stock_transfer (StockTransfer.jsx)
--   v_sales_by_category / v_inventory_valuation / v_credit_outstanding /
--     v_employee_sales called via rpc() but they are VIEWS, not functions.
--     Fixed in frontend (Reports.jsx, Dashboard.jsx now use .from().select()).
--
-- Hence the ONLY revokes from authenticated are the raw Vault wrappers, which
-- take an ARBITRARY secret_name with NO tenant/owner check inside, so any
-- authenticated user could read/write ANY secret (including other tenants'
-- tax tokens and URA certs). Edge functions call them with the SERVICE ROLE
-- key (upload-ura-cert, _shared/auth getTaxAuthToken), which is unaffected by
-- this revoke. Owner-scoped wrappers save_tax_auth_token / has_tax_auth_token
-- (which DO check get_my_tenant + is_tenant_owner) stay granted.
-- Trigger-only functions are also revoked from authenticated as hygiene
-- (they fire via triggers regardless; direct RPC invocation is never needed).
-- ----------------------------------------------------------------------------
revoke execute on function public.vault_create_secret(text, text) from authenticated;
revoke execute on function public.vault_delete_secret(text) from authenticated;
revoke execute on function public.vault_get_secret(text) from authenticated;

-- Trigger-only functions: never invoked via RPC, revoke direct-call rights.
revoke execute on function public.set_tenant_id() from authenticated;
revoke execute on function public.protect_tenant_billing_columns() from authenticated;
revoke execute on function public.stamp_activity_actor() from authenticated;
revoke execute on function public.stamp_payment_request() from authenticated;
revoke execute on function public.tenants_create_default_branch() from authenticated;
revoke execute on function public.branches_single_head_office() from authenticated;
revoke execute on function public.branches_guard_delete() from authenticated;
revoke execute on function public.products_sync_branch_stock() from authenticated;
revoke execute on function public.memberships_validate_branch() from authenticated;
revoke execute on function public.products_sync_batch_stock() from authenticated;
revoke execute on function public.seed_default_accounts() from authenticated;
-- check_signup_rate_limit was already revoked in 20260814050000; re-assert:
revoke execute on function public.check_signup_rate_limit(text) from public, anon, authenticated;

-- Re-assert the allow-list grants for frontend/edge-as-user RPCs (idempotent;
-- correct signatures -- uuid for convert_quotation, (uuid, numeric) for
-- record_credit_payment):
grant execute on function public.create_sale(jsonb) to authenticated;
grant execute on function public.convert_quotation(uuid) to authenticated;
grant execute on function public.record_credit_payment(uuid, numeric) to authenticated;
grant execute on function public.expire_quotations() to authenticated;
grant execute on function public.dashboard_summary() to authenticated;
grant execute on function public.save_tax_auth_token(text) to authenticated;
grant execute on function public.has_tax_auth_token() to authenticated;
grant execute on function public.track_usage(integer, integer, numeric) to authenticated;
grant execute on function public.get_my_tenant() to authenticated;
grant execute on function public.auth_uid() to authenticated;
grant execute on function public.auth_jwt_claims() to authenticated;
grant execute on function public.is_tenant_owner() to authenticated;
grant execute on function public.is_platform_admin() to authenticated;

-- ----------------------------------------------------------------------------
-- 5. Extensions pg_trgm / pg_net: intentionally left in public.
-- Moving pg_net breaks the ura-invoice-cron pg_cron job (net.http_post OID
-- references), and moving pg_trgm requires rewriting dependent indexes.
-- Accepted as a documented linter-warning exception; revisit with a dedicated
-- extensions-schema migration + full cron/index rebuild test.
-- ----------------------------------------------------------------------------

-- ============================================================================
-- End of 20260908000000_security_hardening.sql
-- ============================================================================
