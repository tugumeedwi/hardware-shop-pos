-- ============================================================================
-- Fix seed_default_accounts(): currval on a nonexistent sequence broke ALL
-- tenant inserts (signup). journal_entries.id is a uuid, so there is no
-- journal_entries_id_seq; capture the id with RETURNING instead. Also scope
-- the Cash-account lookup to the new tenant (the unscoped version could grab
-- another tenant's account).
-- ============================================================================

create or replace function public.seed_default_accounts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry_id uuid;
  v_cash_id  uuid;
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
    values (new.id, current_date, 'Opening balance entry')
    returning id into v_entry_id;

    select id into v_cash_id
      from public.chart_of_accounts
     where tenant_id = new.id
       and account_code = '1000'
     limit 1;

    insert into public.journal_entry_lines (journal_entry_id, account_id, debit, credit, tenant_id)
    values (v_entry_id, v_cash_id, 0, 0, new.id);
  end if;

  return new;
end
$$;

-- ============================================================================
-- End of 20261211000000_seed_trigger_fix.sql
-- ============================================================================
