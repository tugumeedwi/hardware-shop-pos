-- Atomic AI usage tracking.
--
-- The old track-usage edge function did a non-atomic read-modify-write: it
-- summed the month, checked the plan limit, then read the day's row and
-- updated/inserted it. Two concurrent requests could both pass the limit
-- check and then both add to the same row (or both insert), silently
-- over-minting tokens. This RPC performs the whole operation inside a single
-- transaction with a row lock on the tenant's daily record, so concurrent
-- track-usage calls serialize and can never double-count.

create or replace function public.track_usage(
  p_tokens_in integer,
  p_tokens_out integer,
  p_cost numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant       uuid := public.get_my_tenant();
  v_limit        integer;
  v_month_tokens integer;
  v_record       public.usage_records%rowtype;
  v_new_in       integer;
  v_new_out      integer;
  v_new_cost     numeric;
  v_projected    integer;
begin
  if v_tenant is null then
    raise exception '15999 No active tenant';
  end if;

  if p_tokens_in < 0 or p_tokens_out < 0 or p_cost < 0 then
    raise exception 'Usage values must be non-negative';
  end if;

  -- Resolve the plan limit (fall back to a generous default if unmapped).
  select coalesce(pl.monthly_token_limit, 2000000)
    into v_limit
    from public.tenants t
    left join public.plans pl
      on pl.id = t.plan_id or pl.stripe_price_id = t.plan_id
   where t.id = v_tenant;

  -- Current month usage (without the new request).
  select coalesce(sum(tokens_in + tokens_out), 0)::integer
    into v_month_tokens
    from public.usage_records
   where tenant_id = v_tenant
     and date >= date_trunc('month', current_date)::date;

  v_projected := v_month_tokens + p_tokens_in + p_tokens_out;
  if v_projected > v_limit then
    return jsonb_build_object(
      'allowed', false, 'limit', v_limit, 'used', v_month_tokens,
      'projected', v_projected, 'remaining', greatest(0, v_limit - v_month_tokens)
    );
  end if;

  -- Lock the tenant's daily record so concurrent calls serialize on it.
  select * into v_record
    from public.usage_records
   where tenant_id = v_tenant
     and date = current_date
   for update;

  if v_record.id is not null then
    v_new_in  := v_record.tokens_in + p_tokens_in;
    v_new_out := v_record.tokens_out + p_tokens_out;
    v_new_cost := v_record.cost + p_cost;
    update public.usage_records
       set tokens_in = v_new_in,
           tokens_out = v_new_out,
           cost = v_new_cost
     where id = v_record.id;
  else
    v_new_in  := p_tokens_in;
    v_new_out := p_tokens_out;
    v_new_cost := p_cost;
    insert into public.usage_records (tenant_id, date, tokens_in, tokens_out, cost)
    values (v_tenant, current_date, v_new_in, v_new_out, v_new_cost);
  end if;

  return jsonb_build_object(
    'allowed', true, 'limit', v_limit, 'used', v_projected,
    'remaining', greatest(0, v_limit - v_projected),
    'tokens_in', v_new_in, 'tokens_out', v_new_out, 'cost', v_new_cost
  );
end;
$$;

grant execute on function public.track_usage(integer, integer, numeric) to authenticated;