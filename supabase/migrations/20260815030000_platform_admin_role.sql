-- ============================================================================
-- platform_admin profile role
-- ----------------------------------------------------------------------------
-- 1. Normalise any legacy role values outside the allowed set so the new CHECK
--    constraint cannot fail on pre-existing data (the app only ever writes
--    'owner' / 'cashier' / 'platform_admin').
-- 2. Replace any existing role CHECK on profiles with one that allows
--    'owner', 'cashier' and 'platform_admin'.
-- 3. Promote tugumeedwi@gmail.com to 'platform_admin'. Their tenant_memberships
--    row is left untouched, so they keep all owner-scoped pages and RLS access;
--    frontend role checks treat platform_admin as an owner for tenant routes.
-- ============================================================================

-- 1. Normalise unknown/legacy roles to the safest default (least privilege).
update public.profiles
   set role = 'cashier'
 where role is distinct from 'owner'
   and role is distinct from 'cashier'
   and role is distinct from 'platform_admin';

-- 2. Replace the role CHECK constraint (drop is a no-op if absent).
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('owner', 'cashier', 'platform_admin'));

-- 3. Promote the target user by email (profiles has no email column; the join
--    resolves it from auth.users). Emails are matched case-insensitively.
update public.profiles p
   set role = 'platform_admin'
  from auth.users u
 where p.id = u.id
   and lower(u.email) = 'tugumeedwi@gmail.com';
