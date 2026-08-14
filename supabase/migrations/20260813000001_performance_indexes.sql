-- ============================================================================
-- Performance indexes
-- ----------------------------------------------------------------------------
-- The core tables carry only a single-column (tenant_id) index. These add the
-- composite indexes that match the actual query hot paths (date-range scans,
-- ORDER BY created_at, per-customer lookups, idempotency checks, joins).
-- All statements are idempotent and safe to re-run.
-- ============================================================================

-- sales
create index if not exists idx_sales_tenant_created
  on public.sales (tenant_id, created_at desc);
create index if not exists idx_sales_tenant_type_status
  on public.sales (tenant_id, type, status);
create index if not exists idx_sales_tenant_idempotency
  on public.sales (tenant_id, idempotency_key);
create index if not exists idx_sales_customer
  on public.sales (customer_id);
create index if not exists idx_sales_id
  on public.sales (id);

-- sale_items
create index if not exists idx_sale_items_sale
  on public.sale_items (sale_id);
create index if not exists idx_sale_items_product
  on public.sale_items (product_id);

-- credit_transactions
create index if not exists idx_credit_transactions_customer
  on public.credit_transactions (customer_id);
create index if not exists idx_credit_transactions_sale
  on public.credit_transactions (sale_id);

-- activity_log / sync_conflict_log (ORDER BY created_at desc LIMIT N)
create index if not exists idx_activity_log_tenant_created
  on public.activity_log (tenant_id, created_at desc);
create index if not exists idx_sync_conflict_log_tenant_created
  on public.sync_conflict_log (tenant_id, created_at desc);

-- expenses (ORDER BY expense_date desc)
create index if not exists idx_expenses_tenant_date
  on public.expenses (tenant_id, expense_date desc);

-- customers (per-keystroke phone lookups + name ordering)
create index if not exists idx_customers_tenant_phone
  on public.customers (tenant_id, phone);
create index if not exists idx_customers_tenant_name
  on public.customers (tenant_id, name);

-- tax_invoices (retry scan by status + created_at)
create index if not exists idx_tax_invoices_tenant_status_created
  on public.tax_invoices (tenant_id, status, created_at);

-- tenants (stripe-webhook customer lookup)
create index if not exists idx_tenants_stripe_customer
  on public.tenants (stripe_customer_id);

-- product name / sku search (enables ILIKE via GIN trigram once search is
-- pushed to Postgres; harmless to enable ahead of time)
create extension if not exists pg_trgm;
create index if not exists idx_products_name_trgm
  on public.products using gin (name gin_trgm_ops);
create index if not exists idx_products_sku_trgm
  on public.products using gin (sku gin_trgm_ops);