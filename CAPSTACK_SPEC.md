# Capstack — Master Spec

A web app for modeling proposed equity grants and exit outcomes against a closed funding round, in advance of the next round. The MVP exists; this document is the canonical reference for concepts, data model, page-by-page behavior, and design language as the app iterates.

---

## 1. Purpose

Capstack is used **after one funding round has closed and before the next one closes**. Example: Series B-1 is closed, Series B-2 is the round being modeled. The app answers two questions:

1. **Grant modeling** — If we issue these proposed option grants, what total equity will each person hold (combining existing common, preferred, CN-converted shares, and option grants)?
2. **Dilution & exit modeling** — How does the upcoming round dilute everyone, and what does each stakeholder receive at a low / mid / high exit?

Inputs are (a) a full-detail cap table exported from Carta and (b) the Assumptions page.

---

## 2. Core Concepts & Vocabulary

These terms are used consistently throughout the app. Treat this section as the glossary.

### Funding rounds
Seed, Series A-1, Series A-2, …, Series B-1, Series B-2, etc.

### Share classes
- **Common**
- **Preferred** (per round)
- **Options** (the option pool)

### Convertible notes (CNs)
Two states:
- **Converted (past tense)** — Already converted into shares. Interest stopped accruing on the conversion date. The note is assigned to the funding round it converted into.
- **Convertible (not yet converted)** — Still accruing interest until a future conversion date. **Must be assigned to a round** in the model, which determines whether the resulting shares are counted in the **pre** bucket or the **new** bucket for the round being modeled.

### Options (pool accounting)
Total FDS is a fixed deck of cards; events just move cards between piles. The three piles for option-pool capacity:

- **Outstanding** — Granted (vesting or vested-but-unexercised).
- **Available** — Pool capacity not currently allocated to an outstanding grant.
- (out of the pool) → **Common** — Exercised options leave the pool entirely and become Common stock.

Movements:
- **Forfeit** (grant lapses): `Outstanding → Available`. Pool size unchanged; Common unchanged; total FDS unchanged.
- **Exercise** (holder buys): `Outstanding → Common`. Pool size **decreases by N**, Common **increases by N**, total FDS unchanged. (This is the "moving cards between piles" rule — same deck, different pile.)
- **Top-up** (board authorizes): pool size **increases by N**, all of it landing in Available. Total FDS increases by N (newly authorized capacity).

Standing identity at any instant:

```
Available(T) = pool_size(T) − Outstanding(T)
```

where `pool_size(T)` is increased by every Top-up and decreased by every Exercise from inception through T. Forfeit is a movement event, not a separate state — once a grant is forfeited, those shares are back in Available.

### Pre / New / Post (the most important framing in the app)
Always relative to the round being modeled (the to-close round):
- **Pre-round / pre-money** — The state *as of* the last closed round.
- **New** — Only the activity from the to-close round itself.
- **Post-round / post-money** — `pre + new`.

### Round math (Assumptions identities)
The Assumptions card displays these as four rows. Rows 1–3 are working math; row 4 is a **read-only sanity-check** row that should always agree with row 2:

1. `Share price = Pre-money valuation ÷ Pre-round FDS`
2. `Post-money valuation = Pre-money valuation + New money + CN $ converting`
3. `Post-round FDS = Pre-round FDS + New FDS + CN shares converting`
4. `PPS × Post-round FDS = Valuation at Post-FDS`  *(sanity check; should match row 2)*

Derived field: `New FDS = New money ÷ Share price`.

"New money" is total financing coming in for the to-close round, **excluding** CN $ from notes that won't convert in this round.

**Pre-round FDS** has a default value computed from the imported cap table (holdings + outstanding options + available pool). The Assumptions card exposes it as an **override** field — typing a different number flags the row "(override)" and that value supersedes the cap-table default for round math; clicking *revert* restores the default.

---

## 3. Data Model (conceptual)

| Entity | Key fields |
|---|---|
| Company | name, logo/brand, list of rounds, current FMV |
| Round | label (Seed / A-1 / B-2 …), status (closed / open), pre-money valuation, new money, post-money valuation, share price (derived), close date |
| Stakeholder | name, type (founder / investor / employee / advisor / entity) |
| Holding | stakeholder, share class, round, quantity, price/share, date |
| Convertible Note | id (CN-1…), holder, destination round, conversion date, principal, interest, conversion price, resulting shares, status (converted / convertible) |
| Option Grant (outstanding) | recipient, type (ISO/NSO), shares, strike, vesting schedule, issue date, exercised/forfeited counts |
| Option Grant (proposed) | recipient, input mode (shares / % / $), input value, derived columns |
| Pool Event | date, event name (stakeholder), type (top-up / NSO / ISO / Exercise / Forfeit / Proposed / Idea), shares (±), running pool total |
| Idea | event name, type (grant / top-up / floor / reserve), shares, notes |
| Exit Scenario | sequential id, low value, mid value, high value, snapshot of inputs at save time |

---

## 4. Navigation & Layout

### Companies page (entry point)
- No left-side nav.
- Lists all companies being modeled. Full CRUD inline.
- Clicking a company → **warp-speed animation** → reveals the company workspace with left-side nav.

### Company workspace (left-side nav)
1. Cap Table
2. Assumptions
3. Convertible Notes
4. Option Grants *(renamed from "Grants")*
5. Overall Dilution
6. Option Pool Impact
7. Exit Scenarios

Content is **left-justified** and uses as much width as needed to show information densely.

---

## 5. Page-by-Page Spec

### 5.1 Cap Table
Re-creates the Carta **Detailed Cap Table** tab as HTML/CSS. Toggleable display: **Shares / % / $**.

**Top card** — recreates the Carta **Summary Cap Table** tab. *(This is the main update needed on the existing page.)*

---

### 5.2 Assumptions
The page where modeling begins. Lays out the round math identities from §2 as editable/derived fields:

- Pre-money valuation *(input)*
- Pre-round FDS *(override field; defaults from cap table — see §2 Round math)*
- New money *(input)*
- Share price *(derived)*
- New FDS *(derived)*
- Convertible-note shares feeding pre vs. new buckets *(from §5.3 below)*
- Post-money valuation *(derived)*
- Post-round FDS *(derived)*
- Post-round share price *(derived; row-4 sanity check, see §2)*

**Round selectors — top of the page.** Two dropdowns frame everything below:

- **Most Recently Closed Round** — the round whose post-close state defines the *pre* baseline. Persisted on the company.
- **Open Round** — the round being modeled (i.e. the to-close round). Persisted on the assumptions row.

These two selectors, together with each CN's **Destination** (set on §5.3), drive CN bucketing:

| CN destination | Bucket | Effect |
|---|---|---|
| = Open Round | **new** | Adds to *CN $ converting* and *CN shares converting* — affects the new-round math. |
| = any closed round | **pre** | Already represented in cap-table holdings at that round's issue price. Does **not** add to the *new* buckets. |
| (unassigned / deferred) | **deferred** | Excluded from post-round math; tracked as a hint with projected shares at round PPS. |

---

### 5.3 Convertible Notes
Recreates the Carta **Convertible Ledger**, slimmed to: **Holder, Destination, Conversion Date, Principal, Interest, Conversion Price, Resulting Shares**.

- Feeds CN values back into the Assumptions table.
- **Destination** determines whether resulting shares are counted as **pre** or **new** for the to-close round.
- **Conversion date** fixes interest accrual and therefore the share count.

---

### 5.4 Option Grants *(rename from "Grants")*
Recreates the Carta **[year] Stock Option and Incentive** tab. Two tables side by side.

**Left — Outstanding option grants** (already issued, not forfeited/exercised). Columns:
- Quantity (shares)
- Ownership %
- $ value (today)
- Strike price
- Vesting schedule
- Date issued
- **Pre / Post** columns for shares, %, and $ (since we're modeling an upcoming close)

**Right — Proposed grants** (seeking board approval). Free input by **one of**: shares, %, or $. The other two are derived from whichever was entered. Per recipient:
- Existing equity columns: outstanding options, common, preferred, CNs — plus sum total
- **Pre / New / Post** columns for each unit (shares, %, $)

**Export** — Generate a board-friendly Excel file. *(Template lives outside this spec; the export must match it.)*

---

### 5.5 Overall Dilution
Listing of every stakeholder and the dilution they experience from the to-close round.

For each of **Shares, %, $**: columns for **Pre, Post, Delta** (color-coded — red negative, green positive).

Layout rule: keep all Shares columns adjacent, all % columns adjacent, all $ columns adjacent (don't interleave units).

---

### 5.6 Option Pool Impact
Running timeline of option-pool activity from inception forward.

**Event types**
- Pool top-up
- NSO grant
- ISO grant
- Exercise
- Forfeit
- **Proposed** — pulled in from proposed option grants (§5.4)
- **Idea** — created on this page, used for "what-if" modeling. Idea sub-types:
  - Future grant (e.g. model hiring a CEO at N shares)
  - Top-up
  - **Floor** — minimum the pool can fall to (a buffer)
  - **Reserve** — hold-back for employee refresh, performance refresh, etc.

**Table columns**: Date *(from imported Carta file)*, Event *(stakeholder name)*, Type, Shares for the event, % FDS for the event, Running pool total.

**Visuals**
- Pie chart — total shares by category: Outstanding, Proposed, Ideas, Available
- Line graph — pool quantity over time. Toggle: **single events** vs. **vesting schedule**.

---

### 5.7 Exit Scenarios
Three exit-value scenarios (**Low / Mid / High**) modeled as if the to-close round has closed.

Per stakeholder:
- Post-round FDS
- Post-round %
- $ at Low / Mid / High

No display toggles needed on this page. **Saving a new scenario locks the previous one.** Scenarios are identified by sequential numbers with the L/M/H values shown as subdued text alongside.

Ideas from the Option Pool Impact page **do** flow into Exit Scenarios — labeled clearly so the user can see which payouts depend on hypothetical grants.

---

## 6. Global Design Language

- **Adding data** → inline "add row" wherever possible.
- **Editing** → click the row to edit in place.
- Every user-added row has a **delete** button.
- **Don't display unnecessary data** (e.g. don't show round math on Exit Scenarios).
- **Color semantics**: red = negative, green = positive.
- **Left-side nav**, content **left-justified**, width as wide as needed to maximize information density.
- All tables: **resizable columns** and **sortable headers** (click to sort).

---

## 7. Inputs & Imports

- **Carta full-detail cap-table export** — primary import, feeds: Cap Table page, Convertible Notes ledger, Outstanding option grants, Pool Impact event dates.
- **Assumptions page** — manual entry of round being modeled.

---

## 8. Outputs

- **Board-friendly Excel export** from the Option Grants page (matches a separate template).
- *(Future-candidate exports not yet specified: Overall Dilution, Exit Scenarios.)*

---

## 9. Open Questions / TBD

*(Use this section to track decisions as iteration continues.)*

- Excel export template — needs to be referenced by the export logic; where does it live in the repo?
- Carta import — what's the exact file format / sheet structure being parsed? Any edge cases that have already bitten the MVP?
- ~~Idea modeling — should Ideas affect Overall Dilution and Exit Scenarios, or only Pool Impact?~~ **Resolved**: Ideas flow into Exit Scenarios (labeled), not Overall Dilution.
- Multi-company state — is each company fully isolated, or do any settings live globally?
