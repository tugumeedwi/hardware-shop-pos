-- ============================================================================
-- Customer Loyalty Program Tables
-- ----------------------------------------------------------------------------
-- loyalty_points: tracks points earned by customers
-- loyalty_redemptions: tracks points redeemed against sales
-- ============================================================================

-- Create loyalty_points table
create table if not exists public.loyalty_points (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  points integer not null default 0,
  updated_at timestamptz default now(),
  unique (tenant_id, customer_id)
);

-- Create loyalty_redemptions table
create table if not exists public.loyalty_redemptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sale_id uuid references public.sales(id),
  customer_id uuid references public.customers(id),
  points_redeemed integer not null,
  value_discounted numeric(12,2) not null default 0,
  created_at timestamptz default now()
);

-- Grant permissions
grant select, insert, update on public.loyalty_points to authenticated;
grant select, insert on public.loyalty_redemptions to authenticated;

-- Add RLS policies
alter table public.loyalty_enabled force row level security;

create policy "loyalty_points_tenant_isolation" on public.loyalty_points
  for all using (tenant_id = public.get_my_tenant());

create policy "loyalty_redemptions_tenant_isolation" on public.loyalty_redemptions
  for all using (tenant_id = public.get_my_tenant());

-- Comment
comment on table public.loyalty_points is 'Customer loyalty points earned per tenant';
comment on column public.loyalty_points.tenant_id is 'Tenant scope';
comment on column public.loyalty_points.customer_id is 'Customer who earned points';
comment on column public.loyalty_points.points is 'Points balance (1 point per 1000 UGX by default)';
comment on table public.loyalty_redemptions is 'Points redemptions against sales';
comment on column public.loyalty_redemptions.tenant_id is 'Tenant scope';
comment on column public.loyalty_redemptions.sale_id is 'Sale where points were redeemed';
comment on column public.loyalty_redemptions.customer_id is 'Customer who redeemed points';
comment on column public.loyalty_redemptions.points_redeemed is 'Number of points redeemed';
comment on column public.loyalty_redemptions.value_discounted is 'Monetary value discounted';