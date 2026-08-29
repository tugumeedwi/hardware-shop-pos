-- ============================================================================
-- Phase 1 expansion: suppliers, sales returns, multi-branch
-- ----------------------------------------------------------------------------
-- Design notes (read before changing anything here):
--
-- STOCK MODEL. Until now stock lived in a single products.stock_quantity
-- column (in pieces) and every read path in the app - the Products grid, the
-- POS product cards, the dashboard low-stock badge, the Dexie offline mirror -
-- reads exactly that column. Rather than break all of them, this migration
-- keeps products.stock_quantity as the TENANT-WIDE TOTAL and adds
-- branch_stock(branch_id, product_id, stock_quantity) as the per-branch ledger.
--
--   invariant: products.stock_quantity = sum(branch_stock.stock_quantity)
--                                        for that product
--
-- The invariant is maintained by:
--   * the backfill below (all existing stock lands on the head office),
--   * create_sale, which deducts the selling branch AND the tenant total,
--   * create_sales_return, which restocks both,
--   * create_stock_transfer, which is net-zero on the total and so leaves
--     products.stock_quantity alone,
--   * trg_products_sync_branch_stock, which routes a manual stock edit (the
--     Products page restock field) to the head-office branch row so an owner
--     editing stock the old way cannot make the two disagree.
--
-- Single-shop tenants therefore keep behaving exactly as before: they have one
-- head-office branch, its branch_stock row always equals the product total.
--
-- DEFAULT BRANCH. A tenant with zero branches would break the model, so
-- trg_tenants_default_branch creates a head office for every new tenant no
-- matter which path created it (signup-tenant Edge Function, QA harness, plain
-- SQL). create_sale additionally tolerates branch_id being null and falls back
-- to the default branch, so an unmigrated client keeps working.
--
-- CHILD TABLE tenant_id. return_items and stock_transfer_items carry a
-- tenant_id column even though they are reachable through their parent. This is
-- deliberate and required: the project's RLS contract is
-- "tenant_id = get_my_tenant()" on every table, and a policy that instead
-- joined to the parent would be both slower and inconsistent with the rest of
-- the schema.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. BRANCHES
-- ----------------------------------------------------------------------------
create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  location text,
  is_head_office boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_branches_tenant on public.branches(tenant_id);
-- At most one head office per tenant.
create unique index if not exists idx_branches_one_head_office
  on public.branches(tenant_id) where is_head_office;

-- ----------------------------------------------------------------------------
-- 2. SUPPLIERS
-- ----------------------------------------------------------------------------
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  phone text,
  email text,
  address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_suppliers_tenant on public.suppliers(tenant_id);
-- Supplier names are the human key the owner picks from; keep them unique per
-- tenant so the dropdown cannot fill with duplicates.
create unique index if not exists idx_suppliers_tenant_name
  on public.suppliers(tenant_id, lower(name));

-- products.supplier (free text) predates this table and is still written for
-- backwards compatibility (offline mirror, CSV export). supplier_id is the new
-- authoritative link.
alter table public.products
  add column if not exists supplier_id uuid references public.suppliers(id) on delete set null;

create index if not exists idx_products_supplier on public.products(supplier_id)
  where supplier_id is not null;

-- ----------------------------------------------------------------------------
-- 3. branch_id on existing business tables
-- ----------------------------------------------------------------------------
alter table public.sales      add column if not exists branch_id uuid references public.branches(id);
alter table public.sale_items add column if not exists branch_id uuid references public.branches(id);
alter table public.customers  add column if not exists branch_id uuid references public.branches(id);
alter table public.expenses   add column if not exists branch_id uuid references public.branches(id);

create index if not exists idx_sales_branch      on public.sales(branch_id)      where branch_id is not null;
create index if not exists idx_sale_items_branch on public.sale_items(branch_id) where branch_id is not null;
create index if not exists idx_customers_branch  on public.customers(branch_id)  where branch_id is not null;
create index if not exists idx_expenses_branch   on public.expenses(branch_id)   where branch_id is not null;

-- ----------------------------------------------------------------------------
-- 4. PER-BRANCH STOCK LEDGER
-- ----------------------------------------------------------------------------
create table if not exists public.branch_stock (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  stock_quantity integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (branch_id, product_id)
);

create index if not exists idx_branch_stock_tenant  on public.branch_stock(tenant_id);
create index if not exists idx_branch_stock_product on public.branch_stock(product_id);

-- ----------------------------------------------------------------------------
-- 5. SALES RETURNS
-- ----------------------------------------------------------------------------
create table if not exists public.sales_returns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sale_id uuid references public.sales(id),
  branch_id uuid references public.branches(id),
  reason text,
  status text not null default 'pending',
  refund_total numeric not null default 0,
  credit_adjusted numeric not null default 0,
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table public.sales_returns drop constraint if exists sales_returns_status_check;
alter table public.sales_returns
  add constraint sales_returns_status_check
  check (status in ('pending', 'completed', 'rejected'));

create index if not exists idx_sales_returns_tenant on public.sales_returns(tenant_id);
create index if not exists idx_sales_returns_sale   on public.sales_returns(sale_id);

create table if not exists public.return_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  return_id uuid not null references public.sales_returns(id) on delete cascade,
  sale_item_id uuid references public.sale_items(id),
  quantity_returned numeric not null,
  refund_amount numeric not null default 0,
  restocked_pieces integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_return_items_tenant on public.return_items(tenant_id);
create index if not exists idx_return_items_return on public.return_items(return_id);
create index if not exists idx_return_items_sale_item on public.return_items(sale_item_id);

-- ----------------------------------------------------------------------------
-- 6. STOCK TRANSFERS
-- ----------------------------------------------------------------------------
create table if not exists public.stock_transfers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  from_branch_id uuid not null references public.branches(id),
  to_branch_id uuid not null references public.branches(id),
  status text not null default 'pending',
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint stock_transfers_distinct_branches check (from_branch_id <> to_branch_id)
);

alter table public.stock_transfers drop constraint if exists stock_transfers_status_check;
alter table public.stock_transfers
  add constraint stock_transfers_status_check
  check (status in ('pending', 'completed', 'cancelled'));

create index if not exists idx_stock_transfers_tenant on public.stock_transfers(tenant_id);

create table if not exists public.stock_transfer_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transfer_id uuid not null references public.stock_transfers(id) on delete cascade,
  product_id uuid not null references public.products(id),
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_stock_transfer_items_tenant on public.stock_transfer_items(tenant_id);
create index if not exists idx_stock_transfer_items_transfer on public.stock_transfer_items(transfer_id);

-- ----------------------------------------------------------------------------
-- 7. tenant_id auto-stamp trigger on the new tables
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'branches', 'suppliers', 'branch_stock', 'sales_returns',
    'return_items', 'stock_transfers', 'stock_transfer_items'
  ] loop
    execute format('drop trigger if exists trg_set_tenant_id on public.%I', t);
    execute format(
      'create trigger trg_set_tenant_id before insert on public.%I
       for each row execute function public.set_tenant_id()', t
    );
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 8. Branch helpers
-- ----------------------------------------------------------------------------

-- The tenant's default branch: the head office if one is flagged, otherwise the
-- oldest branch. Used whenever a caller does not name a branch.
create or replace function public.default_branch_id(p_tenant uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select b.id
    from public.branches b
   where b.tenant_id = p_tenant
   order by b.is_head_office desc, b.created_at asc
   limit 1
$$;

grant execute on function public.default_branch_id(uuid) to authenticated;

-- Convenience wrapper for the calling tenant, used by the frontend.
create or replace function public.my_default_branch_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select public.default_branch_id(public.get_my_tenant())
$$;

grant execute on function public.my_default_branch_id() to authenticated;

-- Creates the head office for a tenant that has none, and returns the default
-- branch either way. Safe to call repeatedly.
create or replace function public.ensure_default_branch(p_tenant uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch uuid;
begin
  if p_tenant is null then
    return null;
  end if;

  v_branch := public.default_branch_id(p_tenant);
  if v_branch is not null then
    return v_branch;
  end if;

  insert into public.branches (tenant_id, name, location, is_head_office)
  values (p_tenant, 'Main Branch', null, true)
  returning id into v_branch;

  return v_branch;
end;
$$;

grant execute on function public.ensure_default_branch(uuid) to authenticated;

-- Every new tenant gets a head office automatically, whichever path created it
-- (signup-tenant Edge Function, QA seeding, manual SQL). This is what makes
-- "each tenant must have at least one branch" true by construction instead of
-- by client-side convention.
create or replace function public.tenants_create_default_branch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.branches (tenant_id, name, location, is_head_office)
  values (NEW.id, 'Main Branch', null, true)
  on conflict do nothing;
  return NEW;
end;
$$;

drop trigger if exists trg_tenants_default_branch on public.tenants;
create trigger trg_tenants_default_branch
  after insert on public.tenants
  for each row execute function public.tenants_create_default_branch();

-- Exactly one head office per tenant: flagging a new one demotes the old one
-- (the unique index would otherwise reject the update).
create or replace function public.branches_single_head_office()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.is_head_office then
    update public.branches
       set is_head_office = false,
           updated_at = now()
     where tenant_id = NEW.tenant_id
       and id <> NEW.id
       and is_head_office;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_branches_single_head_office on public.branches;
create trigger trg_branches_single_head_office
  before insert or update of is_head_office on public.branches
  for each row execute function public.branches_single_head_office();

-- A tenant must always keep at least one branch, and a branch that still holds
-- stock or has sales history cannot be deleted (that would silently destroy the
-- stock ledger and orphan sales).
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

drop trigger if exists trg_branches_guard_delete on public.branches;
create trigger trg_branches_guard_delete
  before delete on public.branches
  for each row execute function public.branches_guard_delete();

-- ----------------------------------------------------------------------------
-- 9. Keep products.stock_quantity and branch_stock in agreement
-- ----------------------------------------------------------------------------
-- A new product's opening stock becomes the head office's stock. An owner
-- editing stock_quantity by hand (the Products page restock field) has the
-- delta applied to the head office too, so the tenant total always equals the
-- sum of its branches without the Products page needing to know about branches.
-- The branch-aware RPCs below adjust both products.stock_quantity and
-- branch_stock themselves, so they set saleshub.skip_branch_sync = 'on' for the
-- transaction to suppress this trigger and avoid double counting.
create or replace function public.products_sync_branch_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch uuid;
  v_delta  integer;
begin
  if coalesce(current_setting('saleshub.skip_branch_sync', true), '') = 'on' then
    return NEW;
  end if;

  v_branch := public.default_branch_id(NEW.tenant_id);
  if v_branch is null then
    return NEW;
  end if;

  if TG_OP = 'INSERT' then
    v_delta := coalesce(NEW.stock_quantity, 0);
  else
    v_delta := coalesce(NEW.stock_quantity, 0) - coalesce(OLD.stock_quantity, 0);
  end if;

  if v_delta = 0 and TG_OP = 'UPDATE' then
    return NEW;
  end if;

  insert into public.branch_stock as bs (tenant_id, branch_id, product_id, stock_quantity)
  values (NEW.tenant_id, v_branch, NEW.id, greatest(0, v_delta))
  on conflict (branch_id, product_id) do update
    set stock_quantity = greatest(0, bs.stock_quantity + v_delta),
        updated_at = now();

  return NEW;
end;
$$;

drop trigger if exists trg_products_sync_branch_stock on public.products;
create trigger trg_products_sync_branch_stock
  after insert or update of stock_quantity on public.products
  for each row execute function public.products_sync_branch_stock();

-- ----------------------------------------------------------------------------
-- 10. RLS
-- ----------------------------------------------------------------------------
-- Read: every authenticated member of the tenant.
-- Write: owner only (is_tenant_owner()), per the Phase 1 brief. branch_stock is
-- the exception - it is never written directly by a client, only by the RPCs
-- below (security definer), so it gets read-only member access.
do $$
declare t text;
begin
  foreach t in array array[
    'branches', 'suppliers', 'branch_stock', 'sales_returns',
    'return_items', 'stock_transfers', 'stock_transfer_items'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists tenant_isolation_all on public.%I', t);
    execute format('drop policy if exists tenant_isolation_select on public.%I', t);
    execute format('drop policy if exists tenant_isolation_insert on public.%I', t);
    execute format('drop policy if exists tenant_isolation_update on public.%I', t);
    execute format('drop policy if exists tenant_isolation_delete on public.%I', t);

    execute format(
      'create policy tenant_isolation_select on public.%I
       for select to authenticated
       using (tenant_id = public.get_my_tenant())', t
    );
  end loop;
end $$;

-- Owner-gated writes on the tables an owner maintains from the UI.
do $$
declare t text;
begin
  foreach t in array array[
    'branches', 'suppliers', 'sales_returns',
    'return_items', 'stock_transfers', 'stock_transfer_items'
  ] loop
    execute format(
      'create policy tenant_isolation_insert on public.%I
       for insert to authenticated
       with check (tenant_id = public.get_my_tenant() and public.is_tenant_owner())', t
    );
    execute format(
      'create policy tenant_isolation_update on public.%I
       for update to authenticated
       using (tenant_id = public.get_my_tenant() and public.is_tenant_owner())
       with check (tenant_id = public.get_my_tenant() and public.is_tenant_owner())', t
    );
    execute format(
      'create policy tenant_isolation_delete on public.%I
       for delete to authenticated
       using (tenant_id = public.get_my_tenant() and public.is_tenant_owner())', t
    );
  end loop;
end $$;

-- branch_stock: no direct client writes at all. The RPCs are security definer
-- and bypass RLS, so nothing legitimate is lost.

grant select on public.branches, public.suppliers, public.branch_stock,
                public.sales_returns, public.return_items,
                public.stock_transfers, public.stock_transfer_items
  to authenticated;
grant insert, update, delete on public.branches, public.suppliers,
                public.sales_returns, public.return_items,
                public.stock_transfers, public.stock_transfer_items
  to authenticated;

-- ----------------------------------------------------------------------------
-- 11. BACKFILL for existing tenants
-- ----------------------------------------------------------------------------
-- Idempotent: every step is guarded, so re-running the migration is harmless.

-- 11a. A head office for every tenant that has no branch yet.
insert into public.branches (tenant_id, name, location, is_head_office)
select t.id, 'Main Branch', null, true
  from public.tenants t
 where not exists (select 1 from public.branches b where b.tenant_id = t.id);

-- 11b. Point all existing sales / sale_items / customers / expenses at their
--      tenant's default branch.
update public.sales s
   set branch_id = public.default_branch_id(s.tenant_id)
 where s.branch_id is null
   and s.tenant_id is not null;

update public.sale_items si
   set branch_id = public.default_branch_id(si.tenant_id)
 where si.branch_id is null
   and si.tenant_id is not null;

update public.customers c
   set branch_id = public.default_branch_id(c.tenant_id)
 where c.branch_id is null
   and c.tenant_id is not null;

update public.expenses e
   set branch_id = public.default_branch_id(e.tenant_id)
 where e.branch_id is null
   and e.tenant_id is not null;

-- 11c. Seed the stock ledger: all current stock sits at the default branch.
insert into public.branch_stock (tenant_id, branch_id, product_id, stock_quantity)
select p.tenant_id,
       public.default_branch_id(p.tenant_id),
       p.id,
       coalesce(p.stock_quantity, 0)
  from public.products p
 where p.tenant_id is not null
   and public.default_branch_id(p.tenant_id) is not null
   and not exists (
     select 1 from public.branch_stock bs where bs.product_id = p.id
   )
on conflict (branch_id, product_id) do nothing;

-- 11d. Adopt the existing free-text products.supplier values as real suppliers
--      so the new dropdown starts populated instead of losing that data.
insert into public.suppliers (tenant_id, name)
select distinct p.tenant_id, trim(p.supplier)
  from public.products p
 where p.tenant_id is not null
   and coalesce(trim(p.supplier), '') <> ''
on conflict (tenant_id, lower(name)) do nothing;

update public.products p
   set supplier_id = s.id
  from public.suppliers s
 where p.supplier_id is null
   and p.tenant_id = s.tenant_id
   and lower(trim(p.supplier)) = lower(s.name);
