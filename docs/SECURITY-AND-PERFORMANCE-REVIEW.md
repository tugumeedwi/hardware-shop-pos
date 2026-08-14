# Security, Performance & Multi-tenancy Review

Date: 2026-08-13
Scope: full codebase after multi-tenancy, onboarding, AI-metering and URA/FDN changes.

## Executive summary

- **The frontend query surface is tenant-safe.** Every `supabase.*` data query in `src/`
  omits `tenant_id` and relies on RLS (`tenant_id = get_my_tenant()`) and the
  `set_tenant_id()` insert trigger. No service keys, no hardcoded tenant/user UUIDs, no
  raw SQL in the client. The only key on disk is the publishable anon key (by design). ✅
- **The isolation risks were server-side**, not client-side: missing RLS on `profiles`,
  an owner-privilege-escalation path in `tenant_memberships`, a member-wide `tenants`
  UPDATE policy, unauthenticated/id-parameter-trusting Edge Functions, and a metadata
  precedence bug that broke real tenant switching. All fixed (below).
- **Performance** is bottlenecked by row-by-row offline sync, full-catalog re-pulls, a
  missing composite-index set, and unbounded frontend selects. The offline-sync hot path
  was replaced with the existing server `create_sale` RPC; a full index set was added.

## 1. Multi-tenancy correctness

| Finding | Severity | Status |
|---|---|---|
| All `src/` queries rely on RLS; no client passes `tenant_id` on tenant-scoped tables | – | ✅ verified, no change |
| `get_my_tenant()` preferred `app_metadata.tenant_id` (frozen at signup) over `user_metadata` (what the client can actually write) → multi-tenant switching silently did nothing; UI and RLS scope diverged | HIGH | ✅ fixed – migration now prefers `user_metadata` then `app_metadata`; the `tenant_memberships` join still blocks spoofing of tenants the user doesn't belong to |
| `::uuid` cast on metadata threw (self-DoS) if metadata was a non-UUID string | LOW | ✅ fixed – regex-guarded cast returns NULL (deny) instead |
| `tax_invoices.sale_id` FK not tenant-verified at insert (invoice can point at another tenant's sale) | LOW | Open – add `exists(sales s where s.id = sale_id and s.tenant_id = get_my_tenant())` to the `tax_invoices` WITH CHECK if needed |
| `queueTaxInvoiceAfterSale` derives the tenant from JWT metadata instead of the active tenant | LOW/MED | Mitigated – the `tax_invoices` insert is stamped by RLS to the real active tenant anyway |

## 2. Security findings

### Fixed in code

| Finding | Severity | Fix |
|---|---|---|
| `profiles` had **no RLS** – any authenticated user could read every user's `role`/`full_name` across all tenants and self-set `role='owner'` | CRITICAL | `20260813000000_security_hardening.sql`: enabled RLS; select = own row **or** same-tenant member (via `tenant_memberships`); insert/update/delete = own row only |
| `tenant_memberships` policy let **any member** INSERT/UPDATE/DELETE membership rows (self-grant `owner`, demote owners, delete the owner) | CRITICAL | Replaced `memberships_manage_active` with owner-gated `memberships_manage_owner` (USING + WITH CHECK require the caller to be an `owner` of `get_my_tenant()`) |
| `tenants_update_own` let **any member** update subscription/plan/tax columns | HIGH | Dropped; only the owner-scoped `tenants_update_owner` remains |
| `plans` table writable by any client (feeds AI metering limits) | MED | RLS enabled, read-only for authenticated; service role (used by Edge Functions) unaffected |
| Edge Functions `track-usage`, `check-usage`, `get-subscription-status` decoded the JWT with base64 (no verification) and trusted `user_metadata.tenant_id` → any user could read/write **any tenant's** usage/plan data (IDOR over service role) | HIGH | All three now use `supabase.auth.getUser(token)` (real verification) + a server-side `tenant_memberships` membership check via `supabase/functions/_shared/auth.ts` |
| `create-checkout-session` trusted `tenantId` from the request body (no auth at all) + open-redirect `successUrl`/`cancelUrl` | HIGH | Tenant now derived from verified session; **owner-only**; URLs must match the request origin or an `APP_ALLOWED_ORIGINS` allowlist |
| `test-tax-connection` trusted `tenant_id` from the body; disclosed the configured endpoint to any caller; SSRF surface | HIGH | Tenant derived from session; **owner-only**; `provider` (endpoint) removed from the response |
| `send-tax-invoice` took an unauthenticated `tax_invoice_id` – cross-tenant read + state mutation + provider fan-out | CRITICAL | Owner-only; the invoice lookup is now filtered by `.eq('tenant_id', tenantId)` (cross-tenant access is a guaranteed miss); `markSuccess`/`markFailed` also tenant-filtered |
| `signup-tenant` created pre-confirmed accounts (`email_confirm: true`) → account pre-emption of a victim's email | MED | `email_confirm: false`; Register page now sends users to login after "check your inbox" instead of auto-login |
| Frontend called a **nonexistent** `reset-password` function that would have reset any email's password | MED | New `reset-password` Edge Function added: owner-only + target must be a member of the caller's tenant |
| `stripe-webhook` | – | ✅ already correct: raw-body signature verification, no CORS, `tenant_id` only from verified event metadata |

### Remaining recommendations

- **`signup-tenant`**: no rate limiting / captcha. Add a rate limit (e.g. Redis-free approach: a tied signups-per-IP counter in a small table) before public launch; consider a pwned-password check (≥ 8 chars, mixed case) – UI currently enforces 6.
- **`tax_config.auth_token`** is readable by any tenant member through `tenants_read_own` (SELECT is row-scoped, not column-redacted). The browser can read it via a crafted select even though the UI never shows it. Mitigations: (a) endpoint that exposes `tax_config` without `auth_token`, or (b) store `auth_token` as an Edge-Function-managed secret (per-tenant) instead of in the row. **Recommended: (b)**.
- **Client-side role gating**: `App.jsx`/`Layout.jsx` now gate on `tenant.membership_role` (server-authoritative), so self-editing `profiles.role` grants nothing. Backend owners are still enforced by RLS policies.
- **Auth session in localStorage**: default Supabase persistence; acceptable for a PWA but XSS-exfiltratable. Keep user inputs escaped (React default) and consider `persistSession` audit later.
- **`get_my_tenant()`** still derives from the freshest JWT the browser presents; RLS never trusts a client-supplied `tenant_id` column. Defence-in-depth only.

## 3. Performance

### Fixed in code

1. **Offline sync (the worst bottleneck)** – `src/utils/syncManager.js`: `syncPendingSale`
   used ~2N+7 sequential network calls (per-line product fetch, per-line `deduct_stock`
   RPC, separate sale/items/credit writes) and could permanently skip stock deduction on
   retry. It now calls the existing server `create_sale` RPC **once** – atomic
   transaction, server-side price/stock/tamper/credit/tenant checks, idempotent.
2. **Retry/backoff** – failed `syncQueue` items now get `attempts` + `nextRetryAt` with
   exponential backoff (cap 60s) and are dropped after 10 attempts. Previously the whole
   queue was replayed on every load/online event with no backoff and unbounded retries.
3. **Dexie schema v4** (`src/db/localDatabase.js`) – fixes a latent `SchemaError`: the
   sync code queried `pendingSales` by `saleData.offline_created_at` but that nested index
   was never declared. Also removed non-indexable object keyPaths (`saleData`, `payload`),
   added `is_deleted`, `attempts`, `nextRetryAt`.
4. **Local mirror refresh** – wrapped in a single readwrite transaction (no more
   crash-interrupted clear()/bulkPut leaving an empty catalog).
5. **Realtime churn** (`src/hooks/useRealtime.js`) – callback held in a ref; inline arrow
   callbacks no longer tear down / re-subscribe the channel on every render.
6. **Indexes** (`20260813000001_performance_indexes.sql`) – composite indexes for sales
   `(tenant_id, created_at desc)`, `(tenant_id, type, status)`, `(tenant_id, idempotency_key)`;
   `sale_items(sale_id, product_id)`; `credit_transactions(customer_id, sale_id)`;
   `activity_log` / `sync_conflict_log` `(tenant_id, created_at desc)`;
   `expenses(tenant_id, expense_date desc)`; `customers(tenant_id, phone)` + `(tenant_id, name)`;
   `tax_invoices(tenant_id, status, created_at)`; `tenants(stripe_customer_id)`; and a
   `pg_trgm` GIN index on `products(name)` / `products(sku)` ready for server-side search.

### Recommended next steps (not changed – higher risk / product decisions)

- **SQL aggregates** for Dashboard/SalesHistory instead of pulling full tables client-side
  (a `dashboard_totals(tenant_id)` SECURITY DEFINER RPC).
- **Pagination/limits**: SalesHistory, Quotations, Expenses, SyncConflicts select
  unbounded rows. Add `.limit(100)` + infinite scroll / date-window queries.
- **POS catalog**: `products.select('*')` pulls the whole catalog and any realtime change
  triggers a full `clear()` + `bulkPut` on every open POS. Consider incremental upserts
  and a debounce; chunk `bulkPut` (≈500 rows) for large catalogs.
- **PWA**: `vite.config.js` has precache + navigation fallback but no runtime caching and
  no manifest icons (installability criteria not met). Add 192/512 icons. Deliberately do
  **not** cache Supabase REST responses in the SW – Dexie is the offline path and SW-cached
  auth/data would be a privacy risk.
- **`activity_log`** grows unbounded – add a retention job (e.g. keep 90 days).

## 4. Remaining issues / housekeeping

- **LOW** – dead code: `src/pages/POS_backup.jsx`, `src/pages/settings.jsx` (duplicate of
  `Settings.jsx`), `src/App.jsx.real`. Recommend deletion.
- **LOW** – hardcoded seed tenant UUID (`00000000-0000-4000-8000-000000000001`) backfills
  every pre-existing row into a shared "Default Shop". Fine as a one-time migration; do not
  reuse the id for new tenants.
- **LOW** – `.env` contains the publishable anon key (gitignored, bundled into `dist/`).
  Expected for anon keys; rotate only if the working tree is ever shared.
- **MED** – no `supabase/config.toml` in the repo, so `verify_jwt` / function enablement /
  declared secrets are not auditable from source. **Create it** and explicitly set
  `verify_jwt = true` for every function except `signup-tenant`, which must remain public
  (`--no-verify-jwt`).

## Deploy steps

```bash
supabase db push                       # applies 20260813000000_* migrations
supabase functions deploy _shared      # (bundles _shared for all functions)
supabase functions deploy signup-tenant --no-verify-jwt   # public signup ONLY
supabase functions deploy check-usage track-usage get-subscription-status \
  create-checkout-session test-tax-connection send-tax-invoice reset-password
```

Verify `verify_jwt = true` is configured for all of the JWT-gated functions above (default).
Set `APP_ALLOWED_ORIGINS=https://<your-app-domain>` for checkout redirects once live.