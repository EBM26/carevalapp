# Used Car Scorer

A small personal web app for checking used cars from Israeli listings (Yad2, Facebook, dealers) in three stages:

1. **Quick check** from the ad alone: Pursue / Maybe / Skip.
2. **Seller message:** a short WhatsApp message, written by the AI, asking for what's missing.
3. **Full score** against a 100-point rubric, once the seller has replied (it becomes the headline at 50% coverage).

 Data is entered by hand, read from ad screenshots by an LLM, or fetched from data.gov.il by plate number. Unknown data gives a score **range** rather than a guess.

Stack: Cloudflare Pages (static `public/`), Pages Functions (`functions/`), D1. No frameworks, no build step. The whole site is password-protected by `functions/_middleware.js`.

---

## Project layout

| Path | What it is |
|---|---|
| `public/scoring.js` | The rubric. Pure functions, shared by the browser and Functions |
| `public/quickcheck.js` | Stage 1 rules (Skip / Maybe / good signs) and the price comparison (saved cars, AI estimate) |
| `public/sellermsg.js` | Stage 2: what to ask the seller and the prompt for the AI message |
| `public/priceestimate.js` | Prompt and schema for the rough AI price estimate |
| `public/verdict.js` | What the UI shows for a score: Avoid / Too early to tell / OK / Strong buy |
| `public/summary.js` | Rules for the "Good signs" / "Watch out" lists |
| `public/modelnotes.js` | Prompt and schema for "Known issues for this model" |
| `public/format.js` | Plate formatting (`12-345-67`, `123-45-678`) |
| `public/fields.js` | Car record definition: validation and the D1 column mapping |
| `public/govmap.js` | data.gov.il records → car fields, plus the gov/screenshot merge rule |
| `public/extraction.js` | LLM prompt, JSON schema, request builders and parsers |
| `public/seller.js` | WhatsApp message to the seller |
| `public/i18n.js` | Every UI string (English / Hebrew) |
| `public/app.js`, `index.html`, `styles.css` | UI |
| `public/tests.html`, `tests.js` | Test suite (browser), also runnable in Node |
| `functions/_middleware.js` | Password protection for every page and `/api` route (login page, signed session cookie, logout) |
| `public/auth.js` | Constant-time password check and session-token signing (WebCrypto) |
| `public/favicon.svg`, `favicon.ico`, `apple-touch-icon.png` | App icon (browser tab, iOS home screen) |
| `functions/api/cars/` | `GET/POST /api/cars`, `PUT/DELETE /api/cars/:id` |
| `functions/api/gov.js` | `GET /api/gov?plate=…` (server-side data.gov.il lookup) |
| `functions/api/extract.js` | `POST /api/extract` (screenshots → fields) |
| `functions/api/settings.js` | `GET/PUT /api/settings` (budget ceiling) |
| `functions/api/price-estimate.js` | `POST /api/price-estimate` (rough AI price range, cached per car) |
| `functions/api/seller-message.js` | `POST /api/seller-message` (AI-written WhatsApp message; the app falls back to a template) |
| `functions/api/registry.js` | `POST /api/registry` (stores the registry snapshot for a saved car) |
| `functions/api/model-notes.js` | `POST /api/model-notes` (known issues for a make/model/year, cached per car) |
| `functions/_lib/llm.js` | Shared Gemini/Anthropic call used by both LLM endpoints |
| `schema.sql` | Full D1 schema for a new database. Safe to re-run: every statement uses `IF NOT EXISTS` |
| `migrations/` | Changes for an existing database, applied in order (see "Database migrations") |
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

**Already created the database before November 2026?** Also run the migrations below.

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
| `GEMINI_MODEL_VISION` | Plaintext | e.g. `gemini-3.6-flash` | optional; screenshot reading. Default `gemini-3.6-flash` |
| `GEMINI_MODEL_TEXT` | Plaintext | e.g. `gemini-3.5-flash-lite` | optional; price estimate, seller message, known issues. Default `gemini-3.5-flash-lite` |
| `ANTHROPIC_API_KEY` | **Secret** | your Anthropic key | only if `LLM_PROVIDER` = `anthropic` |
| `ANTHROPIC_MODEL` | Plaintext | e.g. `claude-opus-5-5` | optional |

**Gemini quota.** Screenshots use the vision model; everything else uses the cheaper text model. If the vision model answers 429 (quota) or 503 (overloaded), the screenshot is retried once on the text model, which also reads images. If that fails too, or a text task hits its limit, the app shows "AI limit reached for today. Enter the details manually or try again tomorrow." instead of the raw API error. The seller message then falls back to the standard template. (`GEMINI_MODEL` from older setups still works as an override for the vision model.)

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

Tests: `npm test` runs the browser suite in Node, then the server tests (`scripts/server-tests.js`), which call the four AI endpoints against a mocked `fetch`. No test ever reaches the real Gemini or Anthropic API: an unmocked network request fails the run. You can also sign in and open http://localhost:8788/tests.html.

Locally the site runs on plain `http://`, so the session cookie is named `session` and isn't marked `Secure` (browsers won't reliably store `Secure` cookies over http). On Cloudflare (always https) it's `__Host-session` with `Secure`.

---

## Backups

The **Export JSON** button on the car list downloads every car. **Import JSON** restores a file; cars with the same ID are overwritten, so importing the same backup twice is safe.

## Database migrations

Existing databases need each file in `migrations/` applied once, in order. New databases created from the current `schema.sql` already include them.

| File | What it does | SQL to paste in the D1 console |
|---|---|---|
| `0002_model_notes.sql` | Adds the cache column for "Known issues for this model" | `ALTER TABLE cars ADD COLUMN model_notes TEXT;` |
| `0003_quick_check.sql` | Adds the `settings` table (budget ceiling) and the cache column for the AI price estimate | `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL);` then `ALTER TABLE cars ADD COLUMN price_estimate TEXT;` |
| `0004_registry_snapshot.sql` | Stores the last registry lookup per car, so the list can show seller-trust flags | `ALTER TABLE cars ADD COLUMN registry TEXT;` |
| `0005_location.sql` | Adds the car's location (city / area). **Required:** saving a car fails until it's applied | `ALTER TABLE cars ADD COLUMN location TEXT;` |
| `0006_seller_name.sql` | Adds the seller's name (greeting in the WhatsApp message). **Required:** saving a car fails until it's applied | `ALTER TABLE cars ADD COLUMN seller_name TEXT;` |

If the console answers `duplicate column name`, the migration is already applied. The old `cabin_fit` column is no longer used; it's left in place (no destructive migration). Until migrations 0002–0004 are applied the app still works: "Known issues" and the AI price estimate just aren't cached, and the budget ceiling can't be saved.

Locally, for each file: `npx wrangler d1 execute DB --local -c wrangler.local.toml --file=migrations/0002_model_notes.sql` (then `0003`, `0004`, `0005`).

## Changing the schema later

The production database is managed through the D1 console. For a new column:
1. Add it to `schema.sql`'s `CREATE TABLE`, for fresh databases.
2. Run an `ALTER TABLE cars ADD COLUMN …;` in the D1 console for the existing database.
3. Add the field to `public/fields.js`.
4. Locally, delete `.wrangler/state` and run `npm run db:local` again, or run the same `ALTER TABLE` with `npx wrangler d1 execute DB --local -c wrangler.local.toml --command "…"`.

## What happens automatically on the edit screen

- **Km per year** is worked out whenever possible and shown read-only next to the km field, in the list row and in the breakdown's mileage row. One function (`kmPerYear` in `public/scoring.js`) feeds the mileage score, the quick check and the seller message:
  - km: the higher of the ad km and the last-test km;
  - time on the road: from the first registration (registry) if known, otherwise from July 1 of the model year, labelled "estimated from year";
  - if the only km is the last-test km, the time runs to the last-test date, not to today.
- **Location** (city / area, free text) is read from screenshots and editable in "Car & plate". It shows under the car in the list and isn't scored.
- **Registry lookup** runs 600 ms after the plate becomes valid. Make, model, year and first registration take the registry value silently. Owners, original ownership, km, test date and trim keep what the ad (or you) said, and an **"Ad vs. registry"** table shows both side by side with ✓ match, ≠ differs, ⚠ suspicious or – unknown. **Scoring uses the registry value wherever there is one**; for km, the higher of ad km and last-test km. (If you chose private/fleet lease and the registry just says lease, your choice is kept.)
- **Loading states:** screenshots show thumbnails with a shimmer while being read; the price estimate, seller message and known issues each show a skeleton with a short label. With "reduce motion" turned on, these show a static "Working…" instead.

## Seller trust

Defined in `public/govcompare.js`. A row in "Ad vs. registry" is **suspicious** (⚠) only when the ad makes the car look better than the registry:

- fewer owners than registered
- "private" when the registry says lease, fleet, rental or driving school
- ad km below the last-test km
- a clearly higher trim (the ad adds "Plus", or uses a higher tier word: Premium/Luxury/Executive above Comfort/Style above Base/Active, Hebrew included)
- also a newer year than registered (year isn't a row; the registry year is used, but the ad's claim is remembered for this check)

Other differences (more owners, other ownership differences, lower or unrecognised trims, a test date in a different month) are neutral (≠). Ad km at or above the last-test km is a match.

With at least one suspicious row: a red "Ad doesn't match the registry" banner tops the score panel, the car gets a red flag in the list, the quick check adds a Maybe reason (two or more: Skip), and the seller message (AI or template) asks one polite question about each. The list needs migration `0004` to know a car's registry data.

## Score total

The categories add up to 94 points (history 30, price 25, mileage 20, ownership 15, test 2, tires 2). The total, its range and the coverage % are shown out of 100: raw × 100 / 94, rounded (94 → 100, 47 → 50). The 60 / 80 rating thresholds apply to that scaled total. The breakdown still shows each category against its own maximum (e.g. 25 / 25).

## Quick check rules

Defined in `public/quickcheck.js`. Unknown fields never count against a car.

- **Skip** (any one): asking price above your budget ceiling (⋯ menu → Settings); rental or driving-school ownership; 3+ hands on a car under 5 years old; over 28,000 km a year or over 130,000 km in total; a confirmed deal-breaker.
- **Maybe:** ex-fleet lease, or 2nd hand ex-lease; 22,001–28,000 km a year; price more than 5% above the comparison; no price comparison available.
- **Not enough info:** if fewer than 2 of (price comparison, km/year, ownership) are known, the verdict is "Not enough info" (grey), unless a Skip reason already rules the car out.
- **Verdict:** any Skip reason or 3+ Maybe reasons → Skip; 1–2 → Maybe; none → Pursue.
- **Price comparison,** first available: a Levi Yitzhak price (or Yad2 range) you entered; the median of 3+ saved cars with the same make and model, year ±1, adjusted by ₪0.15 per km (`KM_PRICE_ADJUST`); a rough AI estimate, fetched on the edit screen and cached per car.

## Notes on the data

- **data.gov.il datasets** (IDs verified 2026-11-16, see `public/govmap.js`):
  - vehicle registry `053cea08-…`
  - private vehicle history `56063a99-…` (km at last test, structural-change flag)
  - ownership history `bb2355dc-…`
- **Hand count from gov data excludes dealer (סוחר) ownership rows.** The app shows how many were skipped.
- **Gov records lease (החכר) without saying private vs. fleet.** The app assumes fleet lease (the lower score) and says so.
- **Seller claims in an ad never fill the insurance-claims or service-history fields.** "No accidents" or "dealer serviced" go into notes instead, so the seller message still asks for the Slikah report.
