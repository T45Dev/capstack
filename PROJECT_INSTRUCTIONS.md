# Capstack — Project Instructions

Working rules for Code sessions on the Capstack project. The full app spec lives in `CAPSTACK_SPEC.md` — that's the source of truth for *what* the app is. This file covers *how* to work on it.

---

## 1. Source of Truth

- `CAPSTACK_SPEC.md` is canonical. If something in code disagrees with the spec, surface it — don't silently reconcile.
- If a decision is made mid-session that changes app behavior, update `CAPSTACK_SPEC.md` in the same change. Spec drift is the enemy.
- The "Open Questions / TBD" section of the spec is the running decision log. Resolve items there as they come up.

---

## 2. Vocabulary Discipline

The terms in §2 of the spec are used consistently across UI, code, and conversation:

- **Pre / New / Post** always refer to the round being modeled (the to-close round). Never use these terms loosely.
- **Converted** = past tense, locked in. **Convertible** = not yet converted, must be assigned to a round.
- **Outstanding / Forfeited / Exercised / Available** are the four option-pool states. Don't invent synonyms.
- **Option Grants**, not "Grants" — the page rename is intentional.

Code identifiers, variable names, and UI labels should mirror this vocabulary.

---

## 3. Iteration Workflow

The MVP exists. Default mode is **incremental change**, not rebuilds.

- Before changing a page, read the spec section for that page and confirm the change aligns.
- Prefer small, reviewable diffs over large refactors. If a refactor is genuinely needed, call it out and get a sign-off first.
- When touching a page, don't drive-by other pages. One concern per change.
- If a request is ambiguous, ask before building — clarification is cheaper than a wrong rebuild.

---

## 4. Design Language (enforce, don't relitigate)

These are settled. Don't ask whether to do them; just do them.

- Left-side nav inside a company workspace; **no** left nav on the Companies page.
- Content left-justified, full available width.
- Tables: **inline add row**, **click-to-edit**, **delete button per user-added row**, **resizable columns**, **sortable headers**.
- Color: **red = negative, green = positive**.
- Don't display data that isn't needed for the page's job (e.g. no round math on Exit Scenarios).
- Unit groupings stay together — all Shares columns adjacent, all % columns adjacent, all $ columns adjacent.

---

## 5. Data Handling

- **Carta import is the primary data source.** Treat the imported file as the system of record for everything it covers; manual entry is for the Assumptions page and proposed/idea data only.
- Derived values (share price, post-money val, post-round FDS, ownership %, $ values) should always be computed from inputs — never stored as the editable field. The round-math identities in spec §2 must hold at all times.
- When a CN is *convertible* (not yet converted), require a destination round before its shares flow into pre/new buckets.
- Saving an Exit Scenario **locks the previous one** — scenarios are append-only by design.

---

## 6. What to Ask Before Building

When in doubt on any of these, ask first:

- Whether a new feature affects only one page or cascades (e.g. does an Idea on the Pool Impact page flow into Overall Dilution and Exit Scenarios?).
- Excel export changes — the template is external; confirm the target shape before changing export logic.
- Anything that changes the round-math identities or the pre/new/post definitions.
- Adding a new entity to the data model.

---

## 7. What Not to Do

- Don't add display toggles to Exit Scenarios. The page is intentionally fixed.
- Don't introduce alternate names for established concepts (no "Granted" instead of "Outstanding").
- Don't show round math on user-facing pages where it's not the point.
- Don't auto-reconcile spec/code disagreements — surface them.

---

## 8. Session Hygiene

- Start a session by stating which page(s) you're touching and which spec sections apply.
- End a session by listing: what changed, what's in the TBD section that got resolved, what new TBDs were added.
- If the spec was updated in the session, say so explicitly.
