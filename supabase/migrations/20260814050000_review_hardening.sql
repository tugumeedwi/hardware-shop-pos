-- ============================================================================
-- Review hardening (post codebase security/performance review)
-- ----------------------------------------------------------------------------
-- 1. Revoke PUBLIC execute on check_signup_rate_limit: the RPC mutates a table
--    and must only be reachable via the edge function (service role). Anon/authed
--    callers can no longer hammer it to burn write IO or probe behavior.
-- 2. Split the blanket "tenant_isolation_all" policies on billing/audit tables
--    into read + append-only, dropping client UPDATE/DELETE:
--      - usage_records: writes are edge-function only (service role) so a tenant
--        member cannot tamper with their metering/cost to dodge AI limits.
--      - subscriptions: writes are stripe-webhook only; clients only read.
--      - activity_log: append-only audit trail (no client UPDATE/DELETE).
--    tax_invoices keeps client INSERT (POS queueing) but drops client UPDATE
--    (status/retry is owned by the cron + send edge function).
-- 3. Block client updates to tenants billing fields (subscription_status,
--    plan_id, stripe_customer_id, subscription_end_date) via a trigger. Owners
--    may still edit tax_* and profile fields through the Settings page; the
--    billing columns are write-only for the service role (stripe-webhook).
-- 4. Composite indexes for the sales / credit_transactions hot paths that the
--    first index pass missed (per-customer date range on credit transactions).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Lock down the signup rate-limit RPC
-- ----------------------------------------------------------------------------
revoke execute on function public.check_signup_rate_limit(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. Tighten RLS on billing/audit tables
-- ----------------------------------------------------------------------------

-- 2a. usage_records: SELECT for members; INSERT/UPDATE/DELETE stay with the
--     service role (track-usage edge function) which bypasses RLS.
drop policy if exists tenant_isolation_all on public.usage_records;
drop policy if exists tenant_isolation_insert on public.usage_records;
drop policy if exists tenant_isolation_update on public.usage_records;
drop policy if exists tenant_isolation_delete on public.usage_records;
drop policy if exists tenant_isolation_select on public.usage_records;

create policy tenant_isolation_select on public.usage_records
  for select to authenticated
  using (tenant_id = public.get_my_tenant());

-- 2b. subscriptions: SELECT only for members.
drop policy if exists tenant_isolation_all on public.subscriptions;
drop policy if exists tenant_isolation_insert on public.subscriptions;
drop policy if exists tenant_isolation_update on public.subscriptions;
drop policy if exists tenant_isolation_delete on public.subscriptions;
drop policy if exists tenant_isolation_select on public.subscriptions;

create policy tenant_isolation_select on public.subscriptions
  for select to authenticated
  using (tenant_id = public.get_my_tenant());

-- 2c. activity_log: append-only audit trail.
drop policy if exists tenant_isolation_all on public.activity_log;
drop policy if exists tenant_isolation_update on public.activity_log;
drop policy if exists tenant_isolation_delete on public.activity_log;
drop policy if exists tenant_isolation_select on public.activity_log;
drop policy if exists tenant_isolation_insert on public.activity_log;

create policy tenant_isolation_select on public.activity_log
  for select to authenticated
  using (tenant_id = public.get_my_tenant());

create policy tenant_isolation_insert on public.activity_log
  for insert to authenticated
  with check (tenant_id = public.get_my_tenant());

-- 2d. tax_invoices: SELECT + INSERT (POS queueing); no client UPDATE/DELETE
--     (status/retry owned by the cron and send edge functions).
drop policy if exists tenant_isolation_all on public.tax_invoices;
drop policy if exists tenant_isolation_update on public.tax_invoices;
drop policy if exists tenant_isolation_delete on public.tax_invoices;
drop policy if exists tenant_isolation_select on public.tax_invoices;
drop policy if exists tenant_isolation_insert on public.tax_invoices;

create policy tenant_isolation_select on public.tax_invoices
  for select to authenticated
  using (tenant_id = public.get_my_tenant());

create policy tenant_isolation_insert on public.tax_invoices
  for insert to authenticated
  with check (tenant_id = public.get_my_tenant());

-- ----------------------------------------------------------------------------
-- 3. Block client edits to tenants billing columns
-- ----------------------------------------------------------------------------
create or replace function public.protect_tenant_billing_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _role text := auth.role();
begin
  -- Service role (stripe-webhook), admin CLI and migrations must keep access.
  if _role is null or _role in ('service_role', 'supabase_admin') then
    return new;
  end if;

  if new.subscription_status is distinct from old.subscription_status
     or new.plan_id is distinct from old.plan_id
     or new.stripe_customer_id is distinct from old.stripe_customer_id
     or new.subscription_end_date is distinct from old.subscription_end_date
  then
    raise exception 'Billing fields are managed by the billing system and cannot be edited directly';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_tenant_billing on public.tenants;
create trigger trg_protect_tenant_billing
  before update on public.tenants
  for each row execute function public.protect_tenant_billing_columns();

-- ----------------------------------------------------------------------------
-- 4. Missing composite indexes
-- ----------------------------------------------------------------------------
create index if not exists idx_credit_transactions_tenant_customer_created
  on public.credit_transactions (tenant_id, customer_id, created_at desc);
create index if not exists idx_sales_tenant_cashier_created
  on public.sales (tenant_id, cashier_id, created_at desc);
