# Car Scorer: front-end redesign

The app works, but it looks generic and the form controls look like browser defaults. Redesign the front end only.

**No changes to:**
- scoring logic
- API routes
- the database
- auth
- i18n keys (you can add new keys)

Keep plain HTML/CSS/JS, no frameworks.

**The only back-end additions allowed:**
- the `/api/model-notes` endpoint
- its D1 cache column (see "Score panel content")

## Design direction

This is a tool for checking used cars in Israel. It should feel like a calm, precise inspection report, not a SaaS dashboard. White background stays.

**The one memorable element: the license plate.** Show plate numbers as a small Israeli plate badge wherever a car appears:
- yellow background, black bold digits
- formatted `12-345-67` or `123-45-678`
- thin dark border, slight rounding
- a narrow blue strip with "IL" on the left, like real plates

When there's no plate, show a muted dashed-outline plate with "No plate" (i18n).

Everything else stays quiet and disciplined.

### Tokens (CSS custom properties)

| Token | Value | Use |
|---|---|---|
| `--ink` | `#1C2228` | text |
| `--steel` | `#6B7480` | secondary text, labels |
| `--line` | `#E3E6EA` | borders, dividers |
| `--surface` | `#F6F7F9` | input backgrounds, track backgrounds |
| `--plate` | `#FFCB05` | plate badge only (don't use it as a general accent) |
| `--action` | `#1F4E8C` | primary buttons, links, focus ring, selected segments |
| `--good` | `#1E8E5A` | STRONG BUY |
| `--ok` | `#B7791F` | OK |
| `--bad` | `#C8372D` | AVOID, deal-breakers, warnings |

### Typography

- **Font:** IBM Plex Sans with IBM Plex Sans Hebrew (Google Fonts), weights 400/500/600. The Hebrew UI must use the Hebrew family.
- **Numbers:** use tabular numerals everywhere (`font-variant-numeric: tabular-nums`) so scores, prices and km line up.
- **Type scale:** 13 / 15 / 17 / 22 / 28 px.
- **Case:** sentence case everywhere. No all-caps labels and no eyebrow labels above headings.

### Avoid

- identical rounded cards with soft grey shadows on everything
- gradients
- entrance animations
- arrow characters appended to button text

Use borders and spacing for structure; shadows only on things that float (menus, the mobile score bar).

## Form controls (the main complaint)

1. **Replace dropdowns with segmented controls** for every field with five or fewer options:
   - claims, service history, cabin fit, tires, original ownership
   - status
   - benchmark source
   - each deal-breaker (No / Unknown / Yes)

   Styling:
   - one row of connected buttons with a 44px tap target
   - selected = `--action` background, white text
   - Unknown is a real visible option, not an empty state

   If a row doesn't fit on mobile, it wraps into a 2-column grid. Never use horizontal scroll.

2. **Remaining selects** (sort, longer lists):
   - `appearance: none`, custom SVG chevron (mirrors in RTL)
   - 44px height, `--surface` background, 1px `--line` border, 8px radius
   - same font as everything else

3. **Text and number inputs:**
   - same height, radius and background as selects
   - ₪ and km as unit labels inside the field (logical-property padding so RTL works)
   - numbers formatted with thousands separators on blur

4. **Focus:** a 2px `--action` ring on every interactive element. Visible keyboard focus is required.

5. **Hover:** subtle hover state only. No transitions longer than 150ms.

## Screens

### Car list (home)

- **Header:** app name, language toggle, logout, and a primary "Add car" button.
- **Controls row:** sort (select) and status filter (segmented, or a select on mobile). Move Export/Import JSON into a small "⋯" menu in the header. They're rarely used.
- **Each car is a row** (not a card grid):
  - plate badge
  - make/model/year
  - asking price
  - km
  - **score range bar:** a 0–100 track with tick marks at 60 and 80. The min–max range is filled in the rating color of its best case, with the confirmed part (0–min) solid and min–max hatched or lighter.
  - rating badge (text, not just color)
  - coverage %
  - status
  - small red flag icon if there are deal-breakers or warnings

  On mobile, the row stacks into two lines.
- **Empty state:** one sentence and the "Add car" button, e.g. "No cars yet. Add one from a screenshot or by hand."

### Add / edit car

- **Top:** two equal options, "Upload screenshots" and "Enter manually". After extraction, highlighted fields work as they do now; restyle the highlight as a thin `--action` left border (inline-start) plus a small "From screenshot" tag.
- **Group fields by rubric category,** in this order:
  1. Car & plate
  2. History & maintenance
  3. Price
  4. Mileage
  5. Ownership
  6. Cabin fit
  7. Condition
  8. Deal-breakers

  Each group header shows that category's points range on the right, e.g. `18–25 / 25`.
- **Score panel:**
  - **Desktop:** sticky on the inline-end side.
  - **Mobile:** a fixed bottom bar showing the range, rating and coverage. Tap it to expand the full breakdown, the "what to find out next" list, and the seller message.
- **Warnings and deal-breakers** sit at the top of the score panel in `--bad`, written as direction: what was found, and what to do about it.

### Score panel content (keep it short)

1. **Verdict first.**
   - If coverage < 50% and no deal-breaker is confirmed, show "Too early to tell" instead of a rating badge, plus "X of Y points so far" (points scored ÷ points in fully known categories).
   - At ≥ 50% coverage, show the rating.
   - Only show AVOID if a deal-breaker is "Yes" or the max score is < 60.
   - The min–max range appears as small secondary text under the verdict.
   - The list view uses the same verdict logic.
2. **Summary.** A short "Good signs" / "Watch out" block, max 3 items each, one short line per item.
   - Generated by rules in a new `summary.js` from the car's data.
   - Examples: low km/year, 1st hand private, priced below benchmark, ex-rental/fleet, test expiring within 3 months, worn tires, price above benchmark, odometer warning, tight cabin.
   - Hide each half if it's empty. Add EN/HE strings to i18n.
3. **"Known issues for this model" button.**
   - Calls a new `/api/model-notes` endpoint with make/model/year.
   - Asks the LLM for max 3 short, common, well-documented issues for that generation, and shows them under Watch out.
   - Cache the result per car in D1 (new column via a migration file) so it's fetched only once.
4. **Less text.**
   - The 4 deal-breaker lines collapse into one line, "4 safety checks unknown" (the count updates). Tap to expand.
   - "What to find out next" becomes the top 3 missing items as small tags, with no "Missing:" sublines.
   - The score breakdown is collapsed by default.
   - The "Filled N fields from screenshots" note fades after 5 seconds.

### Login page

Centered, narrow:
- app name
- the plate badge motif as the logo (a plate reading "CAR-SCORE" or similar)
- one password field
- a "Log in" button

Wrong password shows "Wrong password. Try again." under the field.

## RTL

Everything must mirror correctly in Hebrew:
- use logical properties only (`margin-inline-start`, `inset-inline-end`, etc.)
- chevrons and the score panel side flip
- the score bar, numbers and plate badges do **not** flip: wrap them in `dir="ltr"` / `<bdi>`

## Process

1. Before coding, write the token CSS and a short ASCII wireframe of the list row and the edit screen. Check them against this spec.
2. Build.
3. Use Puppeteer to screenshot the list, the edit screen and the login page at 390px and 1280px wide, in both English and Hebrew. Review the screenshots yourself and fix anything misaligned, cramped, or still browser-default looking.
4. Run the scoring tests to confirm nothing broke, then commit and push.
