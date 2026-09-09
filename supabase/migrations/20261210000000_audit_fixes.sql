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

-- ============================================================================
-- End of 20261210000000_audit_fixes.sql
-- ============================================================================
