# CapStack — Session Handoff

Last touched: this branch is at the v1-candidate state. All tests green
(46/46), all changes pushed.

- **Branch**: `claude/nice-gauss-RxC0G`
- **Tip**: `c0a3393`
- **Tests**: `npm test` — 46/46 passing
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

## Open threads

Things flagged or partially addressed that a follow-up session may
want to pick up:

1. **Detailed Cap Table header detection.** The regex requires
   `name + (common|preferred|series)` in one row. Real Carta exports
   match this, but stripped-down test fixtures don't. Symptom: holdings
   come through synthesised from `round_investors` (still correct
   totals), but DCT's richer per-class detail isn't applied. Loosening
   the regex is straightforward — worth doing when someone hits it.

2. **Round_investors editing on rounds with no `share_price`.** The
   matrix is shares-primary; when a round's share_price is unset, the
   cell falls back to `$`-editing and shows a "set $/share to show
   shares" hint. Works, but feels like a dead-end UX — could add a
   one-click "set share price" affordance on that cell.

3. **The dilution `Invested $` column.** Cost basis from
   `round_investors`. Shows "—" for founders + option-only holders
   (they're not in `round_investors`). If the operator wants founders'
   formation cash to count there, parser would need to also seed
   `round_investors` rows for the CS Ledger (currently it does, but
   founders are then filtered OUT of the Preferred Investor matrix
   because they have no grants — that's the right behaviour for that
   matrix, but means their cost basis is dilution-visible while their
   investor status isn't). Worth confirming this is the intent before
   touching anything.

4. **Pre-existing strict-null TypeScript noise.** Several
   `Object is possibly 'undefined'` warnings in `InvestorMatrix.vue`,
   `investor-matrix.get.ts`, `import.post.ts`, `scenarios.vue`,
   `FinancingsModel.vue`, etc. They predate this session. Tests pass
   and runtime is fine; clean these up if a TS-tightening pass is on
   the cards.

5. **Unmounted but live code.** `CnLedger.vue`, `FinancingsMatrix.vue`,
   `FinancingsModel.vue` are still in the codebase. They're not
   rendered anywhere; left intact so they can be brought back if the
   model shifts. Safe to delete if cleanup is wanted.

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
