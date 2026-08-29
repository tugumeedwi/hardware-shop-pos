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
-- 1. create_sale, now branch aware (with FIFO batch deduction)
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
  v_batch_qty integer;  -- amount deducted from batches
begin
  if v_tenant is null then
    raise exception '15999 No active tenant';
  end if;

  -- ----- Branch resolution (identical to phase 1) -----
  v_branch := nullif(sale_data ->> 'branch_id', '')::uuid;
  if v_branch is null then
    v_branch := public.ensure_default_branch(v_tenant);
  elsif not exists (select 1 from public.branches b where b.id = v_branch and b.tenant_id = v_tenant) then
    raise exception 'Branch not found in current tenant';
  end if;

  -- ----- Parse sale lines (identical to phase 1) -----
  v_item := sale_data -> 'items';
  if v_item is null then
    raise exception 'No items in sale';
  end if;

  -- Collect all product ids and their required quantities from the sale items
  declare
    v_product_ids uuid[];
    v_line_items jsonb[];
    v_i integer := 0;
    v_pid uuid;
    v_qty_sold numeric;
    v_unit text;
    v_price numeric;
    v_disc numeric;
  begin
    v_line_items := coalesce(v_item, '[]'::jsonb);
    foreach v_line_items slice in array
    loop
      v_pid := (v_line_items ->> 'product_id')::uuid;
      v_qty_sold := (v_line_items ->> 'quantity')::numeric;
      v_unit := v_line_items ->> 'selling_unit';
      v_price := (v_line_items ->> 'unit_price')::numeric;
      v_disc := (v_line_items ->> 'discount')::numeric;

      -- Resolve unit to pieces
      case v_unit
        when 'pcs'  then v_qty_sold := v_qty_sold * coalesce((v_line_items ->> 'pieces_per_unit')::numeric, 1);
        when 'kg'   then v_qty_sold := ceil(v_qty_sold * coalesce((v_line_items ->> 'pieces_per_kg')::numeric, 0));
        when 'sqm'  then
          if coalesce((v_line_items ->> 'm2_per_piece')::numeric, 0) > 0 then
            v_qty_sold := ceil(v_qty_sold / (v_line_items ->> 'm2_per_piece')::numeric);
          end if;
      end case;

      -- Store product id and required pieces for later batch deduction
      v_product_ids := v_product_ids || v_pid;
      -- We'll re-process below after the main loop
      exit when true;
    end loop;
  end;

  -- ----- Main item processing (identical to phase 1, with batch-aware deduction) -----
  -- We process each line, deduct from product total and branch_stock, and also
  -- deduct from the appropriate batches (FIFO) if batch tracking is active.

  -- Build an array of (product_id, total_pieces_to_deduct) from all lines
  v_product_ids := '{}'::uuid[];
  v_tmp_items jsonb[] := '{}'::jsonb[];
  v_i := 0;

  foreach v_line_items slice in array
  loop
    v_pid := (v_line_items ->> 'product_id')::uuid;
    v_qty_sold := (v_line_items ->> 'quantity')::numeric;
    v_unit := v_line_items ->> 'selling_unit';
    v_price := (v_line_items ->> 'unit_price')::numeric;
    v_disc := (v_line_items ->> 'discount')::numeric;

    -- Resolve unit to pieces
    case v_unit
      when 'pcs'  then v_qty_sold := v_qty_sold * coalesce((v_line_items ->> 'pieces_per_unit')::numeric, 1);
      when 'kg'   then v_qty_sold := ceil(v_qty_sold * coalesce((v_line_items ->> 'pieces_per_kg')::numeric, 0));
      when 'sqm'  then
        if coalesce((v_line_items ->> 'm2_per_piece')::numeric, 0) > 0 then
          v_qty_sold := ceil(v_qty_sold / (v_line_items ->> 'm2_per_piece')::numeric);
        end if;
      else  v_qty_sold := v_qty_sold;
    end case;

    v_tmp_items := v_tmp_items || jsonb_build_object(
      'product_id', v_pid,
      'quantity_sold', v_qty_sold,
      'selling_unit', v_unit,
      'unit_price', v_price,
      'discount', greatest(0, v_disc)
    );
    v_i := v_i + 1;
    exit when true;
  end loop;

  -- ----- Per-product stock check and batch-aware deduction -----
  -- For each product in the sale, check stock and deduct using FIFO batches if applicable.
  -- We iterate over distinct product ids from the sale.
  declare
    v_distinct_pids uuid[];
    v_d integer := 0;
    v_p rec;
    v_pieces_deduced numeric;
    v_batch_records record;
    v_batch_id uuid;
    v_batch_num text;
    v_lot text;
    v_exp date;
    v_batch_avail numeric;
    v_from_batches numeric := 0;
    v_from_branch_stock numeric := 0;
  begin
    -- Collect distinct product ids
    foreach v_tmp_items slice in array
    loop
      v_pid := (slice ->> 'product_id')::uuid;
      exit when v_i <= d;
      v_distinct_pids := v_distinct_pids || v_pid;
      d := d + 1;
    end loop;

    -- For each distinct product, do stock check + batch deduction
    foreach v_distinct_pids slice as v_pid
    loop
      -- Determine total pieces needed for this product across all sale lines
      v_pieces_deduced := 0;
      foreach v_tmp_items slice2 in array
      loop
        if (slice2 ->> 'product_id')::uuid = v_pid then
          v_pieces_deduced := (slice2 ->> 'quantity_sold')::numeric + v_pieces_deduced;
        end if;
        exit when v_tmp_items is null;
      end loop;

      -- Fetch product + branch_stock info
      v_product := null;
      select * into v_product from public.products where id = v_pid and tenant_id = v_tenant;
      if v_product is null then
        raise exception 'Product not found in current tenant: %', v_pid;
      end if;

      -- Check total stock (tenant-level) - existing guard
      if v_pieces_deduced > greatest(0, coalesce(v_product.stock_quantity, 0)) then
        insert into public.sync_conflict_log (tenant_id, table_name, record_id, local_data, server_data)
        values (v_tenant, 'products', v_pid,
                jsonb_build_object('sale_id', sale_data ->> 'offline_created_at',
                                   'deduction', v_pieces_deduced,
                                   'product_id', v_pid),
                jsonb_build_object('stock_quantity', greatest(0, coalesce(v_product.stock_quantity, 0))));
        raise exception 'Insufficient stock for product %', v_pid;
      end if;

      -- Fetch branch_stock for the selling branch
      select coalesce(stock_quantity, 0) into v_from_branch_stock
        from public.branch_stock
       where branch_id = v_branch
         and product_id = v_pid;

      -- ---- FIFO Batch Deduction ----
      -- If the product has batches at this branch, deduct from oldest batches first.
      -- Otherwise, fall back to the existing branch_stock deduction.
      v_batch_qty := 0;

      -- Check if any batches exist for this product+branch
      declare
        v_batch_count integer := 0;
      begin
        select count(*) into v_batch_count from public.product_batches where product_id = v_pid and branch_id = v_branch;
        if v_batch_count > 0 then
          -- Use FIFO: iterate batches ordered by expiry_date, created_at
          foreach (select * from public.get_batches_by_product_branch(v_pid, v_branch)) as b
          loop
            -- How much of this batch are we taking? (can't exceed available, can't exceed remaining need)
            v_batch_avail := least(b.quantity, v_pieces_deduced - v_from_batches);
            if v_batch_avail > 0 then
              -- Deduct from this batch
              update public.product_batches
                 set quantity = greatest(0, quantity - v_batch_avail),
                     updated_at = now()
               where id = b.batch_id;

              v_from_batches := v_from_batches + v_batch_avail;
              v_batch_qty := v_batch_qty + v_batch_avail;

              -- If we've deducted the total needed, stop
              if v_from_batches >= v_pieces_deduced then
                exit;
              end if;
            end if;
          end loop;
        end if;
      end;

      -- Deduct remaining from branch_stock (if any left after batches)
      v_from_branch_stock := greatest(0, v_from_branch_stock - (v_pieces_deduced - v_from_batches));

      -- Deduct from products.stock_quantity (tenant total)
      update public.products prod
         set stock_quantity = greatest(0, stock_quantity - v_pieces_deduced),
             updated_at = now()
       where prod.id = v_pid
         and prod.tenant_id = v_tenant;

      -- Deduct from branch_stock
      if v_from_batches < v_pieces_deduced then
        -- Some deduction came from branch_stock directly
        update public.branch_stock bs
           set stock_quantity = greatest(0, bs.stock_quantity - (v_pieces_deduced - v_from_batches)),
               updated_at = now()
         where bs.branch_id = v_branch
           and bs.product_id = v_pid;
      elsif v_from_batches > 0 then
        -- All deduction came from batches; branch_stock is derived from batches
        -- via the trigger, but we also explicitly update it to stay in sync:
        update public.branch_stock bs
           set stock_quantity = greatest(0, bs.stock_quantity - v_from_batches),
               updated_at = now()
         where bs.branch_id = v_branch
           and bs.product_id = v_pid;
      end if;

      -- Insert sale item records
      -- (this part is handled after the loop below)
    end loop; -- foreach distinct product
  end; -- begin block for batch deduction

  -- ----- Insert sale and items (identical to phase 1) -----
  -- (the tmp_sale_items handling and final insertion stays the same)
  -- ... (rest of the function remains identical to phase 1)
```

Wait, I'm going in circles with this. Let me take a completely different approach - I'll modify the final stock deduction section (the loop at the end of the function) to add batch-aware deduction, while keeping the rest of the function intact.

Let me read the exact section I need to modify and create a precise edit:Let me take a more focused approach. I'll modify just the stock deduction section at the end of `create_sale`:
<tool_call>
<function=bash>
<parameter=workdir>
/home/Eddie/hardware-shop-pos