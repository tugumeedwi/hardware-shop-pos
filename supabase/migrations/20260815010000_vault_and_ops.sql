-- ============================================================================
-- Vault secrets for tax auth tokens + operational hardening
-- ----------------------------------------------------------------------------
--  1. Public Vault wrapper RPCs (idempotent, version-agnostic). The provider
--     auth_token is a credential and must not live in the members-readable
--     tenants.tax_config column. Secrets are stored encrypted via Vault.
--  2. save_tax_auth_token / has_tax_auth_token – owner-only RPCs used by the
--     TaxSettings page. save strips any plaintext token left in tax_config.
--  3. Backfill: migrate any existing plaintext tax_config.auth_token values
--     into Vault secrets and remove them from the JSON.
--  4. dashboard_summary() – one aggregate RPC so the Dashboard no longer pulls
--     every all-time sales/customer/expense row over REST.
--  5. Add the tenant-scoped tables to the supabase_realtime publication so
--     useRealtimeSubscription() works without a manual dashboard step.
--  6. Re-schedule the ura-invoice-cron pg_cron job using a configurable base
--     URL (app.cron_base_url), defaulting to the project host.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Vault wrapper RPCs
-- ----------------------------------------------------------------------------
create extension if not exists supabase_vault with schema vault;

-- The project already ships these public wrappers (with a different return
-- type), so they must be dropped before they can be recreated with the
-- signature below – CREATE OR REPLACE cannot change a function's return type.
drop function if exists public.vault_create_secret(text, text);
drop function if exists public.vault_delete_secret(text);
drop function if exists public.vault_get_secret(text);

create or replace function public.vault_create_secret(secret_name text, secret_value text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into vault.secrets (name, secret)
  values (secret_name, secret_value)
  on conflict (name) do update set secret = excluded.secret, updated_at = now()
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.vault_delete_secret(secret_name text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from vault.secrets where name = secret_name;
  return found;
end;
$$;

create or replace function public.vault_get_secret(secret_name text)
returns text
language sql
security definer
set search_path = public
as $$
  select decrypted_secret
    from vault.decrypted_secrets
   where name = secret_name
   limit 1;
$$;

-- ----------------------------------------------------------------------------
-- 2. Owner-only tax auth token management
-- ----------------------------------------------------------------------------
create or replace function public.save_tax_auth_token(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.get_my_tenant();
  v_name   text;
  v_tax    jsonb;
begin
  if v_tenant is null then
    raise exception '15999 No active tenant';
  end if;
  if not public.is_tenant_owner() then
    raise exception 'Owner permissions required';
  end if;

  v_name := 'tax_auth_token_' || v_tenant::text;

  if p_token is null or p_token = '' then
    delete from vault.secrets where name = v_name;
  else
    insert into vault.secrets (name, secret)
    values (v_name, p_token)
    on conflict (name) do update set secret = excluded.secret, updated_at = now();
  end if;

  -- Strip any plaintext token that may linger in tax_config.
  v_tax := (select tax_config from public.tenants where id = v_tenant);
  if v_tax is not null and v_tax ? 'auth_token' then
    update public.tenants
       set tax_config = v_tax - 'auth_token'
     where id = v_tenant;
  end if;

  return true;
end;
$$;

create or replace function public.has_tax_auth_token()
returns boolean
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
  return exists (select 1 from vault.secrets where name = 'tax_auth_token_' || v_tenant::text);
end;
$$;

grant execute on function public.vault_create_secret(text, text) to authenticated, service_role;
grant execute on function public.vault_delete_secret(text) to authenticated, service_role;
grant execute on function public.vault_get_secret(text) to authenticated, service_role;
grant execute on function public.save_tax_auth_token(text) to authenticated;
grant execute on function public.has_tax_auth_token() to authenticated;

-- ----------------------------------------------------------------------------
-- 3. Backfill existing plaintext tokens into Vault
-- ----------------------------------------------------------------------------
do $$
declare
  v_rec   record;
  v_token text;
begin
  for v_rec in
    select id, tax_config from public.tenants where tax_config ? 'auth_token'
  loop
    v_token := nullif(v_rec.tax_config ->> 'auth_token', '');
    update public.tenants
       set tax_config = v_rec.tax_config - 'auth_token'
     where id = v_rec.id;
    if v_token is not null then
      insert into vault.secrets (name, secret)
      values ('tax_auth_token_' || v_rec.id::text, v_token)
      on conflict (name) do update set secret = excluded.secret, updated_at = now();
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Dashboard aggregate RPC
-- ----------------------------------------------------------------------------
create or replace function public.dashboard_summary()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'total_sales',
      coalesce((select sum(total_amount) from public.sales
                 where tenant_id = public.get_my_tenant() and type = 'pos' and status = 'completed'), 0),
    'credit_outstanding',
      coalesce((select sum(current_credit_balance) from public.customers
                 where tenant_id = public.get_my_tenant()), 0),
    'expenses_total',
      coalesce((select sum(amount) from public.expenses
                 where tenant_id = public.get_my_tenant()), 0)
  );
$$;

grant execute on function public.dashboard_summary() to authenticated;

-- ----------------------------------------------------------------------------
-- 5. Realtime publication for the tenant-scoped tables
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'products', 'customers', 'sales', 'sale_items', 'credit_transactions',
    'expenses', 'tax_invoices', 'activity_log', 'tenants', 'tenant_memberships'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 6. Configurable ura-invoice-cron URL
-- ----------------------------------------------------------------------------
create extension if not exists pg_cron with schema cron;
create extension if not exists pg_net;

select cron.unschedule('ura-invoice-cron-every-minute') where exists (
  select 1 from cron.job where jobname = 'ura-invoice-cron-every-minute'
);

do $$
declare
  v_url text;
  v_cmd text;
begin
  -- Override by running:
  --   alter database postgres set app.cron_base_url = 'https://your-project.supabase.co';
  --   select pg_reload_conf();
  v_url := coalesce(
    nullif(current_setting('app.cron_base_url', true), ''),
    'https://isyksrqsrwqblqwtbkwb.supabase.co'
  );
  v_cmd := format($f$
    select net.http_post(
      url := '%s/functions/v1/ura-invoice-cron',
      body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type', 'application/json'),
      timeout_milliseconds := 10000
    ) as request_id;
  $f$, v_url);
  perform cron.schedule('ura-invoice-cron-every-minute', '* * * * *', v_cmd);
end $$;
