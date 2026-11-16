# Build: Used Car Scorer (personal web app)

Build a small personal web app that scores used cars found on Israeli listing sites (Yad2, Facebook, dealers) using the rubric below. Input is manual entry or screenshots. No scraping, no crawling.

## Stack and constraints

- **Hosting:** Cloudflare Pages, with Pages Functions for the API and a D1 database for storage. Repo lives on GitHub and deploys to Pages on push.
- **Front end:** plain HTML, CSS, and vanilla JS. No frameworks, no front-end build step.
- **Layout:** mobile-first (I'll mostly use it on my phone right after screenshotting an ad). White background.
- **RTL:** Hebrew and English text both appear in data, so input fields must handle RTL text correctly (`dir="auto"`).
- **UI language switch (English / Hebrew):**
  - A toggle in the header switches every interface string: labels, buttons, dropdown options, rating badges, warnings, and the "what to find out next" list.
  - All strings live in one `i18n.js` file with `en` and `he` objects. No hard-coded UI text anywhere else.
  - Switching to Hebrew sets `<html lang="he" dir="rtl">` and the layout mirrors. Use CSS logical properties (`margin-inline-start`, `padding-inline-end`, etc.) instead of left/right so both directions work without separate stylesheets.
  - Numbers, prices (₪), and km stay readable in both directions; wrap them in `<bdi>` where needed.
  - Remember the choice per device in `localStorage`.
  - The seller message generator has its own language option. It defaults to Hebrew regardless of the UI language.
- **Auth:** protect the whole site with Cloudflare Access (one-time email PIN to my address). Give me step-by-step dashboard instructions; don't build a custom login.
- **Secrets:** the LLM API key is a Pages secret (`wrangler pages secret put`). It is never sent to the browser and never committed.
- **Persistence:** D1 is the source of truth. Keep JSON export/import buttons for backup.
- **Testability:** keep the scoring logic in pure functions in its own file so it runs in both the browser and the Functions, and can be tested.

Suggested structure:
- `public/` — `index.html`, `styles.css`, `app.js` (UI/state), `i18n.js` (EN/HE strings), `scoring.js` (pure scoring, shared), `models.json` (cabin-fit table), `tests.html`
- `functions/api/` — `cars.js` (CRUD), `gov.js` (plate lookup proxy), `extract.js` (screenshot → JSON)
- `schema.sql`, `wrangler.toml`, `README.md` with setup steps (D1 creation, migrations, secret, Access policy)

## API (Pages Functions)

- `GET /api/cars`, `POST /api/cars`, `PUT /api/cars/:id`, `DELETE /api/cars/:id`
- `GET /api/gov?plate=...`: server-side calls to data.gov.il (no CORS issues). Returns merged gov fields.
- `POST /api/extract`: receives screenshot(s) as base64, calls the LLM with the server-side key, returns JSON.
- Recompute and store `scoreMin`, `scoreMax`, `rating`, and `coverage` on every save so the list view can sort in SQL.

## D1 schema

- Table `cars` with columns for the fields below. Keep categorical fields as text and dates as ISO strings.
- Add a `field_sources` JSON column and an `updated_at` column.
- Index on `status` and `score_max`.
- Screenshots are **not** stored; only the extracted data is.

## Core data model

Each car is one record. Every field can be `null` (unknown). Track a `source` per field: `manual`, `screenshot`, `gov`, or `seller`.

Fields: plate, make, model, trim, year, firstRegistration (month/year), currentKm, lastTestKm, askingPrice, benchmarkPrice, benchmarkSource (`levi_yitzhak` | `yad2_comparables`), originalOwnership (private / private_lease / fleet_lease / rental / driving_school), handCount, ownershipHistory (array), testExpiry, insuranceClaims (none / cosmetic / moderate / major), serviceHistory (full / mostly / missing_1_2_years / none), cabinFit (easy / adequate / tight), tires (good / ok / worn), dealBreakers (4 tri-state flags: `no` / `unknown` / `yes`), notes, listingUrl, status (considering / contacted / inspected / rejected / bought), dateAdded.

## Input methods

1. **Manual entry form.** All fields optional. Dropdowns for categorical fields.
2. **Screenshot extraction.** Upload one or more screenshots of an ad. Send them to the LLM API with a strict prompt: "return only JSON matching this schema, use null for anything not visible, do not guess." Ads may be in Hebrew. Extract a plate number if visible in a photo. **Always show extracted values in the form for me to review and correct before saving.** The call goes through `/api/extract`, never directly from the browser. Make the provider configurable via an environment variable (Gemini or Anthropic).
3. **Plate lookup (gov open data).** When a plate exists, a "Fetch gov data" button queries the data.gov.il CKAN API (`https://data.gov.il/api/3/action/datastore_search?resource_id=...&filters={"mispar_rechev":...}`).
   - Datasets needed: the main private/commercial vehicle registry (make, model, trim, year, first registration, ownership type, test expiry), the private vehicle history dataset (km at last test, structural/color/tire change flags), and the ownership history dataset (ownership dates and types, which gives hand count).
   - **Verify resource IDs and field names yourself first** with `package_search` and a sample record. Don't trust IDs or field names from memory. Expected field names are along the lines of `tozeret_nm`, `kinuy_mishari`, `ramat_gimur`, `shnat_yitzur`, `moed_aliya_lakvish`, `tokef_dt`, `baalut`, `kilometer_test_aharon`, `shinui_mivne_ind`.
   - Calls go through `/api/gov`, server-side. If data.gov.il blocks Cloudflare's IPs or rate-limits, tell me, and fall back to manual entry for those fields.
   - Gov data overwrites only empty fields. If it conflicts with a value I entered, show both and let me pick.

## Scoring rubric (100 points)

### Step 1: Deal-breakers

Any confirmed `yes` means rating **AVOID**, regardless of points:

1. Structural/chassis damage (*ktzeh shilda*)
2. Total loss / rebuilt (*ovdan lehalacha*)
3. Active lien or seizure the seller can't clear
4. Seller refuses the plate, Slikah report, service history, or an independent inspection

`unknown` deal-breakers show as open flags, not as passes.

**Warnings (shown in red, no score change):**
- Ad mileage is lower than gov last-test mileage: possible odometer rollback.
- Gov structural-change flag is set.

### Step 2: Categories

**1. History & maintenance (30)**

Score = the lower of the two tier values:

| Claims tier | Value | Service tier | Value |
|---|---|---|---|
| none | 30 | full authorized, on schedule | 30 |
| cosmetic (0–2% value loss) | 20 | mostly complete | 20 |
| moderate (3–7%, non-structural) | 10 | missing 1–2 years | 10 |
| major (>7%) | 0 | none verifiable | 0 |

**2. Price vs. benchmark (25)**

Deviation `d = (asking − benchmark) / benchmark`:

| Deviation | Points |
|---|---|
| d ≤ −5% | 25 |
| −5% < d ≤ +5% | 18 |
| +5% < d ≤ +10% | 8 |
| d > +10% | 0 |

- Benchmark is the Levi Yitzhak weighted price if I enter it.
- Otherwise use the midpoint of a Yad2 comparables range I enter (low/high), and mark price confidence **LOW** in the UI.
- No financing bonus.

**3. Mileage & age (20)**

km/year = currentKm ÷ years since first registration, using months for precision. If currentKm is unknown, use lastTestKm and note it.

| km/year | Points |
|---|---|
| < 15,000 | 20 |
| 15,000–22,000 | 14 |
| 22,001–28,000 | 7 |
| > 28,000, or total > 130,000 km | 0 |

**4. Ownership & hand count (15)**

| Ownership history | Points |
|---|---|
| Rental, driving school, or 3+ hands on a car under 5 years old | 0 |
| 1st hand private | 15 |
| 1st hand private lease, or 2nd hand where all owners were private | 11 |
| 1st hand fleet lease, or 2nd hand ex-lease | 6 |
| Any other combination | 6, and flag it "review" |

**5a. Cabin fit (6)**

Must fit two car seats plus a full-size UPPAbaby stroller.

| Fit | Points |
|---|---|
| easy | 6 |
| adequate | 3 |
| tight | 0 |

Auto-suggest from `models.json`, a small editable table of model → fit. Seed it with common Israeli-market models: Corolla sedan/Touring Sports/Cross, Octavia, Elantra, Civic, Mazda 3, i20, i30, Yaris, Kia Picanto, Rio, Ceed, Niro, Sportage, Tucson, and so on. I can override it per car.

**5b. Upfront condition (4)**

| Test validity | Points | Tires | Points |
|---|---|---|---|
| ≥ 6 months left | 2 | new/good | 2 |
| 3–5 months left | 1 | ok | 1 |
| < 3 months left | 0 | worn | 0 |

### Step 3: Handling missing data (core feature)

- For every category with unknown inputs, compute a **min** (worst possible) and **max** (best possible) value given what is known. Example: claims known as "none" but service unknown means category 1 ranges 0–30. A partially known category narrows its range.
- **Total score is a range `[min, max]`.** Ratings:

| Total | Rating |
|---|---|
| 80–100 | STRONG BUY |
| 60–79 | OK |
| < 60 or any confirmed deal-breaker | AVOID |

- If min and max fall in the same rating band, show it as **confirmed**. Otherwise show it as **provisional**, e.g. "61–86: OK → possibly STRONG BUY".
- Show **coverage %**: the share of the 100 points that are fully known.
- Show which unknowns would move the score most (largest max − min), as a ranked "what to find out next" list.

## Seller question generator

Build a WhatsApp message in Hebrew that asks **only** for missing fields, based on this template:

> "היי, אשמח לכמה פרטים יבשים לפני שמגיע לראות: מה המקוריות של הרכב (פרטי / ליסינג / השכרה)? איזו רמת גימור בדיוק? מתי תאריך עלייה לכביש ועד מתי הטסט? יש היסטוריית טיפולים מלאה ודו"ח סליקה נקי מתאונות?"

- Also ask for the plate number if it's missing; it unlocks the gov lookup.
- Copy button, plus a `wa.me` link if a seller phone number is entered.

## Car list view

- Cards sorted by max score by default, with options to sort by min score or date added.
- Each card shows: score range bar, rating badge, coverage %, open deal-breaker flags, warnings, and status.
- Filter by status. Tap a card to edit it.
- Delete, with confirmation.

## Tests (`tests.html`)

Cover at least:

- Every band boundary in every category, e.g. d = −5% → 25, d = +5% → 18, 15,000 km/yr → 14.
- The min-of-two rule in category 1.
- A fully-unknown car scores `[0, 100]`.
- Any confirmed deal-breaker gives AVOID even at 100 points.
- **Example:** 2022 Corolla sedan, first registered Jan 2022, 86,000 km now (Nov 2026), 1st hand private lease, cabin easy, everything else unknown. Verify the range is computed correctly by hand in the test comments.

## Build order

1. `scoring.js` + `tests.html`
2. D1 schema + `/api/cars` + manual entry form + car list + export/import (test locally with `wrangler pages dev`)
3. Seller question generator
4. `/api/gov` plate lookup
5. `/api/extract` screenshot extraction
6. README: deploy, D1 migration, secret, and Cloudflare Access setup

Pause after step 1 and show me the test results before continuing.
