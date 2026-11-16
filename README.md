# Used Car Scorer

A small personal web app for scoring used cars from Israeli listings (Yad2, Facebook, dealers) against a 100-point rubric. Data is entered by hand, read from ad screenshots by an LLM, or fetched from data.gov.il by plate number. Unknown data gives a score **range** rather than a guess.

Stack: Cloudflare Pages (static `public/`), Pages Functions (`functions/`), D1. No frameworks, no build step. The whole site is password-protected by `functions/_middleware.js`.

---

## Project layout

| Path | What it is |
|---|---|
| `public/scoring.js` | The rubric. Pure functions, shared by the browser and Functions |
| `public/fields.js` | Car record definition: validation and the D1 column mapping |
| `public/govmap.js` | data.gov.il records → car fields, plus the gov/screenshot merge rule |
| `public/extraction.js` | LLM prompt, JSON schema, request builders and parsers |
| `public/seller.js` | WhatsApp message to the seller |
| `public/i18n.js` | Every UI string (English / Hebrew) |
| `public/models.json` | Cabin-fit table (model → easy / adequate / tight). Edit freely |
| `public/app.js`, `index.html`, `styles.css` | UI |
| `public/tests.html`, `tests.js` | Test suite (browser), also runnable in Node |
| `functions/_middleware.js` | Password protection for every page and `/api` route (login page, signed session cookie, logout) |
| `public/auth.js` | Constant-time password check and session-token signing (WebCrypto) |
| `public/favicon.svg`, `favicon.ico`, `apple-touch-icon.png` | App icon (browser tab, iOS home screen) |
| `functions/api/cars/` | `GET/POST /api/cars`, `PUT/DELETE /api/cars/:id` |
| `functions/api/gov.js` | `GET /api/gov?plate=…` (server-side data.gov.il lookup) |
| `functions/api/extract.js` | `POST /api/extract` (screenshots → fields) |
| `schema.sql` | D1 schema. Safe to re-run: every statement uses `IF NOT EXISTS` |
| `wrangler.local.toml` | **Local dev only.** Cloudflare ignores it; production settings live in the dashboard |

There is deliberately no `wrangler.toml`. If one existed, Cloudflare Pages would treat it as the source of truth and lock the bindings and variables you set in the dashboard.

---

## Deploy (Cloudflare dashboard only)

Everything below happens in the Cloudflare dashboard. No Wrangler commands are needed.

### 1. Create the D1 database and apply the schema

1. Go to **Storage & Databases** → **D1 SQL Database** → **Create database**.
2. Name: `used-car-scorer` (any name works; the binding name in step 3 is what matters). Location: automatic.
3. Open the new database and go to the **Console** tab.
4. Open `schema.sql` from this repo, paste its contents into the console and **Execute**.
   - The file contains 3 statements: `CREATE TABLE cars`, then two `CREATE INDEX`.
   - If the console rejects the paste, or creates only the table, run the statements **one at a time**. Each statement is a single line ending in `;`.
5. Check it worked by running this in the console:

   ```sql
   SELECT type, name FROM sqlite_master WHERE name LIKE '%cars%';
   ```

   You should see 3 rows: `table cars`, `index idx_cars_status`, `index idx_cars_score_max`.

Re-running `schema.sql` is harmless; it won't touch existing data.

### 2. Create the Pages project from GitHub

**Workers & Pages** → **Create** → **Pages** tab → **Import an existing Git repository** (may be labelled **Connect to Git**) → pick the `carevalapp` repo.

| Setting | Value |
|---|---|
| Project name | `used-car-scorer` (becomes `used-car-scorer.pages.dev`; Cloudflare adds a suffix if taken) |
| Production branch | `main` |
| Framework preset | **None** |
| Build command | *(leave empty)* |
| Build output directory | `public` |
| Root directory (advanced) | *(leave empty: repo root)* |
| Environment variable (build) | `SKIP_DEPENDENCY_INSTALL` = `1` (optional: skips installing the dev-only `wrangler` package, so builds are faster) |

**Save and Deploy.** The `functions/` folder is detected automatically and becomes the `/api/*` routes.

Until steps 3–4 are done, the first deploy shows "Login isn't configured yet". That's expected: the site fails closed without its secrets.

### 3. Bind the database

Pages project → **Settings** → **Bindings** → **Add** → **D1 database bindings**:

| Field | Value |
|---|---|
| Variable name | `DB` (exactly this; the code uses `env.DB`) |
| D1 database | `used-car-scorer` (the one from step 1) |

Add it for **Production**, and for **Preview** too if you want preview deployments to work. Preview can point at the same database or a separate one.

### 4. Variables and secrets

Pages project → **Settings** → **Variables and Secrets** → **Add**:

| Name | Type | Value | Required |
|---|---|---|---|
| `APP_PASSWORD` | **Secret** | the password you'll type to sign in | **yes** |
| `SESSION_SECRET` | **Secret** | a random string of **at least 32 characters** (see below) | **yes** |
| `GEMINI_API_KEY` | **Secret** | your Gemini API key | yes |
| `LLM_PROVIDER` | Plaintext | `gemini` | optional; `gemini` is the default |
| `GEMINI_MODEL` | Plaintext | e.g. `gemini-3.6-flash` | optional; the default is `gemini-3.6-flash` |
| `ANTHROPIC_API_KEY` | **Secret** | your Anthropic key | only if `LLM_PROVIDER` = `anthropic` |
| `ANTHROPIC_MODEL` | Plaintext | e.g. `claude-opus-5-5` | optional |

To make a `SESSION_SECRET`, run `openssl rand -base64 32` in a terminal, or use any password manager's generator set to 40+ characters. It is only used to sign the login cookie; you never type it.

Without both `APP_PASSWORD` and `SESSION_SECRET` the site **fails closed**: every page shows "Login isn't configured yet" and the API returns 503.

Optionally, under **Settings** → **Runtime**, set **Compatibility date** to `2026-11-01`, the date the code was tested with.

**Bindings, variables and secrets only apply to deployments made after you save them.** Redeploy once: **Deployments** → latest → **⋯** → **Retry deployment**, or push any commit.

### 5. How the password protection works

There is nothing extra to set up in Cloudflare: the `APP_PASSWORD` and `SESSION_SECRET` secrets from step 4 are all it needs. Preview deployments are protected the same way, as long as the secrets are also set for **Preview**.

- **Every page, file and `/api` route** requires a session. The only exceptions are the three icon files, so the login page can show its tab icon. Without a session, pages show a sign-in screen (English/Hebrew, following the app's language toggle) and `/api/*` returns `401 {"error":"unauthorized"}`.
- **Signing in** sets a cookie named `__Host-session`, valid for **30 days**, with `Secure`, `HttpOnly`, `SameSite=Lax` and `Path=/`. The cookie holds only an expiry time and an HMAC signature made with `SESSION_SECRET`; the password is never stored in it.
- **The password check is constant-time**, and wrong attempts are delayed by about 0.6 s. There is no lockout (that would need shared storage), so **use a long password**, e.g. four or more random words.
- **Log out** is in the header and clears the cookie.
- **To log out every device**, change `SESSION_SECRET` or `APP_PASSWORD` and redeploy. Existing cookies stop being valid immediately.

**Check it:** open `https://used-car-scorer.pages.dev` in a private window. You should see the sign-in page. In another private window, `https://used-car-scorer.pages.dev/api/cars` should return `{"error":"unauthorized"}`.

### 6. Smoke test

1. Add a car and save it. It appears in the list. (A database error here usually means the `DB` binding from step 3 is missing, or the schema from step 1 wasn't applied.)
2. Enter a plate and tap **Fetch gov data**. It worked from a home connection during development. If data.gov.il blocks or rate-limits Cloudflare's servers, the app says so and names the dataset that failed (e.g. "blocked (HTTP 403…)"). In that case fill those fields by hand; the rest of the app is unaffected.
3. Import a screenshot of an ad. "GEMINI_API_KEY is not configured" means the secret is missing or you haven't redeployed since adding it.

---

## Run locally

Requires Node 20+. Local dev uses a local D1 database on your machine and never touches your Cloudflare account.

```sh
npm install
npm run db:local               # applies schema.sql to the local database
cp .dev.vars.example .dev.vars # then set APP_PASSWORD, SESSION_SECRET (required) and GEMINI_API_KEY (screenshots only)
npm run dev                    # http://localhost:8788
```

Tests: `npm test`, or sign in and open http://localhost:8788/tests.html.

Locally the site runs on plain `http://`, so the session cookie is named `session` and isn't marked `Secure` (browsers won't reliably store `Secure` cookies over http). On Cloudflare (always https) it's `__Host-session` with `Secure`.

---

## Backups

The **Export JSON** button on the car list downloads every car. **Import JSON** restores a file; cars with the same ID are overwritten, so importing the same backup twice is safe.

## Changing the schema later

The production database is managed through the D1 console. For a new column:
1. Add it to `schema.sql`'s `CREATE TABLE`, for fresh databases.
2. Run an `ALTER TABLE cars ADD COLUMN …;` in the D1 console for the existing database.
3. Add the field to `public/fields.js`.
4. Locally, delete `.wrangler/state` and run `npm run db:local` again, or run the same `ALTER TABLE` with `npx wrangler d1 execute DB --local -c wrangler.local.toml --command "…"`.

## Notes on the data

- **data.gov.il datasets** (IDs verified 2026-11-16, see `public/govmap.js`):
  - vehicle registry `053cea08-…`
  - private vehicle history `56063a99-…` (km at last test, structural-change flag)
  - ownership history `bb2355dc-…`
- **Hand count from gov data excludes dealer (סוחר) ownership rows.** The app shows how many were skipped.
- **Gov records lease (החכר) without saying private vs. fleet.** The app assumes fleet lease (the lower score) and says so.
- **Seller claims in an ad never fill the insurance-claims or service-history fields.** "No accidents" or "dealer serviced" go into notes instead, so the seller message still asks for the Slikah report.
