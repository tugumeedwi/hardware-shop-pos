-- ============================================================================
-- Per-tenant receipt customisation
-- ----------------------------------------------------------------------------
-- Adds branding columns to tenants (logo, business name, footer text, accent
-- colour, tax visibility, template) and a private `tenant-logos` storage bucket
-- whose objects are RLS-scoped by tenant folder (<tenant_id>/logo.png):
--   * owners can upload / update / delete their own folder
--   * any member of the tenant can read it (needed to render the logo)
-- ============================================================================

alter table public.tenants add column if not exists receipt_logo_url text;
alter table public.tenants add column if not exists receipt_business_name text;
alter table public.tenants add column if not exists receipt_footer_text text;
alter table public.tenants add column if not exists receipt_accent_color text default '#1E293B';
alter table public.tenants add column if not exists receipt_show_tax boolean default false;
alter table public.tenants add column if not exists receipt_template text default 'standard';

-- ----------------------------------------------------------------------------
-- Storage: private tenant-logos bucket
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('tenant-logos', 'tenant-logos', false)
on conflict (id) do nothing;

-- Owners can create / update / delete objects in their tenant's folder.
create policy "tenant_logos_owner_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'tenant-logos'
    and (storage.foldername(name))[1] = public.get_my_tenant()::text
    and public.is_tenant_owner()
  );

create policy "tenant_logos_owner_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'tenant-logos'
    and (storage.foldername(name))[1] = public.get_my_tenant()::text
    and public.is_tenant_owner()
  )
  with check (
    bucket_id = 'tenant-logos'
    and (storage.foldername(name))[1] = public.get_my_tenant()::text
    and public.is_tenant_owner()
  );

create policy "tenant_logos_owner_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'tenant-logos'
    and (storage.foldername(name))[1] = public.get_my_tenant()::text
    and public.is_tenant_owner()
  );

-- Any member of the tenant may read the logo (the receipt is rendered by all
-- cashiers, not just the owner).
create policy "tenant_logos_member_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'tenant-logos'
    and exists (
      select 1
      from public.tenant_memberships tm
      where tm.user_id = public.auth_uid()
        and tm.tenant_id = (storage.foldername(name))[1]::uuid
    )
  );