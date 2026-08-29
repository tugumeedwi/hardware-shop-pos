-- ============================================================================
-- Phase 1 follow-up: make tenant deletion survive the new branch constraints
-- ----------------------------------------------------------------------------
-- Two problems were found by deleting a probe tenant after the first two
-- migrations:
--
-- 1. branches_guard_delete() raised "Cannot delete the only branch of a shop"
--    while the tenants -> branches ON DELETE CASCADE was running, so a tenant
--    could no longer be deleted at all. That breaks the QA harness teardown and
--    the signup-tenant Edge Function's rollback path (it deletes the tenant it
--    just created when user creation fails). The guard now stands down when the
--    owning tenant is itself being deleted: during a cascade PostgreSQL removes
--    the parent row first, so the tenant is already invisible in this
--    transaction by the time the child trigger runs.
--
-- 2. The new branch_id columns were created with the default NO ACTION, and
--    sibling tables cascading from the same tenant are deleted in an
--    unspecified order. If branches happened to go before sales, the delete
--    failed on sales_branch_id_fkey. Every new reference now names an explicit
--    action so teardown is order-independent:
--      * branch_id on business tables      -> ON DELETE SET NULL
--        (history outlives a branch; the delete guard already stops an owner
--        from removing a branch that still has sales or stock)
--      * a child row's link to its parent  -> ON DELETE CASCADE
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Let the cascade through
-- ----------------------------------------------------------------------------
create or replace function public.branches_guard_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_remaining integer;
  v_stock     integer;
  v_sales     integer;
begin
  -- The whole shop is being deleted: nothing to protect, let the cascade run.
  if not exists (select 1 from public.tenants t where t.id = OLD.tenant_id) then
    return OLD;
  end if;

  select count(*) into v_remaining
    from public.branches b
   where b.tenant_id = OLD.tenant_id
     and b.id <> OLD.id;

  if v_remaining = 0 then
    raise exception 'Cannot delete the only branch of a shop';
  end if;

  select coalesce(sum(bs.stock_quantity), 0) into v_stock
    from public.branch_stock bs
   where bs.branch_id = OLD.id;

  if v_stock > 0 then
    raise exception 'Branch still holds % pieces of stock – transfer it out first', v_stock;
  end if;

  select count(*) into v_sales
    from public.sales s
   where s.branch_id = OLD.id;

  if v_sales > 0 then
    raise exception 'Branch has % recorded sales and cannot be deleted', v_sales;
  end if;

  return OLD;
end;
$$;

-- ----------------------------------------------------------------------------
-- 2. Explicit referential actions
-- ----------------------------------------------------------------------------
-- branch_id on business tables: keep the row, drop the link.
alter table public.sales      drop constraint if exists sales_branch_id_fkey;
alter table public.sales      add  constraint sales_branch_id_fkey
  foreign key (branch_id) references public.branches(id) on delete set null;

alter table public.sale_items drop constraint if exists sale_items_branch_id_fkey;
alter table public.sale_items add  constraint sale_items_branch_id_fkey
  foreign key (branch_id) references public.branches(id) on delete set null;

alter table public.customers  drop constraint if exists customers_branch_id_fkey;
alter table public.customers  add  constraint customers_branch_id_fkey
  foreign key (branch_id) references public.branches(id) on delete set null;

alter table public.expenses   drop constraint if exists expenses_branch_id_fkey;
alter table public.expenses   add  constraint expenses_branch_id_fkey
  foreign key (branch_id) references public.branches(id) on delete set null;

alter table public.sales_returns drop constraint if exists sales_returns_branch_id_fkey;
alter table public.sales_returns add  constraint sales_returns_branch_id_fkey
  foreign key (branch_id) references public.branches(id) on delete set null;

-- Child rows follow their parent out.
alter table public.sales_returns drop constraint if exists sales_returns_sale_id_fkey;
alter table public.sales_returns add  constraint sales_returns_sale_id_fkey
  foreign key (sale_id) references public.sales(id) on delete cascade;

alter table public.return_items drop constraint if exists return_items_sale_item_id_fkey;
alter table public.return_items add  constraint return_items_sale_item_id_fkey
  foreign key (sale_item_id) references public.sale_items(id) on delete cascade;

-- A transfer only means anything in the context of its two branches.
alter table public.stock_transfers drop constraint if exists stock_transfers_from_branch_id_fkey;
alter table public.stock_transfers add  constraint stock_transfers_from_branch_id_fkey
  foreign key (from_branch_id) references public.branches(id) on delete cascade;

alter table public.stock_transfers drop constraint if exists stock_transfers_to_branch_id_fkey;
alter table public.stock_transfers add  constraint stock_transfers_to_branch_id_fkey
  foreign key (to_branch_id) references public.branches(id) on delete cascade;

alter table public.stock_transfer_items drop constraint if exists stock_transfer_items_product_id_fkey;
alter table public.stock_transfer_items add  constraint stock_transfer_items_product_id_fkey
  foreign key (product_id) references public.products(id) on delete cascade;
