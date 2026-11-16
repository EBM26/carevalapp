# Car Scorer: quick check + tailored seller message

Most ads only show price, km, year, model and ownership. Add a quick first stage that answers "is this worth messaging the seller?" from just that. Then write a tailored message to send the seller.

The full 100-point score stays as it is. It becomes stage 3, used after the seller replies.

Keep the existing stack, design tokens and i18n. Don't change the full scoring math.

## Stages

1. **Quick check:** from the ad alone. Verdict: **Pursue / Maybe / Skip**.
2. **Seller message:** for Pursue and Maybe cars.
3. **Full score:** the existing score panel. It becomes the main view once coverage reaches 50%.

Below 50% coverage, the edit screen and the list both show the quick-check verdict as the headline. At 50%+ they show the full-score verdict, with the quick check available in a collapsed section.

## Settings

Add a small settings screen in the header "⋯" menu with a **budget ceiling (₪)**. Store it in D1 (new `settings` table, via a migration file).

## Quick-check rules (`quickcheck.js`, pure functions)

### Skip reasons (any one = Skip)

- asking price above the budget ceiling
- original ownership is rental or driving school
- 3+ hands on a car under 5 years old
- km/year over 28,000, or total km over 130,000
- cabin fit is tight
- any deal-breaker confirmed "Yes"

### Maybe reasons

- fleet lease, or 2nd hand ex-lease
- km/year 22,001–28,000
- price more than 5% above the price comparison (see below)
- cabin fit adequate
- no price comparison available

### Good signs (shown, don't change the verdict)

- 1st hand private
- km/year under 15,000
- price 5%+ below the comparison
- cabin fit easy

### Verdict

| Condition | Verdict |
|---|---|
| Any Skip reason, or 3+ Maybe reasons | Skip |
| 1–2 Maybe reasons | Maybe |
| None | Pursue |

Unknown fields never count against the car, except that unknown ownership adds a note: "Ask about ownership."

### Display

One line, e.g. "Pursue: low km, 1st hand private, cheaper than your other Corollas". Show at most 3 reasons, Skip reasons first, then Maybe, then good signs.

## Price comparison

Use the first source that's available:

1. **Your saved cars.** Other saved cars with the same make and model and year ±1, with an asking price. Needs at least 3 comparables.
   - Compare against the median, adjusted for km: subtract or add ₪0.15 per km difference from the comparables' median km. Keep the adjustment simple and put it in one constant.
   - Show it as e.g. "₪4,000 below the median of 5 similar cars you've saved."
2. **AI estimate.** If there are fewer than 3 comparables, call a new `/api/price-estimate` with make, model, trim, year, km and ownership type.
   - Ask the LLM for a typical Israeli private-sale price range, returned as JSON: `{low, high}`.
   - Use the midpoint as the comparison.
   - Label it clearly as "Rough AI estimate" in the UI, and show the comparison text in muted style.
   - Cache it per car in D1 (new column via the same migration).
   - Re-fetch only if make, model, year or km changes.
3. **Neither available:** no price comparison; it counts as a Maybe reason.

Show which source was used. If the Levi Yitzhak price is entered for full scoring, it overrides both sources.

## Seller message (`/api/seller-message`)

Replace the current template generator. Send the car's known fields, the missing fields, and the quick-check reasons to the LLM, and have it write a short WhatsApp message.

- **Language:** natural, friendly Hebrew by default (EN option kept). Sounds like a person, not a form.
- **Length:** greeting plus at most 6 questions.
- **Always ask** for the plate number first, if missing.
- **Then ask** for whatever is missing among: Slikah report, service history, test expiry, original ownership, trim.
- **Add 1–2 questions specific to this car,** for example:
  - high km/year → major services or gearbox service
  - hybrid → hybrid battery warranty / service at the dealer
  - 2nd+ hand → why it's being sold
  - ex-lease → service records from the leasing company
- **Never state facts** the app doesn't have, and never mention scores or the app.

UI:
- A text box with the message, editable before sending.
- "Copy" button, plus a `wa.me` link if a seller phone number is entered.
- A "Rewrite" button to regenerate.
- If the API fails, fall back to the old template generator.

## List view

Each row shows the current verdict:
- the quick-check verdict, if coverage < 50%
- otherwise the full-score verdict

A small label shows which one it is. Add "Quick check" to the sort options (Pursue first, then Maybe, then Skip).

## Tests

Add to `tests.html`:
- each Skip and Maybe rule, and the boundaries (28,000 km/yr, 130,000 km, 3+ hands at age 4.9 vs 5.1, the 5% price threshold)
- the verdict counting
- unknown fields not counting against the car
- comparables selection (year ±1, minimum 3) and the median/km adjustment

## Process

1. Write the migration file for the new `settings` table and the price-estimate cache column. You may apply it to the remote D1 with `wrangler d1 execute --remote --file=...`. Don't run any other commands that touch my Cloudflare account.
2. Build.
3. Screenshot the list and the edit screen at 390px and 1280px, in English and Hebrew, and fix any problems.
4. Run all tests, then commit and push.
