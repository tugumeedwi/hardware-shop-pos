-- ============================================================================
-- Product batch tracking
-- ----------------------------------------------------------------------------
-- Each batch represents a quantity of a product at a given branch with a
-- batch number, lot number and expiry date.  Sales deduct using FIFO (oldest
-- batch first).  Returns restock into the original batch when known.
--
--   product_batches.branch_id + product_id + batch_number  => unique
--   products.stock_quantity  =  sum(branch_stock.stock_quantity)       (total)
--   branch_stock.stock_quantity                        =  sum of batch qty
-- ============================================================================

create table if not exists public.product_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  batch_number text not null,
  lot_number text,
  expiry_date date not null,
  quantity integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (branch_id, product_id, batch_number)
);

create index if not exists idx_product_batches_tenant
  on public.product_batches(tenant_id);
create index if not exists idx_product_batches_branch_product
  on public.product_batches(branch_id, product_id);
create index if not exists idx_product_batches_expiry
  on public.product_batches(expiry_date);

-- ----------------------------------------------------------------------------
-- 2. Keep products.stock_quantity in agreement with branch_stock + batches.
--    The trigger below maintains the invariant:
--      products.stock_quantity = sum(branch_stock.stock_quantity)
--    branch_stock.stock_quantity is itself maintained by the existing
--    products_sync_branch_stock trigger + RPCs.
-- ----------------------------------------------------------------------------
create or replace function public.products_sync_batch_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'DELETE' then
    update public.branch_stock bs
    set stock_quantity = (
      select coalesce(sum(qty), 0)
        from public.product_batches bp
       where bp.branch_id = bs.branch_id
         and bp.product_id = bs.product_id
    ),
      bs.updated_at = now()
    where bs.branch_id = NEW.branch_id
      and bs.product_id = NEW.product_id;
  end if;

  if TG_OP = 'UPDATE' then
    update public.branch_stock bs
    set stock_quantity = (
      select coalesce(sum(qty), 0)
        from public.product_batches bp
       where bp.branch_id = bs.branch_id
         and bp.product_id = bs.product_id
    ),
      bs.updated_at = now()
    where bs.branch_id = NEW.branch_id
      and bs.product_id = NEW.product_id;
  end if;

  if TG_OP = 'INSERT' then
    update public.branch_stock bs
    set stock_quantity = (
      select coalesce(sum(qty), 0)
        from public.product_batches bp
       where bp.branch_id = bs.branch_id
         and bp.product_id = bs.product_id
    ),
      bs.updated_at = now()
    where bs.branch_id = NEW.branch_id
      and bs.product_id = NEW.product_id;
  end if;

  return NEW;
end
$$;

drop trigger if exists trg_products_sync_batch_stock on public.products;
create trigger trg_products_sync_batch_stock
  after insert or update or delete on public.product_batches
  for each row execute function public.products_sync_batch_stock();

-- ----------------------------------------------------------------------------
-- 3. Helper: return all batches for a product+branch, ordered FIFO (oldest
--    expiry first, then created_at).  The caller handles the running total
--    and FIFO deduction logic.
-- ----------------------------------------------------------------------------
create or replace function public.get_batches_by_product_branch(
  p_product_id uuid,
  p_branch_id uuid
)
returns table (
  batch_id uuid,
  batch_number text,
  lot_number text,
  expiry_date date,
  quantity integer
)
language sql
stable
security definer
set search_path = public
as $$
select pb.id::uuid
     , pb.batch_number
     , pb.lot_number
     , pb.expiry_date
     , pb.quantity
  from public.product_batches pb
  where pb.product_id = p_product_id
    and pb.branch_id = p_branch_id
  order by pb.expiry_date asc, pb.created_at asc;
$$;

grant execute on function public.get_batches_by_product_branch(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 4. Convenience: total quantity across all batches for a product+branch.
-- ----------------------------------------------------------------------------
create or replace function public.total_batch_qty(
  p_branch_id uuid,
  p_product_id uuid
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(pb.quantity), 0)
    from public.product_batches pb
   where pb.branch_id = p_branch_id
     and pb.product_id = p_product_id;
$$;

grant execute on function public.total_batch_qty(uuid, uuid) to authenticated;