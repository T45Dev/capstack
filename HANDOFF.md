# CapStack — Session Handoff

Last touched: follow-up session on `claude/beautiful-archimedes-X3Lwq`.
Cleared all five open threads from the prior handoff and added a manual
Notes Converted field. All tests green, all changes pushed.

- **Branch**: `claude/beautiful-archimedes-X3Lwq` (HEAD)
- **Tests**: `npm test` — 33 passing locally; the carta.reconcile suite skips without the private fixtures in `fixtures/private/` (46/46 with them)
- **Dev**: `npm run dev` (port 3100)

---

## What this branch ships (v1.0 candidate)

Reworked the cap-table flow from a per-round matrix into a smaller
manually-driven model, with Carta seeding everything that can be
seeded automatically.

### Pages

- **/cap-table** — renamed to **Rounds** in the UI (route kept).
  Two cards side-by-side:
  - **Previous Round** (`aggregate_round` table, one row per company):
    typed aggregate covering everything before the open round —
    Pre-money, New-money, Share price, Cumulative financing, Total FDS,
    Total option pool.
  - **Open Round** (`rounds` table, `kind='open'`): the modeled round.
    Fields buffer locally; **Save** button (or ⌘S) batches PATCH.
    Falls back to the latest non-formation round so a "closed" round
    still renders its pre/post model.
  - Sub-tab: **Preferred investors** — `InvestorMatrix.vue`. Shares
    per round per investor (shares-primary, no $). CN column tracks
    each investor's outstanding note principal + accrued. CN-only
    investors (no equity yet) appear too. Δ row reconciles allocated
    shares vs `rounds.preferred_issued`.

- **/shareholders** — NEW page. One column per share-class ledger
  (CS → SS → SA1 → SA2 → …), then Options, then Total. Aliases nested
  under their primary, expandable. Per-row **Link…** button opens a
  searchable stakeholder picker. Common ledgers tinted neutral,
  preferred tinted brand.

- **/dilution** — Pre FDS reads from `aggregate_round.total_shares_fds`,
  Post FDS = aggregate + current round's cumulative. Toggles:
  - **Include preferred holders** (linked rows with options anywhere
    stay visible regardless — per the operator rule).
  - **Include proposed + ideas in post** (unchanged).
  - **Import preferred holders** button → paste-style importer that
    writes into a synthetic `PREV-PREF` share class.
  - New **Invested $** column (cost basis from `round_investors`,
    cluster-summed for linked rows; tooltip shows weighted-average
    entry price).
  - Each row with linked aliases shows a `+N linked` chip; tooltip
    lists the alias names.

### Data model

Schema changes are idempotent (via `ensureColumn` and
`CREATE TABLE IF NOT EXISTS`).

- New tables:
  - `aggregate_round` — one row per company, typed previous-round
    summary. Drives the Previous Round card + dilution Pre FDS.
  - `rounds_archive` — same shape as `rounds`. A one-time migration on
    first boot of this branch moves any existing `rounds` rows here
    before clearing the live table (so the new model starts clean
    without losing data).
- New columns:
  - `stakeholders.linked_to` (self-reference) — alias → primary.
    Resolved with a capped 5-hop walk; cycle-guarded on write.
- Synthetic share class `PREV-PREF` (kind='preferred') is created on
  demand by the **Import preferred holders** modal; survives Carta
  re-import (only Carta-derived classes are wiped on replace).

### Carta import behaviour

Previously narrow (stakeholders + grants + pool). Now seeds the full
historical record:

- `share_classes` — from Detailed Cap Table when it parses, **and**
  synthesized from each ledger sheet otherwise so the Shareholders
  page never shows empty class columns.
- `holdings` — from Detailed Cap Table when parseable; **synthesized
  from `round_investors`** otherwise (each cash contribution becomes
  a holding via `shares = amount / share_price`). `INSERT OR IGNORE`
  so explicit DCT counts win over derived ones.
- `rounds` (kind=formation or closed) — one per ledger sheet,
  seniority stamped chronologically by `close_date` so the
  Shareholders page columns lay out CS → SS → SA1 → … in cap-stack
  order.
- `round_investors` — per-row stakeholder × cash from each ledger.
  Auto-creates stakeholders the Detailed Cap Table didn't name.
- `convertibles` — finally being inserted (was parsed but dropped
  silently before).
- Re-import wipes Carta-derived rounds, share_classes, holdings,
  round_investors, and convertibles. Open rounds, the synthetic
  PREV-PREF share class, and manually-entered stakeholders are
  preserved.

Parser improvements: Detailed Cap Table parse failure no longer
short-circuits the rest of the parser; bare "Name" headers are
recognised on the plan sheet; exercise-date cross-reference walks
multi-cert destinations (comma/semicolon/slash/"and") and takes the
earliest match from each ledger's certificate Issue Date.

### Linking semantics

`stakeholders.linked_to → another stakeholder's id (same company)`.
NULL = standalone. Aliases roll up into their primary across:

- Shareholders page (per-class totals + nested aliases)
- Dilution (`compute.post`): one row per primary, aliases summed,
  `aliasNames` + `hasOptions` surfaced for UI

If A is already a primary (has aliases pointing at it) and the
operator links A → B, A's aliases get reparented to B so the chain
stays flat. Cycle-guarded.

### Font

`.num` and editable cells switched from IBM Plex Mono to **Manrope**
with `font-variant-numeric: tabular-nums`. Same column alignment in
tables; vastly clearer 8 vs 0. IBM Plex Mono webfont dropped from
the page load.

---

## Resolved this session

All five prior threads were picked up and shipped on
`claude/beautiful-archimedes-X3Lwq`:

1. **DCT header detection — DONE.** Detection now accepts
   Stakeholder/Holder as the holder signal and structural columns
   (Stakeholder ID / Outstanding / Fully Diluted) as the data signal;
   the name-column resolver gained anchored Stakeholder/Holder
   fallbacks. New self-contained regression test
   `carta.detailed-cap-table.test.ts` (builds the workbook in memory, so
   it runs in CI unlike the private-fixture reconciliation suite).

2. **Share-price dead-end UX — DONE.** Each round column header in the
   Investor matrix now has an inline `$/share` setter that PATCHes the
   round; cells flip from `$` to shares on save. The cell hint points up
   at it.

3. **Dilution `Invested $` — DONE (operator chose "priced rounds
   only").** Formation contributions are excluded from the sum
   (`compute.post.ts`), and the Preferred Investor matrix drops the
   formation column and any founder-only row (`investor-matrix.get.ts`).

4. **Strict-null TS noise — DONE.** The TS2532/TS18048/TS2454 family is
   cleared (20 → 0) across server + UI; each fix is behavior-preserving
   (the `calc.ts` one also removed a latent empty-array crash).

5. **Unmounted components — DONE.** `CnLedger.vue`,
   `FinancingsMatrix.vue`, `FinancingsModel.vue` deleted; the two stale
   doc/comment references updated.

### Also shipped

- **Manual Notes Converted field** on the Open Round card. Surfaces
  `notes_converted_override`: a typed value overrides the CN-derived
  count and rolls into Total FDS (the card's local FDS preview now
  includes it); blank = auto-derive (placeholder shows the derived
  count); a "revert to auto" link clears it.

## Still open / parked

1. **Broader TypeScript tightening.** ~110 non-strict-null diagnostics
   remain — mostly `useFetch`/`$fetch` results typed as `{}` (TS2339),
   plus UiEditableTable / sortable-column generics and the
   `layouts/default.vue` useFetch overloads. A real fetch-typing pass,
   not started. (`npx vue-tsc --noEmit -p tsconfig.json` to see them;
   note vue-tsc + typescript aren't in devDependencies.)

2. **Live-recalc on the CN table edit mode** (carried from CLAUDE.md) —
   discussed, not built.

---

## How to verify / pick up

Quick smoke against a fresh company:

```bash
# Start the dev server (port 3100)
npm run dev &

# Create a company, import the Carta-like fixture
CID=$(curl -sf -X POST http://localhost:3100/api/companies \
  -H "Content-Type: application/json" -d '{"name":"Smoke"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
curl -sf -X POST "http://localhost:3100/api/companies/$CID/import" \
  -F "file=@/path/to/your-carta.xlsx" -F "replace=true"

# Inspect:
curl -sf "http://localhost:3100/api/companies/$CID/shareholders"     | python3 -m json.tool
curl -sf "http://localhost:3100/api/companies/$CID/investor-matrix"  | python3 -m json.tool
curl -sf -X POST "http://localhost:3100/api/companies/$CID/compute" \
  -H "Content-Type: application/json" -d '{}' | python3 -m json.tool
```

A working fixture builder lives at `/tmp/demo-carta.xlsx` only when
the session is alive; rebuild as needed with the script embedded in
the commit history (`b7fd957` test runs).

---

## Commit log (most recent first)

```
c0a3393 Investor matrix: drop $ subtext from share cells + totals
e32fed9 Preferred Investor matrix: shares-first, dollars as secondary
7038e61 Shareholders page: one column per ledger (CS, SS, SA1...) + Total
c65fdc4 Synthesize share_classes + holdings from ledgers; CN column
b7fd957 Carta import seeds rounds + round_investors; option-holders filtered
4d5afd8 Dilution: add Invested $ cost-basis column per stakeholder
910d5c1 Add Shareholders page with stakeholder linking; dilution honors links
87aa0ed Rename Financings → Rounds; side-by-side cards; left-justify
ae8f653 Fix Save failing on partial input + drop pool tile
f46e9cb Add Save button to Previous + Open Round cards
cf32301 Replace monospace number font with proportional tabular Manrope
4039888 Dilution: pre FDS from Previous-Round aggregate, post from current round
d7b72bc Fix open-round date save; keep pre/post model when round is closed
ae8be01 Import preferred shareholders from Dilution page
fc97674 Collapse Financings to Previous-aggregate + Open Round
```
