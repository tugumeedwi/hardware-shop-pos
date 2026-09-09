-- ============================================================================
-- Security gaps follow-up: missing RPCs, platform functions, tenant views
-- ----------------------------------------------------------------------------
-- 1. create_sales_return(return_data jsonb) + create_stock_transfer(
--    transfer_data jsonb): SECURITY DEFINER RPCs matching exactly the payloads
--    sent by SalesHistory.jsx / StockTransfer.jsx (and asserted by
--    tests/phase1-branches.spec.ts). Tenant-isolated, owner-only (platform
--    admin may act with the target tenant resolved from the sale / branch),
--    single-transaction with advisory locks against double-submit races.
-- 2. platform_metrics() / platform_tenant_summary(): SECURITY DEFINER
--    functions replacing the platform_* views. Each asserts
--    profiles.role = 'platform_admin' and raises otherwise. The views are
--    dropped (their only reader, PlatformDashboard.jsx, now uses rpc()).
-- 3. v_* reporting views: same columns, plus
--    WHERE <alias>.tenant_id = public.get_my_tenant() so an owner only ever
--    sees their own tenant. (Views keep security_invoker=true.)
-- All functions declare SET search_path = public. New RPCs are revoked from
-- anon/public and granted to authenticated (server-side checks apply).
-- Non-destructive: no existing function body is altered; view column lists
-- are unchanged (CREATE OR REPLACE stays valid).
-- ============================================================================

-- ============================================================================
-- 1a. create_sales_return(return_data jsonb) -> uuid
-- Payload: { sale_id uuid, reason text|null,
--            items: [{ sale_item_id uuid, quantity_returned numeric }] }
-- Effects: sales_returns (completed) + return_items rows, restocks
-- products.stock_quantity AND branch_stock at the sale's branch, adjusts
-- amount_paid and, for credit sales, the customer balance + a
-- credit_transactions entry. Returns the sales_returns id.
-- ============================================================================
create or replace function public.create_sales_return(return_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant      uuid := public.get_my_tenant();
  v_caller      uuid := public.auth_uid();
  v_is_admin    boolean := public.is_platform_admin();
  v_sale        public.sales%rowtype;
  v_item        jsonb;
  v_line        public.sale_items%rowtype;
  v_product     public.products%rowtype;
  v_subtotal    numeric := 0;
  v_refund      numeric := 0;
  v_return_id   uuid;
  v_branch      uuid;
  v_restock     numeric;
  v_line_refund numeric;
  v_already     numeric;
  v_qty         numeric;
  v_customer    public.customers%rowtype;
  v_new_paid    numeric;
  v_new_bal     numeric;
  v_agg         record;
begin
  -- Permission: owner of the tenant, or platform admin (whose tenant is then
  -- resolved from the sale itself, since admins hold no membership row).
  if not (public.is_tenant_owner() or v_is_admin) then
    raise exception 'Owner permissions required';
  end if;

  if return_data is null or (return_data ->> 'sale_id') is null then
    raise exception 'sale_id is required';
  end if;
  if (select coalesce(jsonb_array_length(return_data -> 'items'), 0)) < 1 then
    raise exception 'Return must contain at least one item';
  end if;

  if v_is_admin and v_tenant is null then
    select s.tenant_id into v_tenant
      from public.sales s
     where s.id = (return_data ->> 'sale_id')::uuid;
  end if;
  if v_tenant is null then
    raise exception '15999 No active tenant';
  end if;

  -- Serialize concurrent returns of the same sale (double-click / retry).
  perform pg_advisory_xact_lock(
    hashtextextended('sales_return_' || (return_data ->> 'sale_id'), 0));

  select * into v_sale
    from public.sales s
   where s.id = (return_data ->> 'sale_id')::uuid
     and s.tenant_id = v_tenant
     and s.type = 'pos'
     and s.status = 'completed'
   for update;
  if not found then
    raise exception 'Completed sale not found in current tenant';
  end if;

  -- Denominator for the pro-rata discount share (same formula as create_sale).
  select coalesce(sum(si.line_total), 0) into v_subtotal
    from public.sale_items si
   where si.sale_id = v_sale.id
     and si.tenant_id = v_tenant;

  v_branch := coalesce(v_sale.branch_id, public.ensure_default_branch(v_tenant));

  drop table if exists tmp_return_lines;
  create temp table tmp_return_lines (
    sale_item_id uuid,
    product_id uuid,
    quantity_returned numeric,
    restocked_pieces numeric,
    refund_amount numeric
  ) on commit drop;

  for v_item in
    select * from jsonb_array_elements(return_data -> 'items')
  loop
    v_qty := coalesce((v_item ->> 'quantity_returned')::numeric, 0);
    if v_qty <= 0 then
      raise exception 'Return quantities must be greater than zero';
    end if;

    select * into v_line
      from public.sale_items si
     where si.id = (v_item ->> 'sale_item_id')::uuid
       and si.sale_id = v_sale.id
       and si.tenant_id = v_tenant;
    if not found then
      raise exception 'Sale item not found on this sale';
    end if;

    -- Cap by what is still returnable (prior non-rejected returns excluded).
    select coalesce(sum(ri.quantity_returned), 0) into v_already
      from public.return_items ri
      join public.sales_returns sr on sr.id = ri.return_id
     where ri.sale_item_id = v_line.id
       and ri.tenant_id = v_tenant
       and sr.status <> 'rejected';
    if v_already + v_qty > v_line.quantity_sold + 1e-9 then
      raise exception 'Cannot return more than was sold for item %', v_line.id;
    end if;

    select * into v_product
      from public.products p
     where p.id = v_line.product_id
       and p.tenant_id = v_tenant;
    if not found then
      raise exception 'Product not found in current tenant: %', v_line.product_id;
    end if;

    -- Server-side refund: base + tax, minus the line's share of the discount.
    v_line_refund :=
      greatest(0,
        v_qty * v_line.unit_price
        + v_qty * v_line.unit_price * coalesce(v_product.tax_rate, 0) / 100
        - case when v_subtotal > 0
               then coalesce(v_sale.discount_total, 0)
                    * (v_qty * v_line.unit_price / v_subtotal)
               else 0 end);
    -- Restock in pieces, pro-rata of the line's original deduction.
    v_restock := case when coalesce(v_line.quantity_sold, 0) > 0
      then coalesce(v_line.stock_deduction_pieces, 0) * v_qty / v_line.quantity_sold
      else 0 end;

    v_refund := v_refund + v_line_refund;
    insert into tmp_return_lines
      (sale_item_id, product_id, quantity_returned, restocked_pieces, refund_amount)
    values (v_line.id, v_line.product_id, v_qty, v_restock, v_line_refund);
  end loop;

  insert into public.sales_returns
    (tenant_id, sale_id, branch_id, reason, status,
     refund_total, credit_adjusted, created_by)
  values
    (v_tenant, v_sale.id, v_branch,
     nullif(return_data ->> 'reason', ''),
     'completed', v_refund,
     case when v_sale.payment_method = 'credit' then v_refund else 0 end,
     v_caller)
  returning id into v_return_id;

  insert into public.return_items
    (tenant_id, return_id, sale_item_id, quantity_returned,
     refund_amount, restocked_pieces)
  select v_tenant, v_return_id, sale_item_id, quantity_returned,
         refund_amount, greatest(0, floor(restocked_pieces))::integer
    from tmp_return_lines;

  -- Restock the tenant total and the selling branch together. The guard stops
  -- trg_products_sync_branch_stock from re-applying the delta to head office.
  perform set_config('saleshub.skip_branch_sync', 'on', true);
  for v_agg in
    select product_id, sum(restocked_pieces) as pieces
      from tmp_return_lines
     group by product_id
  loop
    update public.products prod
       set stock_quantity = coalesce(stock_quantity, 0) + v_agg.pieces,
           updated_at = now()
     where prod.id = v_agg.product_id
       and prod.tenant_id = v_tenant;

    insert into public.branch_stock as bs
      (tenant_id, branch_id, product_id, stock_quantity)
    values (v_tenant, v_branch, v_agg.product_id, greatest(0, v_agg.pieces)::integer)
    on conflict (branch_id, product_id) do update
      set stock_quantity = greatest(0, bs.stock_quantity + excluded.stock_quantity),
          updated_at = now();
  end loop;

  -- Money: reduce what is marked paid; on credit also relieve the balance.
  v_new_paid := greatest(0, coalesce(v_sale.amount_paid, 0) - v_refund);
  update public.sales
     set amount_paid = v_new_paid,
         updated_at = now()
   where id = v_sale.id;

  if v_sale.payment_method = 'credit' and v_sale.customer_id is not null then
    select * into v_customer
      from public.customers c
     where c.id = v_sale.customer_id
       and c.tenant_id = v_tenant;
    if found then
      v_new_bal := greatest(0, coalesce(v_customer.current_credit_balance, 0) - v_refund);
      update public.customers
         set current_credit_balance = v_new_bal,
             updated_at = now()
       where id = v_customer.id;
      insert into public.credit_transactions
        (tenant_id, customer_id, sale_id, amount, balance_after, notes)
      values (v_tenant, v_customer.id, v_sale.id, -v_refund, v_new_bal, 'Sales return');
    end if;
  end if;

  return v_return_id;
end;
$$;

revoke execute on function public.create_sales_return(jsonb) from anon;
revoke execute on function public.create_sales_return(jsonb) from public;
grant execute on function public.create_sales_return(jsonb) to authenticated;

-- ============================================================================
-- 1b. create_stock_transfer(transfer_data jsonb) -> uuid
-- Payload: { from_branch_id uuid, to_branch_id uuid, notes text|null,
--            items: [{ product_id uuid, quantity integer }] }
-- Effects: stock_transfers (completed) + stock_transfer_items rows, moves the
-- branch_stock ledger source -> destination. products.stock_quantity is
-- untouched (net-zero by construction). Batch-level rows are intentionally
-- NOT moved (see note below). Returns the transfer id.
-- ============================================================================
create or replace function public.create_stock_transfer(transfer_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.get_my_tenant();
  v_caller   uuid := public.auth_uid();
  v_is_admin boolean := public.is_platform_admin();
  v_from     uuid := nullif(transfer_data ->> 'from_branch_id', '')::uuid;
  v_to       uuid := nullif(transfer_data ->> 'to_branch_id', '')::uuid;
  v_item     jsonb;
  v_qty      integer;
  v_avail    integer;
  v_transfer uuid;
  v_agg      record;
begin
  if not (public.is_tenant_owner() or v_is_admin) then
    raise exception 'Owner permissions required';
  end if;

  if v_from is null or v_to is null then
    raise exception 'Both a source and a destination branch are required';
  end if;
  if v_from = v_to then
    raise exception 'Source and destination branch must be different';
  end if;
  if (select coalesce(jsonb_array_length(transfer_data -> 'items'), 0)) < 1 then
    raise exception 'A transfer must include at least one product';
  end if;

  -- Platform admins hold no membership row: resolve the tenant from the
  -- source branch instead (which also proves the branch exists).
  if v_is_admin and v_tenant is null then
    select b.tenant_id into v_tenant
      from public.branches b
     where b.id = v_from;
  end if;
  if v_tenant is null then
    raise exception '15999 No active tenant';
  end if;

  if not exists (
    select 1 from public.branches b
     where b.id = v_from and b.tenant_id = v_tenant) then
    raise exception 'Source branch not found in current tenant';
  end if;
  if not exists (
    select 1 from public.branches b
     where b.id = v_to and b.tenant_id = v_tenant) then
    raise exception 'Destination branch not found in current tenant';
  end if;

  -- Lock both branch ledgers in a fixed order (deadlock-safe) for the txn.
  perform pg_advisory_xact_lock(
    hashtextextended('branch_stock_' || least(v_from, v_to)::text, 0));
  perform pg_advisory_xact_lock(
    hashtextextended('branch_stock_' || greatest(v_from, v_to)::text, 0));

  drop table if exists tmp_transfer_lines;
  create temp table tmp_transfer_lines (
    product_id uuid,
    quantity integer
  ) on commit drop;

  for v_item in
    select * from jsonb_array_elements(transfer_data -> 'items')
  loop
    v_qty := floor(coalesce((v_item ->> 'quantity')::numeric, 0))::integer;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Transfer quantities must be greater than zero';
    end if;

    if not exists (
      select 1 from public.products p
       where p.id = (v_item ->> 'product_id')::uuid
         and p.tenant_id = v_tenant
         and coalesce(p.is_deleted, false) = false) then
      raise exception 'Product not found in current tenant: %', v_item ->> 'product_id';
    end if;

    select coalesce(bs.stock_quantity, 0) into v_avail
      from public.branch_stock bs
     where bs.branch_id = v_from
       and bs.product_id = (v_item ->> 'product_id')::uuid
       and bs.tenant_id = v_tenant;
    v_avail := coalesce(v_avail, 0);
    if v_qty > v_avail then
      raise exception 'Source branch only has % of product % (requested %)',
        v_avail, (v_item ->> 'product_id'), v_qty;
    end if;

    insert into tmp_transfer_lines (product_id, quantity)
    values ((v_item ->> 'product_id')::uuid, v_qty);
  end loop;

  insert into public.stock_transfers
    (tenant_id, from_branch_id, to_branch_id, status, notes, created_by, completed_at)
  values
    (v_tenant, v_from, v_to, 'completed',
     nullif(transfer_data ->> 'notes', ''), v_caller, now())
  returning id into v_transfer;

  insert into public.stock_transfer_items (tenant_id, transfer_id, product_id, quantity)
  select v_tenant, v_transfer, product_id, quantity
    from tmp_transfer_lines;

  -- Move the ledger. products.stock_quantity is the tenant total and stays
  -- exactly where it is (net-zero). product_batches rows are NOT moved: batch
  -- identity (batch_number/expiry) does not survive a branch move without a
  -- restow policy, which is a follow-up; the branch ledger remains the
  -- authoritative per-branch figure (BatchManagement reads it via
  -- get_batches only for FIFO sale deduction).
  for v_agg in
    select product_id, sum(quantity)::integer as qty
      from tmp_transfer_lines
     group by product_id
  loop
    update public.branch_stock bs
       set stock_quantity = greatest(0, bs.stock_quantity - v_agg.qty),
           updated_at = now()
     where bs.branch_id = v_from
       and bs.product_id = v_agg.product_id
       and bs.tenant_id = v_tenant;

    insert into public.branch_stock as bs
      (tenant_id, branch_id, product_id, stock_quantity)
    values (v_tenant, v_to, v_agg.product_id, v_agg.qty)
    on conflict (branch_id, product_id) do update
      set stock_quantity = bs.stock_quantity + excluded.stock_quantity,
          updated_at = now();
  end loop;

  return v_transfer;
end;
$$;

revoke execute on function public.create_stock_transfer(jsonb) from anon;
revoke execute on function public.create_stock_transfer(jsonb) from public;
grant execute on function public.create_stock_transfer(jsonb) to authenticated;

-- ============================================================================
-- 2. Platform functions (replace the platform_* views).
-- Each asserts platform_admin via profiles.role; anything else raises.
-- ============================================================================
drop view if exists public.platform_metrics;
drop view if exists public.platform_tenant_summary;

create or replace function public.platform_metrics()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin permissions required';
  end if;

  return (
    select jsonb_build_object(
      'total_tenants', count(distinct t.id)::int,
      'total_branches', count(distinct b.id)::int,
      'total_employees', count(distinct tm.id)::int,
      'total_customers', count(distinct c.id)::int,
      'total_sales_amount',
        coalesce(sum(s.total_amount), 0)::numeric,
      'active_subscriptions',
        count(distinct s_sub.id)
          filter (where s_sub.status = 'active')::int,
      'pending_payment_requests',
        count(distinct pr.id)
          filter (where pr.status = 'pending')::int
    )
    from public.tenants t
    left join public.branches b on b.tenant_id = t.id
    left join public.tenant_memberships tm on tm.tenant_id = t.id
    left join public.customers c on c.tenant_id = t.id
    left join public.sales s
      on s.tenant_id = t.id and s.status = 'completed'
    left join public.subscriptions s_sub on s_sub.tenant_id = t.id
    left join public.payment_requests pr on pr.tenant_id = t.id
  );
end;
$$;

comment on function public.platform_metrics() is
  'Cross-tenant totals for the CEO dashboard; platform_admin only (raises otherwise).';

create or replace function public.platform_tenant_summary()
returns table (
  tenant_id uuid,
  tenant_name text,
  branches_count integer,
  employees_count integer,
  customers_count integer,
  subscription_status text,
  plan_id text,
  created_at date
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin permissions required';
  end if;

  return query
  select
    t.id::uuid,
    t.name,
    count(distinct b.id)::int,
    count(distinct tm.id)::int,
    count(distinct c.id)::int,
    t.subscription_status,
    t.plan_id,
    t.created_at::date
  from public.tenants t
  left join public.branches b on b.tenant_id = t.id
  left join public.tenant_memberships tm on tm.tenant_id = t.id
  left join public.customers c on c.tenant_id = t.id
  group by t.id, t.name, t.subscription_status, t.plan_id, t.created_at;
end;
$$;

revoke execute on function public.platform_metrics() from anon;
revoke execute on function public.platform_metrics() from public;
grant execute on function public.platform_metrics() to authenticated;
revoke execute on function public.platform_tenant_summary() from anon;
revoke execute on function public.platform_tenant_summary() from public;
grant execute on function public.platform_tenant_summary() to authenticated;

comment on function public.platform_metrics() is
  'Cross-tenant totals for the CEO dashboard; platform_admin only (raises otherwise).';
comment on function public.platform_tenant_summary() is
  'Per-tenant aggregates for the CEO dashboard; platform_admin only (raises otherwise).';

-- ============================================================================
-- 3. Tenant-scope the reporting views (same columns, own-tenant rows only).
-- ============================================================================
create or replace view public.v_sales_summary with (security_invoker = true) as
select
  date_trunc('day', s.created_at) as sale_date,
  s.tenant_id,
  count(s.id) as total_sales,
  coalesce(sum(s.discount_total), 0) as total_discounts,
  coalesce(sum(s.total_amount), 0) as total_sales_amount,
  coalesce(sum(s.tax_amount), 0) as total_tax,
  count(s.id) filter (where s.payment_method = 'cash') as cash_sales,
  count(s.id) filter (where s.payment_method = 'mobile_money') as mobile_money_sales,
  count(s.id) filter (where s.payment_method = 'credit') as credit_sales
from public.sales s
where s.tenant_id = public.get_my_tenant()
group by date_trunc('day', s.created_at), s.tenant_id;

create or replace view public.v_daily_sales with (security_invoker = true) as
select
  date(s.created_at) as sale_date,
  count(s.id) as num_sales,
  coalesce(sum(s.total_amount), 0) as daily_total,
  coalesce(sum(s.discount_total), 0) as daily_discounts,
  coalesce(sum(s.tax_amount), 0) as daily_tax
from public.sales s
where s.status = 'completed'
  and s.tenant_id = public.get_my_tenant()
group by date(s.created_at)
order by sale_date desc
limit 30;

create or replace view public.v_sales_by_category with (security_invoker = true) as
select
  p.category,
  count(si.id) as items_sold,
  coalesce(sum(si.line_total), 0) as revenue,
  coalesce(sum(si.line_total) * coalesce(p.tax_rate, 0) / 100, 0) as tax_amount
from public.sale_items si
join public.products p on si.product_id = p.id and p.tenant_id = si.tenant_id
join public.sales s on si.sale_id = s.id and s.tenant_id = p.tenant_id and s.status = 'completed'
where si.tenant_id = public.get_my_tenant()
group by p.category
order by revenue desc;

create or replace view public.v_inventory_valuation with (security_invoker = true) as
select
  p.id as product_id,
  p.name as product_name,
  p.sku,
  coalesce(sum(bs.stock_quantity), 0) as total_stock,
  coalesce(sum(bs.stock_quantity) * p.price_per_piece, 0) as total_value,
  p.tenant_id
from public.products p
left join public.branch_stock bs on bs.product_id = p.id and bs.tenant_id = p.tenant_id
where p.tenant_id = public.get_my_tenant()
group by p.id, p.name, p.sku, p.price_per_piece, p.tenant_id;

create or replace view public.v_credit_outstanding with (security_invoker = true) as
select
  c.id as customer_id,
  c.name as customer_name,
  c.phone,
  c.current_credit_balance,
  c.credit_limit,
  case when (c.current_credit_balance > c.credit_limit) then true else false end as is_over_limit,
  coalesce(count(sc.id), 0) as num_credit_sales,
  coalesce(sum(sc.amount), 0) as total_credit_amount
from public.customers c
left join public.credit_transactions sc on sc.customer_id = c.id and sc.tenant_id = c.tenant_id
where c.tenant_id = public.get_my_tenant()
group by c.id, c.name, c.phone, c.current_credit_balance, c.credit_limit;

create or replace view public.v_employee_sales with (security_invoker = true) as
select
  u.full_name as employee_name,
  u.id as user_id,
  count(s.id) as total_sales,
  coalesce(sum(s.total_amount), 0) as total_sales_amount,
  coalesce(sum(s.discount_total), 0) as total_discounts,
  coalesce(sum(s.tax_amount), 0) as total_tax
from public.sales s
join public.profiles u on s.cashier_id = u.id
where s.tenant_id = public.get_my_tenant()
group by u.id, u.full_name
order by total_sales_amount desc;

grant select on public.v_sales_summary to authenticated;
grant select on public.v_daily_sales to authenticated;
grant select on public.v_sales_by_category to authenticated;
grant select on public.v_inventory_valuation to authenticated;
grant select on public.v_credit_outstanding to authenticated;
grant select on public.v_employee_sales to authenticated;

-- ============================================================================
-- End of 20261209000000_security_gaps_rpc_views.sql
-- ============================================================================
