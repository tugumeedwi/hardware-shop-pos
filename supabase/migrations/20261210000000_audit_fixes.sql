-- ============================================================================
-- Audit fixes: product_batches RLS, batch trigger repair, hot-path indexes
-- ----------------------------------------------------------------------------
-- 1. product_batches had NO row-level security and NO policies: any
--    authenticated user could read/write every tenant's batches. Fixed here
--    with the same contract as the other phase-1 tables (member SELECT,
--    owner-gated writes; BatchManagement is an owner-only route).
-- 2. products_sync_batch_stock() was broken in two ways and made EVERY
--    product_batches INSERT/UPDATE fail:
--      a. it summed a column named "qty" (the real column is "quantity"),
--      b. the DELETE branch read NEW.* (null on delete) and never
--         adjusted the ledger.
--    Rewritten DELTA-based: a batch row records physical stock, so inserting
--    a batch adds its quantity to the branch ledger, deleting one subtracts
--    it, and edits/moves shift the difference. A full recompute
--    (ledger := sum(batches)) was deliberately NOT used: most products hold
--    pre-batch ledger stock with no batch rows, and recomputing would wipe
--    that stock the first time any batch is recorded.
--    (Also fixes the DROP TRIGGER line, which named the wrong table.)
-- 3. Composite indexes for the transfer/return hot paths.
-- All statements are idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. RLS for product_batches
-- ----------------------------------------------------------------------------
alter table public.product_batches enable row level security;

drop policy if exists tenant_isolation_select on public.product_batches;
create policy tenant_isolation_select on public.product_batches
  for select to authenticated
  using (tenant_id = public.get_my_tenant());

drop policy if exists tenant_isolation_insert on public.product_batches;
create policy tenant_isolation_insert on public.product_batches
  for insert to authenticated
  with check (tenant_id = public.get_my_tenant() and public.is_tenant_owner());

drop policy if exists tenant_isolation_update on public.product_batches;
create policy tenant_isolation_update on public.product_batches
  for update to authenticated
  using (tenant_id = public.get_my_tenant() and public.is_tenant_owner())
  with check (tenant_id = public.get_my_tenant() and public.is_tenant_owner());

drop policy if exists tenant_isolation_delete on public.product_batches;
create policy tenant_isolation_delete on public.product_batches
  for delete to authenticated
  using (tenant_id = public.get_my_tenant() and public.is_tenant_owner());

grant select, insert, update, delete on public.product_batches to authenticated;

-- ----------------------------------------------------------------------------
-- 2. Repair the batch -> branch_stock sync trigger
-- ----------------------------------------------------------------------------
create or replace function public.products_sync_batch_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_qty integer;
  v_new_qty integer;
  v_moved   boolean;
begin
  v_old_qty := greatest(0, coalesce(OLD.quantity, 0));
  v_new_qty := greatest(0, coalesce(NEW.quantity, 0));
  v_moved   := TG_OP = 'UPDATE'
               and (NEW.branch_id is distinct from OLD.branch_id
                    or NEW.product_id is distinct from OLD.product_id);
  -- Suppress trg_products_sync_branch_stock (which would otherwise re-apply
  -- every products.total change to the head-office ledger and double count).
  perform set_config('saleshub.skip_branch_sync', 'on', true);

  if TG_OP = 'DELETE' or v_moved then
    -- Remove the old row's effect: branch ledger and tenant total.
    update public.branch_stock bs
       set stock_quantity = greatest(0, bs.stock_quantity - v_old_qty),
           updated_at = now()
     where bs.branch_id = OLD.branch_id
       and bs.product_id = OLD.product_id;
    update public.products p
       set stock_quantity = greatest(0, coalesce(p.stock_quantity, 0) - v_old_qty),
           updated_at = now()
     where p.id = OLD.product_id;
  end if;

  if TG_OP = 'INSERT' or v_moved then
    -- Add the new row's effect in full.
    insert into public.branch_stock as bs
      (tenant_id, branch_id, product_id, stock_quantity)
    values (NEW.tenant_id, NEW.branch_id, NEW.product_id, v_new_qty)
    on conflict (branch_id, product_id) do update
      set stock_quantity = bs.stock_quantity + excluded.stock_quantity,
          updated_at = now();
    update public.products p
       set stock_quantity = coalesce(p.stock_quantity, 0) + v_new_qty,
           updated_at = now()
     where p.id = NEW.product_id;
  end if;

  if TG_OP = 'UPDATE' and not v_moved
     and v_new_qty is distinct from v_old_qty then
    -- In-place quantity edit: shift both layers by the difference.
    update public.branch_stock bs
       set stock_quantity = greatest(0, bs.stock_quantity + (v_new_qty - v_old_qty)),
           updated_at = now()
     where bs.branch_id = NEW.branch_id
       and bs.product_id = NEW.product_id;
    update public.products p
       set stock_quantity = greatest(0, coalesce(p.stock_quantity, 0)
                                         + (v_new_qty - v_old_qty)),
           updated_at = now()
     where p.id = NEW.product_id;
  end if;

  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_products_sync_batch_stock on public.product_batches;
create trigger trg_products_sync_batch_stock
  after insert or update or delete on public.product_batches
  for each row execute function public.products_sync_batch_stock();

-- ----------------------------------------------------------------------------
-- 3. Hot-path composite indexes
-- ----------------------------------------------------------------------------
-- SalesHistory RETURNED pill: .in('sale_id', ids) + status = 'completed'.
create index if not exists idx_sales_returns_sale_status
  on public.sales_returns (sale_id, status);

-- StockTransfer history: tenant list ordered by recency.
create index if not exists idx_stock_transfers_tenant_created
  on public.stock_transfers (tenant_id, created_at desc);

-- SalesHistory return modal: prior returns per sale item (join + filter).
create index if not exists idx_return_items_sale_item_tenant
  on public.return_items (sale_item_id, tenant_id);

-- ----------------------------------------------------------------------------
-- 4. Persist the server-recalculated tax (create_sale computed v_tax but never
--    stored it, so sales.tax_amount stayed 0 for every sale). Only change vs
--    20260921000000: tax_amount added to the sales INSERT.
-- ----------------------------------------------------------------------------
create or replace function public.create_sale(sale_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant    uuid := public.get_my_tenant();
  v_cashier   uuid := public.auth_uid();
  v_customer  uuid;
  v_cust_rec  public.customers%rowtype;
  v_sale_id   uuid;
  v_item      jsonb;
  v_rec       record;
  v_product   public.products%rowtype;
  v_unit      text;
  v_qty       numeric;
  v_unit_p    numeric;
  v_deduction numeric;
  v_line      numeric;
  v_total     numeric := 0;
  v_tax       numeric := 0;
  v_discount  numeric;
  v_final     numeric;
  v_client    numeric;
  v_balance   numeric;
  v_payment   text := sale_data ->> 'payment_method';
  v_sale_type text := coalesce(sale_data ->> 'type', 'pos');
  v_branch    uuid;
  v_available numeric;
  v_assigned  uuid;
  v_is_owner  boolean;
  v_points_awarded integer := 0;
  v_points_earned numeric;
begin
  if v_tenant is null then
    raise exception '15999 No active tenant';
  end if;

  -- Idempotency: return existing sale if this key already created one
  if (sale_data ->> 'idempotency_key') is not null then
    select s.id into v_sale_id
      from public.sales s
     where s.tenant_id = v_tenant
       and s.idempotency_key = sale_data ->> 'idempotency_key'
     limit 1;
    if v_sale_id is not null then
      return v_sale_id;
    end if;
  end if;

  -- The acting member is the authoritative cashier; never trust a client id.
  if v_cashier is null then
    v_cashier := (sale_data ->> 'cashier_id')::uuid;
  end if;

  -- Branch resolution, in priority order:
  --   1. a cashier assigned to a branch ALWAYS sells from that branch. The
  --      client's branch_id is ignored for them - the same principle as the
  --      price and total recalculation below, so a tampered or stale payload
  --      can never drain another branch's shelves.
  --   2. an owner (or a member with no assignment) may name any branch of
  --      their own tenant.
  --   3. otherwise fall back to the member's assignment, then the tenant
  --      default, creating it if this tenant somehow has none.
  v_is_owner := public.is_tenant_owner();
  v_assigned := public.assigned_branch_id(v_tenant, v_cashier);
  v_branch   := nullif(sale_data ->> 'branch_id', '')::uuid;

  if v_assigned is not null and not v_is_owner then
    v_branch := v_assigned;
  elsif v_branch is not null then
    if not exists (
      select 1 from public.branches b
       where b.id = v_branch and b.tenant_id = v_tenant
    ) then
      raise exception 'Branch not found in current tenant';
    end if;
  else
    v_branch := coalesce(v_assigned, public.ensure_default_branch(v_tenant));
  end if;

  -- A sale with no line items is meaningless.
  if (select jsonb_array_length(coalesce(sale_data -> 'items', '[]'::jsonb))) < 1 then
    raise exception 'Sale must contain at least one item';
  end if;

  drop table if exists tmp_sale_items;
  create temp table tmp_sale_items (
    product_id uuid,
    selling_unit text,
    quantity_sold numeric,
    unit_price numeric,
    stock_deduction_pieces numeric,
    line_total numeric
  ) on commit drop;

  -- Recalculate every line against the live catalog
  for v_item in select * from jsonb_array_elements(coalesce(sale_data -> 'items', '[]'::jsonb)) loop
    select * into v_product
      from public.products p
     where p.id = (v_item ->> 'product_id')::uuid
       and p.tenant_id = v_tenant
       and coalesce(p.is_deleted, false) = false;

    if not found then
      insert into public.sync_conflict_log (tenant_id, table_name, record_id, local_data, server_data)
      values (v_tenant, 'products', (v_item ->> 'product_id')::uuid,
              jsonb_build_object('sale_id', sale_data ->> 'offline_created_at', 'product_id', v_item ->> 'product_id'),
              jsonb_build_object('error', 'Product not found'));
      raise exception 'Product not found: %', v_item ->> 'product_id';
    end if;

    v_unit := v_item ->> 'selling_unit';
    v_qty  := coalesce((v_item ->> 'quantity_sold')::numeric, 0);

    -- Reject tampering: quantities must be positive and the unit must be one
    -- the product is actually sold in.
    if v_qty <= 0 then
      raise exception 'Invalid quantity for product %', v_product.id;
    end if;
    if not (v_unit = any (coalesce(v_product.active_pricing_methods, '{}'::text[]))) then
      raise exception 'Invalid selling unit % for product %', v_unit, v_product.id;
    end if;

    v_unit_p := case v_unit
      when 'piece' then coalesce(v_product.price_per_piece, 0)
      when 'box'   then coalesce(v_product.price_per_box, 0)
      when 'sqm'   then coalesce(v_product.price_per_sqm, 0)
      when 'kg'    then coalesce(v_product.price_per_kg, 0)
      else 0 end;

    -- Quotations only reserve stock at conversion time.
    v_deduction := case
      when v_sale_type = 'quotation' then 0
      when v_unit = 'piece' then v_qty
      when v_unit = 'box'   then v_qty * coalesce(v_product.pieces_per_box, 0)
      when v_unit = 'sqm'   then case when coalesce(v_product.m2_per_piece, 0) > 0
                                     then ceil(v_qty / v_product.m2_per_piece) else 0 end
      when v_unit = 'kg'    then case when coalesce(v_product.pieces_per_kg, 0) > 0
                                     then ceil(v_qty * v_product.pieces_per_kg) else 0 end
      else 0 end;

    if v_deduction > coalesce(v_product.stock_quantity, 0) then
      insert into public.sync_conflict_log (tenant_id, table_name, record_id, local_data, server_data)
      values (v_tenant, 'products', v_product.id,
              jsonb_build_object('sale_id', sale_data ->> 'offline_created_at',
                                 'deduction', v_deduction, 'product_id', v_product.id),
              jsonb_build_object('stock_quantity', v_product.stock_quantity));
      raise exception 'Insufficient stock for product %', v_product.id;
    end if;

    v_line := v_qty * v_unit_p;
    v_total := v_total + v_line;
    v_tax   := v_tax + v_line * (coalesce(v_product.tax_rate, 0) / 100);

    insert into tmp_sale_items (product_id, selling_unit, quantity_sold, unit_price, stock_deduction_pieces, line_total)
    values (v_product.id, v_unit, v_qty, v_unit_p, v_deduction, v_line);
  end loop;

  -- Stock is held per branch, and the same product may appear on several lines,
  -- so the authoritative check is the per-product TOTAL against the selling
  -- branch's ledger. (The per-line check above only catches the obvious case
  -- and logs the conflict for the sync inspector.)
  if v_sale_type <> 'quotation' and v_branch is not null then
    for v_rec in
      select product_id, sum(stock_deduction_pieces) as pieces
        from tmp_sale_items
       group by product_id
      having sum(stock_deduction_pieces) > 0
    loop
      select coalesce(bs.stock_quantity, 0) into v_available
        from public.branch_stock bs
       where bs.branch_id = v_branch
         and bs.product_id = v_rec.product_id;

      if v_available is null then
        v_available := 0;
      end if;

      if v_rec.pieces > v_available then
        insert into public.sync_conflict_log (tenant_id, table_name, record_id, local_data, server_data)
        values (v_tenant, 'branch_stock', v_rec.product_id,
                jsonb_build_object('sale_id', sale_data ->> 'offline_created_at',
                                   'deduction', v_rec.pieces,
                                   'branch_id', v_branch,
                                   'product_id', v_rec.product_id),
                jsonb_build_object('branch_stock', v_available));
        raise exception 'Insufficient stock at this branch for product %', v_rec.product_id;
      end if;
    end loop;
  end if;

  -- Tamper check: recalculation must match what the client reported, and a
  -- discount may only be non-negative and never exceed the recalculated total.
  v_discount := coalesce((sale_data ->> 'discount_total')::numeric, 0);
  if v_discount < 0 or v_discount > v_total then
    raise exception 'Invalid discount';
  end if;
  v_final  := v_total - v_discount + v_tax;
  v_client := coalesce((sale_data ->> 'total_amount')::numeric, 0);
  if abs(v_final - v_client) > 0.01 then
    insert into public.sync_conflict_log (tenant_id, table_name, record_id, local_data, server_data)
    values (v_tenant, 'sales', null,
            jsonb_build_object('client_total', v_client, 'client_discount', v_discount, 'items', sale_data -> 'items'),
            jsonb_build_object('recalculated_total', v_final));
    raise exception 'Sale total mismatch – possible tampering';
  end if;

  -- Customer must belong to the caller's tenant (dangling foreign references
  -- leak nothing through RLS but pollute cross-tenant joins and receipts).
  v_customer := (sale_data ->> 'customer_id')::uuid;
  if v_customer is not null then
    select * into v_cust_rec
      from public.customers c
     where c.id = v_customer
       and c.tenant_id = v_tenant;
    if not found then
      if v_payment = 'credit' then
        raise exception 'Customer not found in current tenant';
      end if;
      v_customer := null;
    end if;
  end if;
  if v_payment = 'credit' and v_customer is null then
    raise exception 'A credit sale requires a valid customer';
  end if;

  -- Insert the sale
  insert into public.sales (
    tenant_id, branch_id, customer_id, cashier_id, type, status, payment_method,
    discount_total, tax_amount, total_amount, amount_paid, notes, offline_created_at,
    sync_status, idempotency_key, expiry_date
  ) values (
    v_tenant,
    v_branch,
    v_customer,
    v_cashier,
    v_sale_type,
    coalesce(sale_data ->> 'status', 'completed'),
    case when v_sale_type = 'quotation' then null else coalesce(v_payment, 'cash') end,
    v_discount,
    v_tax,
    v_final,
    greatest(0, coalesce((sale_data ->> 'amount_paid')::numeric, 0)),
    nullif(sale_data ->> 'notes', ''),
    (sale_data ->> 'offline_created_at')::timestamptz,
    'synced',
    sale_data ->> 'idempotency_key',
    case when sale_data ? 'expiry_date' and (sale_data ->> 'expiry_date') is not null
         then (sale_data ->> 'expiry_date')::date else null end
  ) returning id into v_sale_id;

  insert into public.sale_items (sale_id, tenant_id, branch_id, product_id, selling_unit, quantity_sold, unit_price, stock_deduction_pieces, line_total)
  select v_sale_id, v_tenant, v_branch, product_id, selling_unit, quantity_sold, unit_price, stock_deduction_pieces, line_total
    from tmp_sale_items;

  -- Deduct stock (POS sales only) from both the tenant total and the selling
  -- branch. The guard stops trg_products_sync_branch_stock from also applying
  -- the delta to the head office.
  if v_sale_type <> 'quotation' then
    perform set_config('saleshub.skip_branch_sync', 'on', true);

    for v_rec in
      select product_id, sum(stock_deduction_pieces) as pieces
        from tmp_sale_items
       group by product_id
    loop
      update public.products prod
         set stock_quantity = greatest(0, stock_quantity - v_rec.pieces),
             updated_at = now()
       where prod.id = v_rec.product_id
         and prod.tenant_id = v_tenant;

      if v_branch is not null and v_rec.pieces > 0 then
        update public.branch_stock bs
           set stock_quantity = greatest(0, bs.stock_quantity - v_rec.pieces),
               updated_at = now()
         where bs.branch_id = v_branch
           and bs.product_id = v_rec.product_id;
      end if;
    end loop;
  end if;

  -- Credit handling (limit enforced server-side)
  if v_payment = 'credit' then
    v_balance := coalesce(v_cust_rec.current_credit_balance, 0) + v_final;
    if v_balance > coalesce(v_cust_rec.credit_limit, 0) then
      raise exception 'Credit limit exceeded after recalculation';
    end if;
    update public.customers
       set current_credit_balance = v_balance,
           updated_at = now()
     where id = v_cust_rec.id;
    insert into public.credit_transactions (tenant_id, customer_id, sale_id, amount, balance_after, notes)
    values (v_tenant, v_cust_rec.id, v_sale_id, v_final, v_balance, 'POS credit sale');
  end if;

  -- ============================================================
  -- LOYALTY POINTS: Award points if loyalty is enabled for tenant
  -- ============================================================
  if v_tenant is not null then
    -- Check if loyalty is enabled for this tenant
    if exists (select 1 from public.tenants t where t.id = v_tenant and t.loyalty_enabled = true) then
      -- Calculate points earned: 1 point per 1000 UGX of the sale total
      -- Use the final amount after discount but before tax (v_total)
      v_points_earned := greatest(0, floor(v_total / 1000));
      if v_points_earned > 0 then
        -- Upsert: increment existing points or insert new
        insert into public.loyalty_points (tenant_id, customer_id, points, updated_at)
        values (v_tenant, v_customer, v_points_earned, now())
        on conflict (tenant_id, customer_id)
        do update set points = loyalty_points.points + excluded.points,
                    updated_at = now();
        v_points_awarded := v_points_earned;
      end if;
    end if;
  end if;

  return v_sale_id;
end;
$$;


revoke execute on function public.create_sale(jsonb) from anon;
revoke execute on function public.create_sale(jsonb) from public;
grant execute on function public.create_sale(jsonb) to authenticated;

-- ============================================================================
-- End of 20261210000000_audit_fixes.sql
-- ============================================================================
