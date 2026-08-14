-- Fix convert_quotation and create_sale RPCs so quotations convert correctly.
--
-- convert_quotation previously: set status='completed' (Quotations UI filters on
-- 'converted' so converted quotes vanished), never deducted stock despite the
-- UI promising "Stock will be deducted", and left payment fields untouched.
-- Now it: validates the quote is a pending quotation in the caller's tenant,
-- marks it 'converted', sets payment_method/amount_paid so the receipt shows a
-- completed cash sale, and deducts stock per line using the same unit->pieces
-- conversion used by create_sale.
--
-- create_sale previously: deducted stock for quotations (which should only be
-- deducted at conversion time) and dropped expiry_date/idempotency_key during
-- offline sync of quotations. Now stock deduction is skipped for quotations
-- and expiry_date is preserved.

-- updated_at columns may be missing on legacy tables; make them exist so the
-- RPCs below can stamp them.
alter table public.products add column if not exists updated_at timestamptz not null default now();
alter table public.sales add column if not exists updated_at timestamptz not null default now();
alter table public.customers add column if not exists updated_at timestamptz not null default now();

create or replace function public.convert_quotation(quotation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.get_my_tenant();
  v_rec record;
  v_product public.products%rowtype;
  v_deduction numeric;
begin
  if v_tenant is null then
    raise exception '15999 No active tenant';
  end if;

  -- Lock and convert the quotation (only pending quotations are convertible)
  update public.sales
     set status = 'converted',
         payment_method = coalesce(payment_method, 'cash'),
         amount_paid = total_amount,
         updated_at = now()
   where id = quotation_id
     and type = 'quotation'
     and status = 'pending'
     and tenant_id = v_tenant;
  if not found then
    raise exception 'Pending quotation not found in current tenant';
  end if;

  -- Deduct stock for every line against the live catalog, in pieces
  for v_rec in
    select si.product_id, si.selling_unit, si.quantity_sold
      from public.sale_items si
     where si.sale_id = quotation_id
       and si.tenant_id = v_tenant
  loop
    select * into v_product
      from public.products p
     where p.id = v_rec.product_id
       and p.tenant_id = v_tenant;

    if not found then
      continue;
    end if;

    v_deduction := case v_rec.selling_unit
      when 'piece' then v_rec.quantity_sold
      when 'box'   then v_rec.quantity_sold * coalesce(v_product.pieces_per_box, 0)
      when 'sqm'   then case when coalesce(v_product.m2_per_piece, 0) > 0
                             then ceil(v_rec.quantity_sold / v_product.m2_per_piece) else 0 end
      when 'kg'    then case when coalesce(v_product.pieces_per_kg, 0) > 0
                             then ceil(v_rec.quantity_sold * v_product.pieces_per_kg) else 0 end
      else 0 end;

    if v_deduction > coalesce(v_product.stock_quantity, 0) then
      insert into public.sync_conflict_log (tenant_id, table_name, record_id, local_data, server_data)
      values (v_tenant, 'products', v_product.id,
              jsonb_build_object('quotation_id', quotation_id, 'deduction', v_deduction),
              jsonb_build_object('stock_quantity', v_product.stock_quantity));
      raise exception 'Insufficient stock for product %', v_product.id;
    end if;

    update public.products prod
       set stock_quantity = greatest(0, stock_quantity - v_deduction),
           updated_at = now()
     where prod.id = v_rec.product_id
       and prod.tenant_id = v_tenant;
  end loop;
end;
$$;

create or replace function public.create_sale(sale_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant    uuid := public.get_my_tenant();
  v_sale_id   uuid;
  v_item      jsonb;
  v_rec       record;
  v_product   public.products%rowtype;
  v_customer  public.customers%rowtype;
  v_unit      text;
  v_qty       numeric;
  v_unit_p    numeric;
  v_deduction numeric;
  v_line      numeric;
  v_total     numeric := 0;
  v_discount  numeric;
  v_final     numeric;
  v_client    numeric;
  v_balance   numeric;
  v_sale_type text := coalesce(sale_data ->> 'type', 'pos');
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

    v_unit_p := case v_unit
      when 'piece' then coalesce(v_product.price_per_piece, 0)
      when 'box'   then coalesce(v_product.price_per_box, 0)
      when 'sqm'   then coalesce(v_product.price_per_sqm, 0)
      when 'kg'    then coalesce(v_product.price_per_kg, 0)
      else 0 end;

    -- Quotations only reserve stock at conversion time, so a synced offline
    -- quotation must not deduct stock here.
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

    insert into tmp_sale_items (product_id, selling_unit, quantity_sold, unit_price, stock_deduction_pieces, line_total)
    values (v_product.id, v_unit, v_qty, v_unit_p, v_deduction, v_line);
  end loop;

  -- Tamper check: recalculation must match what the client reported
  v_discount := coalesce((sale_data ->> 'discount_total')::numeric, 0);
  v_final    := v_total - v_discount;
  v_client   := coalesce((sale_data ->> 'total_amount')::numeric, 0);
  if abs(v_final - v_client) > 0.01 then
    insert into public.sync_conflict_log (tenant_id, table_name, record_id, local_data, server_data)
    values (v_tenant, 'sales', null,
            jsonb_build_object('client_total', v_client, 'client_discount', v_discount, 'items', sale_data -> 'items'),
            jsonb_build_object('recalculated_total', v_final));
    raise exception 'Sale total mismatch – possible tampering';
  end if;

  -- Insert the sale
  insert into public.sales (
    tenant_id, customer_id, cashier_id, type, status, payment_method,
    discount_total, total_amount, amount_paid, notes, offline_created_at,
    sync_status, idempotency_key, expiry_date
  ) values (
    v_tenant,
    (sale_data ->> 'customer_id')::uuid,
    (sale_data ->> 'cashier_id')::uuid,
    v_sale_type,
    coalesce(sale_data ->> 'status', 'completed'),
    coalesce(sale_data ->> 'payment_method', 'cash'),
    v_discount,
    v_final,
    coalesce((sale_data ->> 'amount_paid')::numeric, 0),
    nullif(sale_data ->> 'notes', ''),
    sale_data ->> 'offline_created_at',
    'synced',
    sale_data ->> 'idempotency_key',
    case when sale_data ? 'expiry_date' and (sale_data ->> 'expiry_date') is not null
         then (sale_data ->> 'expiry_date')::date else null end
  ) returning id into v_sale_id;

  insert into public.sale_items (sale_id, tenant_id, product_id, selling_unit, quantity_sold, unit_price, stock_deduction_pieces, line_total)
  select v_sale_id, v_tenant, product_id, selling_unit, quantity_sold, unit_price, stock_deduction_pieces, line_total
    from tmp_sale_items;

  -- Deduct stock (POS sales only)
  if v_sale_type <> 'quotation' then
    for v_rec in select product_id, stock_deduction_pieces from tmp_sale_items loop
      update public.products prod
         set stock_quantity = greatest(0, stock_quantity - v_rec.stock_deduction_pieces),
             updated_at = now()
       where prod.id = v_rec.product_id
         and prod.tenant_id = v_tenant;
    end loop;
  end if;

  -- Credit handling (limit enforced server-side)
  if sale_data ->> 'payment_method' = 'credit' and (sale_data ->> 'customer_id')::uuid is not null then
    select * into v_customer
      from public.customers c
     where c.id = (sale_data ->> 'customer_id')::uuid
       and c.tenant_id = v_tenant;
    if found then
      v_balance := coalesce(v_customer.current_credit_balance, 0) + v_final;
      if v_balance > coalesce(v_customer.credit_limit, 0) then
        raise exception 'Credit limit exceeded after recalculation';
      end if;
      update public.customers
         set current_credit_balance = v_balance,
             updated_at = now()
       where id = v_customer.id;
      insert into public.credit_transactions (tenant_id, customer_id, sale_id, amount, balance_after, notes)
      values (v_tenant, v_customer.id, v_sale_id, v_final, v_balance, 'POS credit sale');
    end if;
  end if;

  return v_sale_id;
end;
$$;

grant execute on function public.convert_quotation(uuid) to authenticated;
grant execute on function public.create_sale(jsonb) to authenticated;