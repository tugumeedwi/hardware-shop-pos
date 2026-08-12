# Project Context for AI Assistant

## Overview
Multi-tenant SaaS POS system for hardware shops and phone shops.
Built as an offline-first PWA using React + Supabase.

## Tech Stack
- Frontend: React (Vite), Tailwind CSS, PWA (service worker)
- Backend: Supabase (PostgreSQL, Auth, RLS, Edge Functions)
- State: Dexie (IndexedDB), React Context, Zustand
- Additional libraries: react-router-dom, recharts, react-hot-toast, qz-tray

## Current Architecture
- Single-tenant originally; now migrating to multi-tenant.
- All database tables have `tenant_id` column for isolation.
- RLS policies enforce tenant scoping via `get_my_tenant()` function.
- Auth: Supabase email/password. User role stored in `profiles.role`.
- Offline sync using `syncQueue` in IndexedDB and a `syncManager.js`.

## Key Files
- `src/App.jsx` – Main router and providers
- `src/pages/POS.jsx` – Cashier interface (most critical)
- `src/utils/syncManager.js` – Offline sync logic
- `src/db/localDatabase.js` – Dexie schema
- `src/context/AuthContext.jsx` – User session and role

## Database Tables (Important)
- tenants
- tenant_memberships
- profiles
- products
- customers
- sales
- sale_items
- credit_transactions
- expenses
- activity_log
- sync_conflict_log
- (new) tax_invoices, tax_invoice_queue (to be added)

## Upcoming Features to Implement
1. URA/FDN e-invoicing integration:
   - Add tax columns to tenants: tax_enabled, tax_tin, tax_device_serial, tax_provider, tax_config
   - Create tax_invoices table
   - Edge Function to send invoices to URA/FDN with retry
2. Make POS generic for phone shops:
   - Add `attributes` JSONB to products
   - Support IMEI scanning (15-17 digit serial)
   - Hide unit selection for phone products; always piece-based

## Coding Standards
- All data access via Supabase client (never raw SQL from frontend).
- Offline writes go through IndexedDB syncQueue.
- Server-side logic in Edge Functions.
- Keep UI consistent with Bento/glassmorphism design (Zinc + Emerald).