-- ============================================================================
-- Correct plan limits/prices after seeding
-- ----------------------------------------------------------------------------
-- Original seed used on conflict do nothing; update existing rows to the final
-- tier values (starter/pro token limits and Stripe price ids).
-- ============================================================================

update public.plans set
  monthly_token_limit = 10000,
  price = 10,
  stripe_price_id = 'price_1U4IIYRzHqbMcdYRJmIBb1yt'
where id = 'starter';

update public.plans set
  monthly_token_limit = 100000,
  price = 30
where id = 'pro';