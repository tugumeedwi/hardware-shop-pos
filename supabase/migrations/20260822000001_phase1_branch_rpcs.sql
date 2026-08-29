-- ============================================================================
-- Phase 1 expansion: branch-aware create_sale + returns / transfer RPCs
-- ----------------------------------------------------------------------------
-- All three functions are security definer and scope every statement by the
-- caller's tenant. Money and stock are recalculated server-side; the client is
-- never trusted with a refund amount or a stock delta.
--
-- create_sale keeps its existing contract intact - same tamper check, same
-- idempotency, same recalculation - and only adds branch resolution and a
-- second stock write against the per-branch ledger. A payload without
-- branch_id (an old client, or a sale queued offline before this deploy) still
-- works: it falls back to the tenant's default branch.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. create_sale, now branch aware
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

  -- Branch resolution. A named branch must belong to the caller's tenant (a
  -- forged id would otherwise move stock between shops). No branch named means
  -- the tenant default, creating it if this tenant somehow has none.
  v_branch := nullif(sale_data ->> 'branch_id', '')::uuid;
  if v_branch is not null then
    if not exists (
      select 1 from public.branches b
       where b.id = v_branch and b.tenant_id = v_tenant
    ) then
      raise exception 'Branch not found in current tenant';
    end if;
  else
    v_branch := public.ensure_default_branch(v_tenant);
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
    discount_total, total_amount, amount_paid, notes, offline_created_at,
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

  return v_sale_id;
end;
$$;

grant execute on function public.create_sale(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. create_sales_return
-- ----------------------------------------------------------------------------
-- return_data shape:
--   {
--     "sale_id":   "<uuid>",
--     "reason":    "faulty tap",
--     "branch_id": "<uuid>",            -- optional, defaults to the sale's branch
--     "items": [ { "sale_item_id": "<uuid>", "quantity_returned": 2 }, ... ]
--   }
--
-- The refund is computed here, never accepted from the client:
--
--   base      = quantity_returned * unit_price
--   tax       = base * product.tax_rate / 100
--   discount  = sale.discount_total * (base / sale subtotal)     -- fair share
--   refund    = base + tax - discount
--
-- Restocked pieces are apportioned from the original line's
-- stock_deduction_pieces, so unit conversions (box / sqm / kg) come back in the
-- same pieces they left in. Over-returning is impossible: every line is checked
-- against what has already been returned on earlier, non-rejected returns.
create or replace function public.create_sales_return(return_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant    uuid := public.get_my_tenant();
  v_user      uuid := public.auth_uid();
  v_sale      public.sales%rowtype;
  v_branch    uuid;
  v_return_id uuid;
  v_item      jsonb;
  v_si        record;
  v_qty       numeric;
  v_already   numeric;
  v_base      numeric;
  v_tax       numeric;
  v_disc      numeric;
  v_refund    numeric;
  v_subtotal  numeric;
  v_pieces    integer;
  v_count     integer := 0;
  v_total     numeric := 0;
  v_credit    numeric := 0;
  v_balance   numeric;
begin
  if v_tenant is null then
    raise exception 'No active tenant';
  end if;
  if not public.is_tenant_owner() then
    raise exception 'Only the shop owner can record a return';
  end if;

  select * into v_sale
    from public.sales s
   where s.id = nullif(return_data ->> 'sale_id', '')::uuid
     and s.tenant_id = v_tenant;
  if not found then
    raise exception 'Sale not found in current tenant';
  end if;
  if coalesce(v_sale.type, 'pos') <> 'pos' or coalesce(v_sale.status, '') <> 'completed' then
    raise exception 'Only completed sales can be returned';
  end if;

  if (select jsonb_array_length(coalesce(return_data -> 'items', '[]'::jsonb))) < 1 then
    raise exception 'A return must include at least one item';
  end if;

  -- Stock goes back to the branch that sold it unless the owner says otherwise.
  v_branch := nullif(return_data ->> 'branch_id', '')::uuid;
  if v_branch is not null then
    if not exists (
      select 1 from public.branches b where b.id = v_branch and b.tenant_id = v_tenant
    ) then
      raise exception 'Branch not found in current tenant';
    end if;
  else
    v_branch := coalesce(v_sale.branch_id, public.default_branch_id(v_tenant));
  end if;

  -- Pre-discount subtotal of the original sale, used to apportion the discount.
  select coalesce(sum(si.line_total), 0) into v_subtotal
    from public.sale_items si
   where si.sale_id = v_sale.id
     and si.tenant_id = v_tenant;

  insert into public.sales_returns (tenant_id, sale_id, branch_id, reason, status, created_by)
  values (v_tenant, v_sale.id, v_branch, nullif(return_data ->> 'reason', ''), 'pending', v_user)
  returning id into v_return_id;

  perform set_config('saleshub.skip_branch_sync', 'on', true);

  for v_item in select * from jsonb_array_elements(coalesce(return_data -> 'items', '[]'::jsonb)) loop
    v_qty := coalesce((v_item ->> 'quantity_returned')::numeric, 0);

    -- The UI posts every line of the sale; untouched lines are simply skipped.
    if v_qty <= 0 then
      continue;
    end if;

    select si.id,
           si.product_id,
           si.quantity_sold,
           si.unit_price,
           si.line_total,
           coalesce(si.stock_deduction_pieces, 0) as stock_deduction_pieces,
           coalesce(p.tax_rate, 0)                as tax_rate
      into v_si
      from public.sale_items si
      left join public.products p on p.id = si.product_id
     where si.id = nullif(v_item ->> 'sale_item_id', '')::uuid
       and si.sale_id = v_sale.id
       and si.tenant_id = v_tenant;

    if not found then
      raise exception 'Line item does not belong to this sale';
    end if;

    -- Everything already returned on this line across previous returns.
    select coalesce(sum(ri.quantity_returned), 0) into v_already
      from public.return_items ri
      join public.sales_returns sr on sr.id = ri.return_id
     where ri.sale_item_id = v_si.id
       and ri.tenant_id = v_tenant
       and sr.id <> v_return_id
       and sr.status <> 'rejected';

    if v_qty > (coalesce(v_si.quantity_sold, 0) - v_already) then
      raise exception 'Cannot return % of % – only % remain returnable',
        v_qty, coalesce(v_si.quantity_sold, 0), (coalesce(v_si.quantity_sold, 0) - v_already);
    end if;

    v_base := v_qty * coalesce(v_si.unit_price, 0);
    v_tax  := v_base * (v_si.tax_rate / 100);
    v_disc := case
                when v_subtotal > 0 then coalesce(v_sale.discount_total, 0) * (v_base / v_subtotal)
                else 0
              end;
    v_refund := round(greatest(0, v_base + v_tax - v_disc), 2);

    -- Give back stock in proportion to what the line originally removed.
    v_pieces := case
                  when coalesce(v_si.quantity_sold, 0) > 0
                    then round(v_si.stock_deduction_pieces * (v_qty / v_si.quantity_sold))
                  else 0
                end;

    insert into public.return_items (
      tenant_id, return_id, sale_item_id, quantity_returned, refund_amount, restocked_pieces
    ) values (
      v_tenant, v_return_id, v_si.id, v_qty, v_refund, coalesce(v_pieces, 0)
    );

    if coalesce(v_pieces, 0) > 0 then
      update public.products
         set stock_quantity = coalesce(stock_quantity, 0) + v_pieces,
             updated_at = now()
       where id = v_si.product_id
         and tenant_id = v_tenant;

      if v_branch is not null then
        insert into public.branch_stock as bs (tenant_id, branch_id, product_id, stock_quantity)
        values (v_tenant, v_branch, v_si.product_id, v_pieces)
        on conflict (branch_id, product_id) do update
          set stock_quantity = bs.stock_quantity + v_pieces,
              updated_at = now();
      end if;
    end if;

    v_total := v_total + v_refund;
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'A return must include at least one item with a quantity';
  end if;

  -- A credit sale is refunded by writing the debt down, capped at what the
  -- customer still owes so a refund can never create a negative balance.
  if v_sale.payment_method = 'credit' and v_sale.customer_id is not null then
    select coalesce(c.current_credit_balance, 0) into v_balance
      from public.customers c
     where c.id = v_sale.customer_id
       and c.tenant_id = v_tenant
     for update;

    if found then
      v_credit := least(v_balance, v_total);
      if v_credit > 0 then
        update public.customers
           set current_credit_balance = v_balance - v_credit,
               updated_at = now()
         where id = v_sale.customer_id;

        insert into public.credit_transactions (
          tenant_id, customer_id, sale_id, amount, balance_after, notes
        ) values (
          v_tenant, v_sale.customer_id, v_sale.id, -v_credit, v_balance - v_credit, 'Sales return refund'
        );
      end if;
    end if;
  end if;

  update public.sales_returns
     set status = 'completed',
         refund_total = v_total,
         credit_adjusted = v_credit
   where id = v_return_id;

  return v_return_id;
end;
$$;

grant execute on function public.create_sales_return(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. create_stock_transfer
-- ----------------------------------------------------------------------------
-- transfer_data shape:
--   {
--     "from_branch_id": "<uuid>",
--     "to_branch_id":   "<uuid>",
--     "notes":          "weekly top-up",
--     "items": [ { "product_id": "<uuid>", "quantity": 10 }, ... ]
--   }
--
-- Moves pieces between two branch_stock rows in one transaction and marks the
-- transfer completed. products.stock_quantity is deliberately untouched: a
-- transfer is net-zero for the tenant, only its distribution changes.
create or replace function public.create_stock_transfer(transfer_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant      uuid := public.get_my_tenant();
  v_user        uuid := public.auth_uid();
  v_from        uuid := nullif(transfer_data ->> 'from_branch_id', '')::uuid;
  v_to          uuid := nullif(transfer_data ->> 'to_branch_id', '')::uuid;
  v_transfer_id uuid;
  v_rec         record;
  v_available   integer;
  v_name        text;
begin
  if v_tenant is null then
    raise exception 'No active tenant';
  end if;
  if not public.is_tenant_owner() then
    raise exception 'Only the shop owner can transfer stock';
  end if;

  if v_from is null or v_to is null then
    raise exception 'Both a source and a destination branch are required';
  end if;
  if v_from = v_to then
    raise exception 'Source and destination branch must be different';
  end if;
  if not exists (select 1 from public.branches b where b.id = v_from and b.tenant_id = v_tenant) then
    raise exception 'Source branch not found in current tenant';
  end if;
  if not exists (select 1 from public.branches b where b.id = v_to and b.tenant_id = v_tenant) then
    raise exception 'Destination branch not found in current tenant';
  end if;

  if (select jsonb_array_length(coalesce(transfer_data -> 'items', '[]'::jsonb))) < 1 then
    raise exception 'A transfer must include at least one product';
  end if;

  -- Collapse the requested lines to one row per product so the same product
  -- listed twice cannot slip past the availability check.
  drop table if exists tmp_transfer_items;
  create temp table tmp_transfer_items (
    product_id uuid primary key,
    quantity integer not null
  ) on commit drop;

  insert into tmp_transfer_items (product_id, quantity)
  select (i ->> 'product_id')::uuid, sum(coalesce((i ->> 'quantity')::numeric, 0))::integer
    from jsonb_array_elements(coalesce(transfer_data -> 'items', '[]'::jsonb)) as i
   where nullif(i ->> 'product_id', '') is not null
   group by (i ->> 'product_id')::uuid;

  if (select count(*) from tmp_transfer_items) = 0 then
    raise exception 'A transfer must include at least one product';
  end if;
  if exists (select 1 from tmp_transfer_items where quantity <= 0) then
    raise exception 'Transfer quantities must be greater than zero';
  end if;

  -- Every product must belong to the tenant and the source must actually hold
  -- the pieces. Checked up front so a rejected transfer moves nothing.
  for v_rec in select product_id, quantity from tmp_transfer_items loop
    select p.name into v_name
      from public.products p
     where p.id = v_rec.product_id
       and p.tenant_id = v_tenant
       and coalesce(p.is_deleted, false) = false;
    if not found then
      raise exception 'Product not found in current tenant: %', v_rec.product_id;
    end if;

    select coalesce(bs.stock_quantity, 0) into v_available
      from public.branch_stock bs
     where bs.branch_id = v_from
       and bs.product_id = v_rec.product_id;

    if not found then
      v_available := 0;
    end if;

    if v_rec.quantity > v_available then
      raise exception 'Source branch only has % of % (requested %)', v_available, v_name, v_rec.quantity;
    end if;
  end loop;

  insert into public.stock_transfers (
    tenant_id, from_branch_id, to_branch_id, status, notes, created_by, completed_at
  ) values (
    v_tenant, v_from, v_to, 'completed', nullif(transfer_data ->> 'notes', ''), v_user, now()
  ) returning id into v_transfer_id;

  insert into public.stock_transfer_items (tenant_id, transfer_id, product_id, quantity)
  select v_tenant, v_transfer_id, product_id, quantity
    from tmp_transfer_items;

  for v_rec in select product_id, quantity from tmp_transfer_items loop
    update public.branch_stock bs
       set stock_quantity = bs.stock_quantity - v_rec.quantity,
           updated_at = now()
     where bs.branch_id = v_from
       and bs.product_id = v_rec.product_id;

    insert into public.branch_stock as bs (tenant_id, branch_id, product_id, stock_quantity)
    values (v_tenant, v_to, v_rec.product_id, v_rec.quantity)
    on conflict (branch_id, product_id) do update
      set stock_quantity = bs.stock_quantity + v_rec.quantity,
          updated_at = now();
  end loop;

  return v_transfer_id;
end;
$$;

grant execute on function public.create_stock_transfer(jsonb) to authenticated;
