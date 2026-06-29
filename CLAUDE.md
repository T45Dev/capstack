# CapStack — Working Notes for Claude

This file is auto-loaded into every Claude Code session. It captures the mental model,
recent architectural decisions, and current state so a new session can pick up without
re-litigating settled questions.

## What this app is

Multi-company cap-table + scenario modeller. End deliverable: a board-approval Excel
export for option grants. The operator imports a Carta export, builds a chronological
record of financings, attributes convertible notes to rounds, models dilution, and
exports.

- Stack: Nuxt 4 + Vue 3 (composition API) + Nitro + better-sqlite3.
- Local SQLite at `data/capstack.db`. Idempotent column migrations via `ensureColumn` in `server/utils/db.ts`.
- Dev server: `npm run dev` on `:3100`. The operator typically runs it on `10.10.1.236:3100` (their LAN, NOT reachable from the remote env where Claude works — don't pretend Claude's localhost is theirs; trust main after merge and ask for browser-console + server logs when investigating bugs).

## Mental model — what the data means

Two levers the operator owns:

1. **Rounds** (the `rounds` table) — funding events. User-driven; the operator types every value via the Summary card on the Financings page. Carta import does NOT seed rounds anymore. Each round has:
   - `code` (R1, R2, ...; auto-generated on add) and `name` (friendly label)
   - `kind`: 'formation' | 'closed' | 'open' — the Open round is whichever row has `kind='open'`. Single-open invariant enforced in the UI: toggling one Open auto-drafts every other open round back to Closed.
   - `close_date`, `new_money`, `pre_money`
   - `share_price` is now an OVERRIDE, not a primary input. When NULL the endpoint DERIVES the per-share price the board-workbook way: `PPS = pre-money / pre-round FDS` (the prior round's cumulative Total FDS). A typed `share_price` overrides the derivation (debt/bridge rounds). round-summary returns the EFFECTIVE price as `share_price` (canon) plus `share_price_override` / `share_price_derived` so the UI can show which is in effect.
   - `preferred_issued_override` (nullable): when NULL the endpoint derives `preferred_issued = new_money / effective PPS`; set a value (incl. 0) to override for debt-only or bridge rounds. **Derived share counts are NOT floored** — the workbook carries fractional shares through the build-up and only rounds for display, so flooring per round drifted us off the operator's sheet (see decision #12).
   - `common`, `option_pool_issued` — still user-typed.

2. **Convertible Notes** (the `convertibles` table) — each note attributes to a round via `destination_class_code` (legacy column name; under the new model it holds the round's `code`).
   - Carta import populates: principal, interest_rate, interest_accrued, issue_date, conversion_date, valuation_cap, conversion_discount, conversion_price.
   - Effective conv price = `min(SharePrice × (1 − discount), cap / pre-money FDS)`. SharePrice basis = stored `conversion_price` ?? attributed round's `share_price`. Editing Share price on a CN flows into Effective price and Resulting shares.
   - Interest accrues from `issue_date` through `conversion_date` and stops there. No today-fallback. If conversion_date is missing → stored interest_accrued is used as-is.
   - Each CN has an `include_in_summary` boolean (default true) — when off, the round-summary endpoint skips it. UI toggle is the leftmost checkbox column.

## Data flow: CN → Cap Table

```
edit on CN page → PATCH /api/convertibles/:id
                ↘ refresh /api/companies/:id/convertibles  (CN ledger view)
                ↘ refresh /api/companies/:id/round-summary (Summary card)
                                                   ↓
                                  Notes financing = Σ (principal + interest)
                                  Notes converted = Σ (total / effective_price)
                                  cumulativeFDS  += Notes converted
```

The `round-summary` endpoint must mirror the `convertibles.get` endpoint's per-CN math
exactly. If they diverge, the Cap Table's "Notes converted" row stops matching the CN
page's "Resulting shares" column. Sort order matters: open rounds last, otherwise by
close_date ascending; pre-money FDS for round X = cumulative FDS through round X-1.

## What the Carta importer does (and doesn't)

Imports: stakeholders, holdings, option grants, convertible notes (full ledger), option pool size, share-class metadata.

Does NOT import: funding rounds. The Carta share-class ledgers (SA1/SA2/SA3/PB1/PB2) don't map cleanly to how operators think about funding rounds, so rounds are user-driven now. The operator adds rounds manually on the Financings page.

A re-import wipes and reseeds CNs / stakeholders / holdings / grants. It leaves rounds untouched.

## Pages

Current nav (top → bottom):

- **Financings** (`/companies/:id/cap-table`) — Summary card + CN ledger on one page.
- **Assumptions**
- **Option Grants**
- **Overall Dilution**
- **Option Pool Impact**
- **Exit Scenarios**

Removed: standalone Convertible Notes page (now under Financings), Securities rollup card, Holdings pivot card. The embeddable CN-ledger component (`CnLedger.vue`) and the legacy `FinancingsMatrix.vue` / `FinancingsModel.vue` were deleted once they went unmounted — the current model uses the side-by-side Previous/Open round cards plus the InvestorMatrix instead.

## UI patterns worth knowing

- **Draft / Save commit pattern** on the Summary card: edits write to a local `drafts` buffer; user clicks "Save" to flush to the server. Cancel discards. Add/Delete round still PATCH immediately so the row set stays consistent. Close-date re-sort only triggers on save (rows don't jump around mid-edit).
- **Amber input chrome** = user-typed field. Muted italic = derived/formula. Helps the operator tell what they own vs what's computed.
- **`UiEditableTable`** is the shared editable-table component used by the CN ledger. Supports per-cell types (`text`, `number`, `usd`, `pct`, `date`, `select`), cell slots for custom display, and `sticky-first` to pin the first column.
- **Resizable columns are standard — every data table has them, via shared pieces, never hand-rolled.** The mechanism is `useSortableTable` (composable: `cols` with reactive `width`, `startResize`, localStorage-persisted widths) + a `<colgroup>` bound to those widths so dragging actually moves the column. Don't re-implement the colgroup/handle markup inline — use the two re-callable components: **`SortTh`** (sortable + resizable header cell; the drag handle auto-appears when the table exposes `startResize`) and **`TableColgroup`** (`:cols` + optional `:leading`/`:trailing` fixed-width arrays for non-sortable edge columns like a checkbox or actions column). For a non-sortable table (config/matrix/timeline) spin up a width-only `useSortableTable` (columns `sortable:false`) purely for widths and drop a `resize-handle` span in each header. `SortableTable.vue`/`UiEditableTable.vue` already bundle all of this. Marketing/ephemeral-preview tables (pricing, import previews) are intentionally left non-resizable.
- **Date inputs** — Chrome has a 2-digit-year gotcha (09/09/26 → year 26). All date saves go through `normalizeDate` in `app/utils/format.ts`.

## Recent decisions (so we don't re-relitigate)

1. **Rounds are user-driven**, not derived from share classes. Carta no longer seeds rounds.
2. **CNs attribute to rounds**, not to share classes. The destination dropdown lists rounds. Carta-imported CNs with stale share-class codes show an amber "re-attribute" badge.
3. **Single source of truth for "which round is open"** is `rounds.kind = 'open'`. Was previously split between `assumptions.round_name` and a synthesized open-column. Gone now — every round is a real DB row.
4. **Preferred issued is derived** from `new_money / share_price` by default, with a per-round override (`preferred_issued_override`).
5. **Notes converted rolls into FDS.** It was treated as "informational only" before; that was a bug from the legacy model.
6. **Effective conv price uses SharePrice as basis**, not just the round PPS. So editing a CN's Share price flows into Effective and Shares.
7. **Interest accrues through conversion_date**, no today-fallback.
8. **"Invested $" cost basis = priced rounds only.** Formation (founder common-stock) contributions are excluded from the Dilution Invested-$ sum, and the Preferred Investor matrix drops the formation column plus any founder who only contributed there. Cost basis reflects preferred/priced money in.
9. **Notes Converted is operator-overridable on the Open Round card.** The `notes_converted_override` column (already in the schema) is surfaced as a typed field: a value replaces the CN-attribution-derived count and rolls into Total FDS; blank reverts to auto-derive. Editing a CN's destination still clears the override so the engine re-derives.
10. **Overall Dilution uses TWO denominators so dilution is visible, and they MIRROR the Financings cards.** `preFDS` = the Previous-Round aggregate's Total FDS (PreviousRoundCard / `aggregate-round`); `postFDS` = that base + the open round's OWN new shares (`new_money/share_price`) + option pool issued + notes converted. Both pages compute this through the shared `openRoundPostFds` helper in `app/utils/capTable.ts` (locked by `capTable.test.ts`) so they can't drift. pre% = shares/preFDS, post% = shares/postFDS. A holder whose share count doesn't change is still diluted because the denominator grows — **same numerator, bigger denominator** → pre% > post%. Do NOT denominate against round-summary's cumulative `total_shares_fds`: it accumulates the rounds table from 0, so adding the aggregate base on top double-counts all prior history (this was a real bug — the dilution page read wildly higher than the round cards). (We also briefly tried a single post-FDS basis for both columns; that zeroed Δ for non-participants and hid their dilution — rejected.) Proposed/idea grants augment only the POST numerator, never the denominator.
11. **"Variable tables" — single source of truth for any cross-page figure; never hardcode/re-derive.** Canonical cap-table math lives in `shared/capTableModel.ts` (pure, framework-agnostic): `openRoundPostFds`/`newSharesIssued` (FDS), `authorizedPool`/`availablePool` (option pool). Both sides reference it — client via the `~/utils/capTable` re-export, server via `~~/shared/capTableModel` — and it's locked by `app/utils/capTable.test.ts`. This exists because the SAME number was being computed three different ways and drifting: the option pool read 0 on the Grants page (it ignored the Round-history timeline), and Grant Fairness's pre/post/% denominators used round-summary's cumulative `total_shares_fds` instead of the canonical aggregate+post helper. **Rule: the moment a derived figure (FDS, pool, PPS, ownership %) is needed by more than one page or endpoint, add a function to the shared module and reference it — do not re-derive it inline.** The `shared/` dir is reachable from both app and server; vitest imports it by relative path (no `~~` alias in the test env). The same rule applies to a derived figure's *presentation*: the Option-Pool identity (Authorized − Issued(Outstanding+Exercised+Forfeited/Expired) + Forfeited/Expired = Available − Proposed [− Ideas] = Future Available) had drifted between the Pool Impact and Option Grants pages, so its **arithmetic** is now `poolEquation()` in `shared/capTableModel.ts` (locked by `capTable.test.ts`) and its **rendering** is the single `OptionPoolEquation.vue` component (aligned chips, per-term Issued / Proposed+Ideas collapses, `show-ideas` + `storage-prefix` props). Both pages feed it figures via `poolEquation`; don't hand-roll the equation markup again.
12. **Share price is DERIVED, matching the board cap-table workbook.** The operator's source-of-truth Excel treats price as an OUTPUT: `PPS = pre-money ÷ pre-round FDS`, and the preferred-share count flows from it (`preferred = new_money ÷ PPS`). The app used to invert this (type the price, derive preferred). The Rounds page now derives PPS this way by default — `derivedSharePrice()` in `shared/capTableModel.ts` — with a typed `share_price` kept as an explicit OVERRIDE for debt/bridge rounds. **`newSharesIssued()` no longer floors**: the workbook keeps fractional shares through the whole build-up (only the eye-level display rounds, via `fmtShares`), so flooring per round accumulated a share-level drift away from the sheet. `derivedSharePrice` is locked by `capTable.test.ts`. We intentionally do NOT replicate two workbook quirks: it derives Seed PPS from post-money (we always use pre-money ÷ prior-FDS), and it shows an *implied* post-money (PPS × post-FDS) for priced rounds (we keep the term-sheet pre+new, since that's what the Rounds card's editable pre→post equation renders and what the next round's pre-money derives from). **Exercised options do NOT reduce Total FDS** — an exercised option is still a fully-diluted share (it has merely converted from an option to common). **They are netted out of Authorized instead**: an exercised option has left the pool for common, so the live reserve shrinks by it. `poolEquation()` returns `authorizedGross` (raw reserve) and `authorized = max(0, authorizedGross − exercised)`, and `available = authorized − outstanding` (`availablePool()` takes the NET authorized and subtracts only outstanding). The displayed Authorized is therefore the live reserve; exercised is shown as an informational "→ common (FDS)" figure, NOT a pool allocation line. (Earlier we modelled it as `Available = Authorized − Outstanding − Exercised`, which double-charged the pool — both reserving the shares and counting them spent; same Available number, wrong attribution. Reverted.) `round-summary` keeps `available_options = Authorized − Exercised − Outstanding`, and never subtracts exercised from cumulative FDS. (We also briefly netted it out of FDS as a "clever" Carta-matching trick — that was wrong and is reverted.) Note: `board-approval.xlsx`'s section-3 lifecycle audit still reports GROSS authorized, where listing exercised explicitly is correct. We KEEP one behavior that diverges from the sheet: CN conversion still applies the valuation-cap branch `min(discount, cap/preFDS)` (this particular workbook's notes are discount-only).
13. **Canon FDS comes from the Rounds page — board exports READ it, never recompute.** There used to be THREE independent FDS computations: round-summary (the Rounds table), board-approval.xlsx (via `computeRound()` reading the separate `assumptions` row), and board-slide (its own `base + new + pool + notes`). They drifted — the board slide showed a different FDS than the Rounds page. Now `round-summary.get.ts` is the single source: it returns each round's cumulative `total_shares_fds`, and **both** `board-approval.get.ts` and `board-slide.get.ts` fetch round-summary and take `postFDS = current round's total_shares_fds`, `preFDS = prior round's total_shares_fds` (current round = open if flagged, else latest non-formation; holdings/assumptions fallback only when no rounds exist). The `computeRound`/`assumptions` FDS path in board-approval is retired. **This is not just FDS** — board-approval was reading several data points from stale sources, so the export didn't move when the operator edited rounds: its **round name** (header + "% FD Post-<round>" column) came from `assumptions.round_name`, its **authorized pool** from the raw `option_pools` lump, and its **option grants** (committed + proposed) from a direct `SELECT * FROM grants` that skipped the `/grants` endpoint's lazy past-window expiry + lifecycle reconciliation (so the export showed grants as outstanding that the Grants page had expired — stale grant data). All now come from canon — round name from the current/open round in round-summary, pool from the shared `authorizedPool()` helper (timeline + open-round issued), and grants/pool from the `/api/companies/:id/grants` endpoint (the SAME source the Option Grants page reads) — exactly like the board slide / Grants / Pool Impact pages. **Rule: every data point in an export has ONE source and it's canon (round-summary + the shared helpers); the `assumptions` row and the option_pools lump are fallbacks ONLY for a company with no rounds yet — never the live path.** `ceo-report.get.ts` already followed this. (Known follow-up: `investor-matrix.get.ts` still reads the raw `rounds.share_price`/`preferred_issued` columns rather than round-summary's effective values — fine while prices are typed overrides, but it should migrate to round-summary to stay canon when prices are derived.)

## Endpoints

```
GET  /api/companies                                  — list (cards on home)
POST /api/companies                                  — create
DELETE /api/companies/:id

POST /api/companies/:id/rounds                       — add round (auto-generates code)
PATCH /api/rounds/:id                                — update round (whitelist of fields)
DELETE /api/rounds/:id

GET  /api/companies/:id/round-summary                — Summary card data (rounds + CN aggregates)
GET  /api/companies/:id/convertibles                 — CN ledger (per-note math resolved)
POST /api/companies/:id/convertibles                 — add CN
PATCH /api/convertibles/:id
DELETE /api/convertibles/:id

POST /api/companies/:id/import                       — Carta xlsx
POST /api/companies/:id/compute                      — open-round dilution math
```

## Pending / parked

- **Two unmerged commits** on `claude/capstack-cap-table-0yFFz` waiting for human merge (the GitHub MCP was turned down mid-session so Claude couldn't open PRs from the prior session):
  - `972408a` — Preferred issued override (formula + manual override fallback)
  - `9bd5509` — Financings restructure (drop Securities/Holdings, embed CN ledger)
- Live-recalc while in edit mode on the CN table (currently you have to save to see derived cells update). Discussed, not built.
- Dead code in `app/pages/companies/[id]/cap-table.vue` (script section): `pivot`, `totals`, `summaryRows`, `holdingsTable`, etc. — used by the removed Securities/Holdings cards. Can be cleaned up but not breaking.

## Workflow conventions

- Commit messages: short title + 2-3 paragraph body explaining the why. No "Co-authored-by" or watermark trailers in this repo's style.
- The user runs `npm run dev` themselves on their LAN. Don't expect to hit their server from this env.
- Type errors that existed BEFORE the current change are NOT in scope to fix unless asked — there's a pile of pre-existing TS issues in cap-table.vue's Holdings section (now dead) and a few `useFetch` overload mismatches in layouts/default.vue.
- The GitHub MCP server is available again. The standing workflow: push the feature branch, open a PR against `main`, and merge it (merge commit, matching this repo's history). No need to leave PRs waiting for a human to merge.
- On every PR you open, subscribe to its activity (`subscribe_pr_activity`) so review comments / CI failures wake the session. CI here is a single workflow — "Build and publish image" — that runs on **push to `main`** (post-merge), not as a PR check. So after merging, verify that workflow's latest `main` run and report its status (success/failure) back to the user.
