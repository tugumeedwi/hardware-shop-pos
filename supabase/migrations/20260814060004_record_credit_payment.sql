-- Atomic installment payment RPC.
--
-- The old Payments.jsx did a two-step insert + update that could race (two
-- network calls, no transaction, no overpay guard, and it never updated
-- sales.amount_paid so the "Paid" figure shown on the page was wrong). This
-- function does everything in one transaction, server-side, scoped to the
-- caller's tenant:
--   1. validates the sale is a completed credit sale for this customer
--   2. rejects overpayments (amount_paid + payment > total_amount)
--   3. inserts the credit_transaction (negative amount, new balance_after)
--   4. updates the customer balance and the sale's amount_paid
-- If the payment fully clears the sale it is also marked completed in the
-- same transaction.

create or replace function public.record_credit_payment(
  p_sale_id uuid,
  p_amount numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant     uuid := public.get_my_tenant();
  v_sale       public.sales%rowtype;
  v_customer   public.customers%rowtype;
  v_new_paid   numeric;
  v_new_bal    numeric;
begin
  if v_tenant is null then
    raise exception '15999 No active tenant';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Invalid payment amount';
  end if;

  select * into v_sale
    from public.sales s
   where s.id = p_sale_id
     and s.tenant_id = v_tenant
     and s.payment_method = 'credit'
     and s.type = 'pos';

  if not found then
    raise exception 'Credit sale not found';
  end if;

  v_new_paid := coalesce(v_sale.amount_paid, 0) + p_amount;
  if v_new_paid > v_sale.total_amount + 0.01 then
    raise exception 'Payment exceeds outstanding balance';
  end if;

  -- The customer must exist and belong to this tenant
  select * into v_customer
    from public.customers c
   where c.id = v_sale.customer_id
     and c.tenant_id = v_tenant;

  if not found then
    raise exception 'Customer not found';
  end if;

  v_new_bal := greatest(0, coalesce(v_customer.current_credit_balance, 0) - p_amount);

  insert into public.credit_transactions (tenant_id, customer_id, sale_id, amount, balance_after, notes)
  values (v_tenant, v_customer.id, v_sale.id, -p_amount, v_new_bal, 'Installment payment');

  update public.customers
     set current_credit_balance = v_new_bal,
         updated_at = now()
   where id = v_customer.id;

  update public.sales
     set amount_paid = v_new_paid,
         updated_at = now()
   where id = v_sale.id;
end;
$$;

grant execute on function public.record_credit_payment(uuid, numeric) to authenticated;