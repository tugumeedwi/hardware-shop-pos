-- ============================================================================
-- Basic Accounting: chart_of_accounts, journal_entries, journal_entry_lines
-- ----------------------------------------------------------------------------
-- Creates tables for simplified double-entry accounting.
-- Default accounts are seeded via triggers on tenant creation.
-- ============================================================================

-- Create chart_of_accounts table
create table if not exists public.chart_of_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  account_code text not null,
  account_name text not null,
  account_type text not null check (account_type in ('asset', 'liability', 'equity', 'income', 'expense')),
  is_active boolean default true,
  created_at timestamptz default now()
);

-- Create journal_entries table
create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  entry_date date not null,
  description text not null,
  created_at timestamptz default now()
);

-- Create journal_entry_lines table
create table if not exists public.journal_entry_lines (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null references public.journal_entries(id) on delete cascade,
  account_id uuid not null references public.chart_of_accounts(id),
  tenant_id uuid not null references public.tenants(id),
  debit numeric(12,2) default 0,
  credit numeric(12,2) default 0
);

-- Grant permissions
grant select, insert, update on public.chart_of_accounts to authenticated;
grant select, insert on public.journal_entries to authenticated;
grant select, insert on public.journal_entry_lines to authenticated;

-- Add RLS policies
alter table public.chart_of_accounts force row level security;
alter table public.journal_entries force row level security;
alter table public.journal_entry_lines force row level security;

create policy "chart_of_accounts_tenant_isolation" on public.chart_of_accounts
  for all using (tenant_id = public.get_my_tenant());

create policy "journal_entries_tenant_isolation" on public.journal_entries
  for all using (tenant_id = public.get_my_tenant());

create policy "journal_entry_lines_tenant_isolation" on public.journal_entry_lines
  for all using (tenant_id = public.get_my_tenant());

-- Seed default accounts trigger on tenant creation
-- This trigger runs when a new tenant is inserted and creates basic accounting
-- structure for that tenant.
create or replace function public.seed_default_accounts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only seed if no accounts exist yet (idempotent)
  if not exists (select 1 from public.chart_of_accounts where tenant_id = new.id) then
    insert into public.chart_of_accounts (tenant_id, account_code, account_name, account_type)
    values
      (new.id, '1000', 'Cash', 'asset'),
      (new.id, '1100', 'Bank', 'asset'),
      (new.id, '1300', 'Accounts Receivable', 'asset'),
      (new.id, '2000', 'Accounts Payable', 'liability'),
      (new.id, '3000', 'Sales Revenue', 'income'),
      (new.id, '4000', 'Cost of Goods Sold', 'expense'),
      (new.id, '5000', 'Operating Expenses', 'expense'),
      (new.id, '6000', 'Payroll Expenses', 'expense');

    -- Create a default journal entry for opening balance
    insert into public.journal_entries (tenant_id, entry_date, description)
    values (new.id, current_date, 'Opening balance entry');

    insert into public.journal_entry_lines (journal_entry_id, account_id, debit, credit, tenant_id)
    values (currval('public.journal_entries_id_seq'), (select id from public.chart_of_accounts where account_code = '1000'), 0, 0, new.id);
  end if;

  return new;
end
$$;

create trigger trg_seed_default_accounts
  after insert on public.tenants
  for each row execute function public.seed_default_accounts();

-- Comment
comment on table public.chart_of_accounts is 'Chart of accounts for tenant accounting';
comment on column public.chart_of_accounts.account_code is 'Account code (e.g., 1000 for Cash)';
comment on column public.chart_of_accounts.account_name is 'Account name';
comment on column public.chart_of_accounts.account_type is 'Account type: asset, liability, equity, income, expense';
comment on table public.journal_entries is 'Journal entries representing financial transactions';
comment on column public.journal_entries.entry_date is 'Date of the journal entry';
comment on table public.journal_entry_lines is 'Individual lines within a journal entry';
comment on column public.journal_entry_lines.debit is 'Debit amount';
comment on column public.journal_entry_lines.credit is 'Credit amount';