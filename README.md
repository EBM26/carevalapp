# Used Car Scorer

A small personal web app for scoring used cars from Israeli listings (Yad2, Facebook, dealers) against a 100-point rubric. Data is entered by hand, read from ad screenshots by an LLM, or fetched from data.gov.il by plate number. Unknown data gives a score **range** rather than a guess.

Stack: Cloudflare Pages (static `public/`), Pages Functions (`functions/`), D1. No frameworks, no build step. Access is protected with Cloudflare Access (email one-time PIN).

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

The first deploy loads, but the API returns errors until steps 3–4 are done.

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
| `GEMINI_API_KEY` | **Secret** | your Gemini API key | yes |
| `LLM_PROVIDER` | Plaintext | `gemini` | optional; `gemini` is the default |
| `GEMINI_MODEL` | Plaintext | e.g. `gemini-3.6-flash` | optional; the default is `gemini-3.6-flash` |
| `ANTHROPIC_API_KEY` | **Secret** | your Anthropic key | only if `LLM_PROVIDER` = `anthropic` |
| `ANTHROPIC_MODEL` | Plaintext | e.g. `claude-opus-5-5` | optional |

Optionally, under **Settings** → **Runtime**, set **Compatibility date** to `2026-11-01`, the date the code was tested with.

**Bindings, variables and secrets only apply to deployments made after you save them.** Redeploy once: **Deployments** → latest → **⋯** → **Retry deployment**, or push any commit.

### 5. Lock the site with Cloudflare Access (email one-time PIN)

Until this step is done, **anyone with the URL can use the app, read your cars, and spend your API key.** Do it right after the first deploy.

**a. Set up Zero Trust** (first time only): dashboard → **Zero Trust**. Choose a team name and the **Free** plan. It may ask for a payment method even for the free plan.

**b. Enable One-time PIN login.** It is no longer on by default. Go to **Zero Trust** → **Integrations** → **Identity providers** → **Add new identity provider** → **One-time PIN**.

**c. Protect the preview deployments.** Go to **Workers & Pages** → `used-car-scorer` → **Settings** → **General** → **Access policy** → **Enable access policy**.

**d. Extend it to the production URL.** The switch in (c) covers only `*.used-car-scorer.pages.dev`. To also cover `used-car-scorer.pages.dev`:
1. Next to the access policy you just enabled, select **Manage**. This opens the Access application in Zero Trust.
2. On that application, under **Public hostname**, clear the `*` from the **Subdomain** field and **Save**. The application now protects the production URL.
3. Go back to the Pages project → **Settings** → **General** and **Enable access policy** again. This creates a second application for the previews.
4. In **Zero Trust** → **Access controls** → **Applications** you should now see two applications: one for `used-car-scorer.pages.dev` and one for `*.used-car-scorer.pages.dev`.

**e. Restrict both to your email.** For **each** of the two applications, open **Policies**. Make the Allow policy's **Include** rule **Emails** → your address, and remove anything broader (such as everyone or all account members). Under **Login methods**, make sure **One-time PIN** is enabled.

**f. Check it.** Open `https://used-car-scorer.pages.dev` in a private window. You should get the Cloudflare Access page asking for your email, and the PIN arrives by email. Then open `https://used-car-scorer.pages.dev/api/cars` in another private window; it should also show the Access login, not JSON.

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
cp .dev.vars.example .dev.vars # then add your GEMINI_API_KEY (only needed for screenshots)
npm run dev                    # http://localhost:8788
```

Tests: `npm test`, or open http://localhost:8788/tests.html.

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
