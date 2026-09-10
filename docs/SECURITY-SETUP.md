# SalesHub POS – Security Setup Checklist

Manual settings that cannot be applied from code (Supabase Dashboard + GitHub).
No real secrets are stored here — only where to obtain each value.

## GitHub Secrets

Create at: GitHub repo → **Settings → Secrets and variables → Actions →
New repository secret**. Names must match exactly — the workflows reference
these names verbatim.

| Secret | How to obtain |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase Dashboard → account avatar (bottom-left) → **Access Tokens** → **Generate new token**. Used by the CLI to link the project and push migrations. |
| `SUPABASE_DB_PASSWORD` | The database password set at project creation. Lost it? Dashboard → **Project Settings → Database → Reset database password**. Needed by `supabase db push` / `migration list`. |
| `SUPABASE_PROJECT_REF` | Value: `isyksrqsrwqblqwtbkwb`. It is the `<ref>` in `https://<ref>.supabase.co` (Dashboard → **Project Settings → General → Reference ID**). |
| `VITE_SUPABASE_URL` | Value: `https://isyksrqsrwqblqwtbkwb.supabase.co`. Dashboard → **Project Settings → API → Project URL**. The `VITE_` prefix is required: `tests/helpers.ts` and the Vite app read exactly this env name. |
| `VITE_SUPABASE_ANON_KEY` | Dashboard → **Project Settings → API → `anon` `public` key**. Same `VITE_` prefix requirement as above. |
| `SUPABASE_SERVICE_ROLE_KEY` | Dashboard → **Project Settings → API → `service_role` `secret` key**. Bypasses RLS — never log, commit, or expose client-side. Used by `tests/helpers.ts` (`serviceClient()`) for setup/teardown. |

Consumers: `supabase-migrations.yml` uses the first three;
`tests.yml` uses the last three.

## Supabase Dashboard Settings

### Leaked Password Protection

1. Dashboard → project → **Authentication → Password Strength**
   (in newer layouts: **Auth → Policies → Password Strength**).
2. Toggle **Leaked password protection** ON. Supabase rejects passwords found
   in breach corpuses (HaveIBeenPwned k-anonymity; plaintext never leaves).
3. Recommended: minimum length 8+.

### MFA for Owners (TOTP, per user)

Supabase Auth MFA is per-user — there is no global "force MFA" toggle:

1. In-app path (to build): **Settings → Security → Enable authenticator app**
   for `owner` / `platform_admin` roles, calling
   `supabase.auth.mfa.enroll({ factorType: 'totp' })`, then `challenge()` +
   `verify()` at sign-in.
2. Until that UI ships, enroll each admin manually via the MFA API.
3. Sensitive edge functions (vault cert upload, payment approval) should call
   `supabase.auth.mfa.getAuthenticatorAssuranceLevel()` and require
   `currentLevel === 'aal2'`.

### Any Other Manual Settings

- **Auth → URL Configuration**: Site URL must be the production frontend
  (`https://saleshub-pos.netlify.app`); add preview URLs as needed, or
  password-reset/magic-link redirects break.
- **Auth → Email**: SMTP is via Brevo (see `supabase/config.toml`); confirm
  sender identity there after any credential change.
- **Database → Backups**: confirm daily backups + point-in-time recovery are
  enabled for the production project.

## Rotation Schedule

| Secret | Interval | Zero-downtime steps |
|---|---|---|
| `SUPABASE_DB_PASSWORD` | Every 90 days | 1. Reset in Dashboard → Database. 2. Update the GitHub Secret. 3. Re-run `Supabase Migrations` workflow. 4. Confirm green. |
| `SUPABASE_ACCESS_TOKEN` | Every 90 days, or on maintainer offboarding | 1. Generate new token. 2. Update the secret. 3. Re-run any workflow. 4. Delete the old token. |
| `SUPABASE_SERVICE_ROLE_KEY` | Only if exposed (dashboard rotation) | 1. Rotate in Dashboard → API. 2. Update secret + local `.env`. 3. Re-run `Tests` workflow. Never commit it. |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | On abuse only (anon is public by design) | 1. Rotate in Dashboard. 2. Update secrets. 3. Redeploy frontend. |
| Stripe webhook secret / URA certs | On suspected leak, immediately | Webhook: replace in Stripe + function env. URA: re-run the cert-upload flow. |

## CI/CD Notes

- **Why migrations run in CI**: `supabase db push` from the local sandbox was
  repeatedly SIGKILLed ~70s in (sandbox wall/CPU budget, compounded by lock
  waits for DDL on hot live tables such as `sales`). Workaround at the time:
  chunked `supabase db query -f` + `migration repair --status applied`.
  **Do not run `db push` from the sandbox** — merges to `main` touching
  `supabase/migrations/**` (or manual **Run workflow**) deploy via CI.
- **Watch runs**: GitHub repo → **Actions** tab → *Supabase Migrations* /
  *Tests*. The migrations job prints `migration list` before and after the
  push; any push failure fails the workflow.
- Playwright reports upload as the `playwright-report` artifact on test
  failure (14-day retention).

## Verify Everything Works

- [ ] All six secrets exist under repo **Settings → Secrets and variables → Actions**.
- [ ] `Supabase Migrations` workflow run is green (check the before/after `migration list` output).
- [ ] `Tests` workflow run is green (`npm ci`, lint, build, Playwright).
- [ ] Leaked password protection is ON (Authentication → Password Strength).
- [ ] Every `owner` / `platform_admin` has TOTP enrolled.
- [ ] Production Site URL + SMTP sender verified.
- [ ] Daily DB backups confirmed.
