-- ============================================================================
-- Advanced Reporting: Views for aggregated reporting data
-- ----------------------------------------------------------------------------
-- Creates views for dashboard charts and reports page.
-- These are materialized views or regular views returning aggregated data.
-- ============================================================================

-- Sales summary by date range view
create or replace view public.v_sales_summary as
select
  date_trunc('day', s.created_at) as sale_date,
  s.tenant_id,
  count(s.id) as total_sales,
  coalesce(sum(s.discount_total), 0) as total_discounts,
  coalesce(sum(s.total_amount), 0) as total_sales_amount,
  coalesce(sum(s.tax_amount), 0) as total_tax,
  count(s.id) filter (where s.payment_method = 'cash') as cash_sales,
  count(s.id) filter (where s.payment_method = 'mobile_money') as mobile_money_sales,
  count(s.id) filter (where s.payment_method = 'credit') as credit_sales
from public.sales s
group by date_trunc('day', s.created_at), s.tenant_id;

-- Daily sales trend view
create or replace view public.v_daily_sales as
select
  date(s.created_at) as sale_date,
  count(s.id) as num_sales,
  coalesce(sum(s.total_amount), 0) as daily_total,
  coalesce(sum(s.discount_total), 0) as daily_discounts,
  coalesce(sum(s.tax_amount), 0) as daily_tax
from public.sales s
where s.status = 'completed'
group by date(s.created_at)
order by sale_date desc
limit 30;

-- Sales by category view (joining sale_items with products)
create or replace view public.v_sales_by_category as
select
  p.category,
  count(si.id) as items_sold,
  coalesce(sum(si.line_total), 0) as revenue,
  coalesce(sum(si.line_total) * coalesce(p.tax_rate, 0) / 100, 0) as tax_amount
from public.sale_items si
join public.products p on si.product_id = p.id and p.tenant_id = si.tenant_id
join public.sales s on si.sale_id = s.id and s.tenant_id = p.tenant_id and s.status = 'completed'
group by p.category
order by revenue desc;

-- Inventory valuation view
create or replace view public.v_inventory_valuation as
select
  p.id as product_id,
  p.name as product_name,
  p.sku,
  coalesce(sum(bs.stock_quantity), 0) as total_stock,
  coalesce(sum(bs.stock_quantity) * p.price_per_piece, 0) as total_value,
  p.tenant_id
from public.products p
left join public.branch_stock bs on bs.product_id = p.id and bs.tenant_id = p.tenant_id
group by p.id, p.name, p.sku, p.price_per_piece, p.tenant_id;

-- Credit outstanding by customer view
create or replace view public.v_credit_outstanding as
select
  c.id as customer_id,
  c.name as customer_name,
  c.phone,
  c.current_credit_balance,
  c.credit_limit,
  case when (c.current_credit_balance > c.credit_limit) then true else false end as is_over_limit,
  coalesce(count(sc.id), 0) as num_credit_sales,
  coalesce(sum(sc.amount), 0) as total_credit_amount
from public.customers c
left join public.credit_transactions sc on sc.customer_id = c.id and sc.tenant_id = c.tenant_id
group by c.id, c.name, c.phone, c.current_credit_balance, c.credit_limit;

-- Employee sales summary view
create or replace view public.v_employee_sales as
select
  u.full_name as employee_name,
  u.id as user_id,
  count(s.id) as total_sales,
  coalesce(sum(s.total_amount), 0) as total_sales_amount,
  coalesce(sum(s.discount_total), 0) as total_discounts,
  coalesce(sum(s.tax_amount), 0) as total_tax
from public.sales s
join public.profiles u on s.cashier_id = u.id
group by u.id, u.full_name
order by total_sales_amount desc;

-- Grant permissions
grant select on public.v_sales_summary to authenticated;
grant select on public.v_daily_sales to authenticated;
grant select on public.v_sales_by_category to authenticated;
grant select on public.v_inventory_valuation to authenticated;
grant select on public.v_credit_outstanding to authenticated;
grant select on public.v_employee_sales to authenticated;

-- Comment
comment on view public.v_sales_summary is 'Daily sales summary for reporting';
comment on view public.v_daily_sales is 'Last 30 days daily sales trend';
comment on view public.v_sales_by_category is 'Sales revenue by product category';
comment on view public.v_inventory_valuation is 'Inventory valuation by product';
comment on view public.v_credit_outstanding is 'Customer credit outstanding summary';
comment on view public.v_employee_sales is 'Employee sales performance summary';