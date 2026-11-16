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
| `migrations/` | D1 schema |

## Run locally

Requires Node 20+.

```sh
npm install
npx wrangler d1 migrations apply used-car-scorer --local   # creates the local DB
cp .dev.vars.example .dev.vars                              # then add your GEMINI_API_KEY
npx wrangler pages dev                                      # http://localhost:8788
```

Tests: `npm test`, or open http://localhost:8788/tests.html.

Everything except screenshot extraction works without an API key.

---

## Deploy to Cloudflare (one-time setup)

You need a Cloudflare account (the free plan is enough) and the GitHub repo already pushed.

### 1. Log in with Wrangler

```sh
npx wrangler login
```

### 2. Create the production D1 database

```sh
npx wrangler d1 create used-car-scorer
```

Copy the `database_id` it prints into `wrangler.toml`, replacing the `00000000-…` placeholder. Then create the tables:

```sh
npx wrangler d1 migrations apply used-car-scorer --remote
```

Commit and push the updated `wrangler.toml`. The database ID is not a secret.

> Do this **before** connecting the repo (step 3). `wrangler.toml` is the source of truth for the D1 binding, so a deploy with the placeholder ID would bind to a database that doesn't exist.

### 3. Create the Pages project from GitHub

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** tab → **Import an existing Git repository** (or **Connect to Git**).
2. Pick the `carevalapp` repository.
3. Project name: `used-car-scorer`. This becomes `used-car-scorer.pages.dev`; if the name is taken, Cloudflare adds a suffix.
4. Build settings: **Framework preset** None. **Build command** leave empty. **Build output directory** `public`.
5. **Save and Deploy**.

From now on, every push to `main` deploys to production, and pushes to other branches create preview deployments.

### 4. Add the API key as a secret

```sh
npx wrangler pages secret put GEMINI_API_KEY --project-name used-car-scorer
```

Paste the key when prompted. Alternatively, in the dashboard: project → **Settings** → **Variables and Secrets** → **Add**, type **Secret**.

Secrets only apply to deployments made **after** they are set. Redeploy once: project → **Deployments** → latest → **⋯** → **Retry deployment**, or push any commit.

To switch to Anthropic: set `LLM_PROVIDER = "anthropic"` in `wrangler.toml`, then put the secret `ANTHROPIC_API_KEY` instead.

### 5. Lock the site with Cloudflare Access (email one-time PIN)

Until this step is done, **anyone with the URL can use the app and your API key.** Do it right after the first deploy.

**a. Set up Zero Trust** (first time only): dashboard → **Zero Trust**. Choose a team name and the **Free** plan. It may ask for a payment method even for the free plan.

**b. Enable One-time PIN login.** It is no longer on by default. Go to **Zero Trust** → **Integrations** → **Identity providers** → **Add new identity provider** → **One-time PIN**.

**c. Protect the preview deployments.** Go to **Workers & Pages** → `used-car-scorer` → **Settings** → **General** → **Access policy** → **Enable access policy**.

**d. Extend it to the production URL.** The switch in (c) covers only `*.used-car-scorer.pages.dev`. To also cover `used-car-scorer.pages.dev`:
1. Next to the access policy you just enabled, select **Manage**. This opens the Access application in Zero Trust.
2. On that application, under **Public hostname**, clear the `*` from the **Subdomain** field and **Save**. The application now protects the production URL.
3. Go back to the Pages project → **Settings** → **General** and **Enable access policy** again. This creates a second application for the previews.
4. In **Zero Trust** → **Access controls** → **Applications** you should now see two applications: one for `used-car-scorer.pages.dev` and one for `*.used-car-scorer.pages.dev`.

**e. Restrict both to your email.** For **each** of the two applications, open **Policies**. Make the Allow policy's **Include** rule **Emails** → your address, and remove anything broader (such as everyone or all account members). Under **Login methods**, make sure **One-time PIN** is enabled.

**f. Check it.** Open `https://used-car-scorer.pages.dev` in a private window. You should get the Cloudflare Access page asking for your email, and the PIN arrives by email. Also check that the API is locked:

```sh
curl -sI https://used-car-scorer.pages.dev/api/cars | head -3   # expect a 302 redirect to …cloudflareaccess.com
```

### 6. Check the gov lookup from Cloudflare

Open a car, enter a plate, and tap **Fetch gov data**. It worked from a home connection during development. If data.gov.il blocks or rate-limits Cloudflare's servers, the app says so and names the dataset that failed (e.g. "blocked (HTTP 403…)"). In that case fill those fields by hand; the rest of the app is unaffected.

---

## Configuration reference

| Name | Where | Default | Purpose |
|---|---|---|---|
| `LLM_PROVIDER` | `wrangler.toml` `[vars]` | `gemini` | `gemini` or `anthropic` |
| `GEMINI_API_KEY` | Pages secret / `.dev.vars` | — | Required when provider is Gemini |
| `GEMINI_MODEL` | `wrangler.toml` `[vars]` | `gemini-3.6-flash` | Optional override |
| `ANTHROPIC_API_KEY` | Pages secret / `.dev.vars` | — | Required when provider is Anthropic |
| `ANTHROPIC_MODEL` | `wrangler.toml` `[vars]` | `claude-opus-5-5` | Optional override |

## Backups

The **Export JSON** button on the car list downloads every car. **Import JSON** restores a file; cars with the same ID are overwritten, so importing the same backup twice is safe. You can also back up D1 directly:

```sh
npx wrangler d1 export used-car-scorer --remote --output backup.sql
```

## Changing the schema

Add a new file in `migrations/` (e.g. `0002_add_column.sql`). Apply it with `npx wrangler d1 migrations apply used-car-scorer --local` and then `--remote`. Update `public/fields.js` to match.

## Notes on the data

- **data.gov.il datasets** (IDs verified 2026-11-16, see `public/govmap.js`):
  - vehicle registry `053cea08-…`
  - private vehicle history `56063a99-…` (km at last test, structural-change flag)
  - ownership history `bb2355dc-…`
- **Hand count from gov data excludes dealer (סוחר) ownership rows.** The app shows how many were skipped.
- **Gov records lease (החכר) without saying private vs. fleet.** The app assumes fleet lease (the lower score) and says so.
- **Seller claims in an ad never fill the insurance-claims or service-history fields.** "No accidents" or "dealer serviced" go into notes instead, so the seller message still asks for the Slikah report.
