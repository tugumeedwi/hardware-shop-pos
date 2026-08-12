-- ============================================================================
-- Complete multi-tenancy migration
-- ----------------------------------------------------------------------------
-- - Backfills tenant_id on all tenant-scoped tables with a single seeded tenant
-- - Enforces tenant_id NOT NULL
-- - Creates get_my_tenant() from JWT (app_metadata, with user_metadata fallback)
--   + membership verification (prevents cross-tenant access by spoofed metadata)
-- - Creates a BEFORE INSERT trigger that stamps tenant_id automatically
-- - Enables RLS + tenant-isolation policies on every tenant-scoped table
-- - Overwrites server RPCs (create_sale, deduct_stock, convert_quotation) so they
--   are tenant-scoped now that RLS is enforced
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Extensions (idempotent)
-- ----------------------------------------------------------------------------
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. Make sure core multi-tenant tables exist
-- ----------------------------------------------------------------------------
create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  industry text,
  business_rules jsonb default '{}'::jsonb,
  stripe_customer_id text,
  subscription_status text default 'active',
  plan_id text,
  tax_enabled boolean default false,
  tax_tin text,
  tax_device_serial text,
  tax_provider text,
  tax_config jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Add any columns that may be missing on an existing tenants table
alter table public.tenants add column if not exists business_rules jsonb default '{}'::jsonb;
alter table public.tenants add column if not exists stripe_customer_id text;
alter table public.tenants add column if not exists subscription_status text default 'active';
alter table public.tenants add column if not exists plan_id text;
alter table public.tenants add column if not exists tax_enabled boolean default false;
alter table public.tenants add column if not exists tax_tin text;
alter table public.tenants add column if not exists tax_device_serial text;
alter table public.tenants add column if not exists tax_provider text;
alter table public.tenants add column if not exists tax_config jsonb default '{}'::jsonb;

create table if not exists public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'cashier',
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'cashier',
  full_name text
);

-- ----------------------------------------------------------------------------
-- 2. Seed the backfill tenant and attach every existing user to it
-- ----------------------------------------------------------------------------
insert into public.tenants (id, name, industry)
values ('00000000-0000-4000-8000-000000000001', 'Default Shop', 'hardware')
on conflict (id) do nothing;

insert into public.tenant_memberships (tenant_id, user_id, role)
select '00000000-0000-4000-8000-000000000001', p.id, coalesce(p.role, 'owner')
from public.profiles p
on conflict (tenant_id, user_id) do nothing;

-- ----------------------------------------------------------------------------
-- 3. Backfill tenant_id and enforce NOT NULL on all tenant-scoped tables
--    (products, customers, sales, sale_items, credit_transactions, expenses,
--     activity_log, sync_conflict_log)
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'products', 'customers', 'sales', 'sale_items',
    'credit_transactions', 'expenses', 'activity_log', 'sync_conflict_log'
  ] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I add column if not exists tenant_id uuid', t);
      execute format(
        'update public.%I set tenant_id = %L where tenant_id is null',
        t, '00000000-0000-4000-8000-000000000001'
      );
      execute format('alter table public.%I alter column tenant_id set not null', t);
      execute format('create index if not exists %I on public.%I (tenant_id)', 'idx_' || t || '_tenant', t);
    end if;
  end loop;
end $$;

-- Guarantee NOT NULL / indexes on the association table too
alter table public.tenant_memberships alter column tenant_id set not null;
alter table public.tenant_memberships alter column user_id set not null;
create index if not exists idx_tenant_memberships_user on public.tenant_memberships (user_id);
create index if not exists idx_tenant_memberships_tenant on public.tenant_memberships (tenant_id);
create unique index if not exists uq_tenant_memberships_tenant_user on public.tenant_memberships (tenant_id, user_id);

-- ----------------------------------------------------------------------------
-- 4. Tenant helpers
--    get_my_tenant() reads tenant_id from the JWT (app_metadata preferred,
--    user_metadata fallback) and returns it ONLY if the user is a verified
--    member of that tenant. Returns NULL when no tenant is selected -> RLS
--    denies everything, which is the safe default before a tenant is chosen.
--    The membership cross-check prevents a user from spoofing user_metadata
--    to read another tenant's data.
-- ----------------------------------------------------------------------------
create or replace function public.auth_jwt_claims()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function public.auth_uid()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function public.get_my_tenant()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tm.tenant_id
  from (
    select coalesce(
      nullif((j.claims -> 'app_metadata') ->> 'tenant_id', '')::uuid,
      nullif((j.claims -> 'user_metadata') ->> 'tenant_id', '')::uuid
    ) as claimed_tenant
    from (select public.auth_jwt_claims() as claims) j
  ) c
  join public.tenant_memberships tm
    on tm.tenant_id = c.claimed_tenant
   and tm.user_id = public.auth_uid()
  limit 1
$$;

grant execute on function public.get_my_tenant() to anon, authenticated;
grant execute on function public.auth_jwt_claims() to anon, authenticated;
grant execute on function public.auth_uid() to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5. BEFORE INSERT trigger that stamps tenant_id automatically
-- ----------------------------------------------------------------------------
create or replace function public.set_tenant_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.tenant_id is null then
    NEW.tenant_id := public.get_my_tenant();
  end if;
  if NEW.tenant_id is null then
    raise exception 'No active tenant – cannot determine tenant_id';
  end if;
  return NEW;
end;
$$;

grant execute on function public.set_tenant_id() to anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'products', 'customers', 'sales', 'sale_items',
    'credit_transactions', 'expenses', 'activity_log', 'sync_conflict_log'
  ] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('drop trigger if exists trg_set_tenant_id on public.%I', t);
      execute format(
        'create trigger trg_set_tenant_id before insert on public.%I
         for each row execute function public.set_tenant_id()', t
      );
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 6. RLS policies for tenant isolation
-- ----------------------------------------------------------------------------

-- 6a. Plain tenant-scoped tables: tenant_id = get_my_tenant()
do $$
declare t text;
begin
  foreach t in array array[
    'products', 'customers', 'sales', 'sale_items',
    'credit_transactions', 'expenses', 'activity_log', 'sync_conflict_log'
  ] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists tenant_isolation_all on public.%I', t);
      execute format('drop policy if exists tenant_isolation_select on public.%I', t);
      execute format('drop policy if exists tenant_isolation_insert on public.%I', t);
      execute format('drop policy if exists tenant_isolation_update on public.%I', t);
      execute format('drop policy if exists tenant_isolation_delete on public.%I', t);
      execute format(
        'create policy tenant_isolation_all on public.%I
         for all to authenticated
         using (tenant_id = public.get_my_tenant())
         with check (tenant_id = public.get_my_tenant())', t
      );
    end if;
  end loop;
end $$;

-- 6b. tenants: a user may read any tenant they belong to (for the selector).
--     No tenant_id column exists here; access is mediated through memberships.
alter table public.tenants enable row level security;
drop policy if exists tenants_read_own on public.tenants;
create policy tenants_read_own on public.tenants
  for select to authenticated
  using (
    id in (
      select tenant_id from public.tenant_memberships tm
      where tm.user_id = public.auth_uid()
    )
  );

-- 6c. tenant_memberships: users can always see their own memberships (needed
--     *before* a tenant is selected for the chooser) and members can manage
--     membership rows of the active tenant (owner adding cashiers).
alter table public.tenant_memberships enable row level security;
drop policy if exists memberships_read_own on public.tenant_memberships;
drop policy if exists memberships_manage_active on public.tenant_memberships;
create policy memberships_read_own on public.tenant_memberships
  for select to authenticated
  using (user_id = public.auth_uid() or tenant_id = public.get_my_tenant());

create policy memberships_manage_active on public.tenant_memberships
  for all to authenticated
  using (tenant_id = public.get_my_tenant())
  with check (tenant_id = public.get_my_tenant());

-- ----------------------------------------------------------------------------
-- 7. Tenant-aware server RPCs (SECURITY DEFINER bypasses RLS, so they must
--    scope every query explicitly by tenant). Replaces prior definitions.
-- ----------------------------------------------------------------------------

-- 7a. deduct_stock(product_id, deduction)
create or replace function public.deduct_stock(product_id uuid, deduction numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.get_my_tenant();
begin
  if v_tenant is null then
    raise exception '15999 No active tenant';
  end if;
  update public.products prod
     set stock_quantity = greatest(0, stock_quantity - abs(coalesce(deduction, 0)))
   where prod.id = product_id
     and prod.tenant_id = v_tenant;
  if not found then
    raise exception 'Product not found in current tenant';
  end if;
end;
$$;

-- 7b. convert_quotation(quotation_id)
create or replace function public.convert_quotation(quotation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.get_my_tenant();
begin
  if v_tenant is null then
    raise exception '15999 No active tenant';
  end if;
  update public.sales
     set status = 'completed'
   where id = quotation_id
     and type = 'quotation'
     and tenant_id = v_tenant;
  if not found then
    raise exception 'Quotation not found in current tenant';
  end if;
end;
$$;

-- 7c. create_sale(sale_data jsonb) -> uuid
--     Server-authoritative version of the POS sale: recalculates prices and
--     stock from the current catalog, verifies the client total, enforces
--     idempotency, deducts stock, and handles credit limits. All under a
--     single transaction scoped to the caller's tenant.
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

    v_deduction := case v_unit
      when 'piece' then v_qty
      when 'box'   then v_qty * coalesce(v_product.pieces_per_box, 0)
      when 'sqm'   then case when coalesce(v_product.m2_per_piece, 0) > 0
                             then ceil(v_qty / v_product.m2_per_piece) else 0 end
      when 'kg'    then case when coalesce(v_product.pieces_per_kg, 0) > 0
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
    sync_status, idempotency_key
  ) values (
    v_tenant,
    (sale_data ->> 'customer_id')::uuid,
    (sale_data ->> 'cashier_id')::uuid,
    coalesce(sale_data ->> 'type', 'pos'),
    coalesce(sale_data ->> 'status', 'completed'),
    coalesce(sale_data ->> 'payment_method', 'cash'),
    v_discount,
    v_final,
    coalesce((sale_data ->> 'amount_paid')::numeric, 0),
    nullif(sale_data ->> 'notes', ''),
    sale_data ->> 'offline_created_at',
    'synced',
    sale_data ->> 'idempotency_key'
  ) returning id into v_sale_id;

  insert into public.sale_items (sale_id, tenant_id, product_id, selling_unit, quantity_sold, unit_price, stock_deduction_pieces, line_total)
  select v_sale_id, v_tenant, product_id, selling_unit, quantity_sold, unit_price, stock_deduction_pieces, line_total
    from tmp_sale_items;

  -- Deduct stock
  for v_rec in select product_id, stock_deduction_pieces from tmp_sale_items loop
    update public.products prod
       set stock_quantity = greatest(0, stock_quantity - v_rec.stock_deduction_pieces)
     where prod.id = v_rec.product_id
       and prod.tenant_id = v_tenant;
  end loop;

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
         set current_credit_balance = v_balance
       where id = v_customer.id;
      insert into public.credit_transactions (tenant_id, customer_id, sale_id, amount, balance_after, notes)
      values (v_tenant, v_customer.id, v_sale_id, v_final, v_balance, 'POS credit sale');
    end if;
  end if;

  return v_sale_id;
end;
$$;

grant execute on function public.deduct_stock(uuid, numeric) to authenticated;
grant execute on function public.convert_quotation(uuid) to authenticated;
grant execute on function public.create_sale(jsonb) to authenticated;