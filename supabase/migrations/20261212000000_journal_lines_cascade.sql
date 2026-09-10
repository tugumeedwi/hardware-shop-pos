-- ============================================================================
-- FK consistency: journal_entry_lines.tenant_id -> ON DELETE CASCADE.
-- Every other tenant_id FK in the schema cascades; this one blocked tenant
-- deletes (production tenant removal and the Playwright teardown hit
-- "violates foreign key constraint journal_entry_lines_tenant_id_fkey").
-- ============================================================================

alter table public.journal_entry_lines
  drop constraint if exists journal_entry_lines_tenant_id_fkey;

alter table public.journal_entry_lines
  add constraint journal_entry_lines_tenant_id_fkey
  foreign key (tenant_id) references public.tenants(id) on delete cascade;

-- ============================================================================
-- End of 20261212000000_journal_lines_cascade.sql
-- ============================================================================
