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
   - `close_date`, `share_price`, `new_money`, `pre_money`
   - `preferred_issued_override` (nullable): when NULL the endpoint derives `preferred_issued = new_money / share_price`; set a value (incl. 0) to override for debt-only or bridge rounds.
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

GET  /api/companies/:id/master-template              — blank master import workbook (.xlsx)
POST /api/companies/:id/carta-to-template            — parse a Carta export → PREFILLED master workbook (.xlsx); no DB writes
POST /api/companies/:id/master-import                — import a filled master workbook (relational by stakeholder Name)
POST /api/companies/:id/import                       — legacy direct Carta→DB (still works; no longer surfaced in the UI)
POST /api/companies/:id/compute                      — open-round dilution math
```

### Import model (current)

ONE relational workbook is the primary path. `server/utils/masterTemplate.ts` = the
shared tab spec; `server/utils/masterWorkbook.ts` = the ExcelJS builder (Instructions
sheet + dropdowns + optional prefill rows), used by BOTH the blank-template download and
the Carta prefill. Carta is now a *bootstrap*: upload an export → get a prefilled
template → fill the gaps → import via `master-import`. The old one-click Carta-to-DB
importer (`import.post.ts` / `import-preview.post.ts`) is retired from the UI but left
intact.

Tabs: Stakeholders (hub) · Holdings · Option grants · Convertibles · Round history.
The **Option grants** tab carries a `Status` column — `Issued` → `grants` (outstanding),
`Proposed` → `grants` (status='proposed', approval='Pending'), `Idea` → `pool_events`.
This folded the old separate "Ideas" tab in (one tab, three statuses). It also carries the
per-grant lifecycle columns (quantity_issued / exercised / forfeited / expired + their dates
+ acceleration) so the **Option Pool Impact** timeline gets its exercise/forfeit/expire events;
Carta prefills them.

Option pool: the grants page reads the authorized pool from `option_pools.authorized` (fallback
after `rounds.option_pool_issued`). Master-import has no `rounds`, so it rolls the Round-history
"Option pool increase" column into one `option_pools` row (upsert by name 'Stock Option Plan').
The Carta prefill seeds Carta's `poolAuthorized` onto the latest Round-history row (or a synthetic
row) so that number flows through. The Financings/Pool pages still read the pool from the
milestone timeline — same total, different read, no double-count.

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
