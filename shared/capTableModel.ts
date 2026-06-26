// Canonical cap-table math — the single source of truth for the figures that
// kept drifting between pages (pre/post FDS, the authorized/available option
// pool). Framework-agnostic and pure, so it's imported by BOTH the Vue pages
// (app/) and the Nitro endpoints (server/) — one implementation, no divergence.
//
// app/utils/capTable.ts re-exports this so client code keeps importing from
// `~/utils/capTable`; server code imports `~~/shared/capTableModel` directly.

/**
 * New preferred shares issued in a priced round: new money ÷ share price,
 * floored. Returns 0 when either input is missing or zero.
 */
export function newSharesIssued(
  newMoney: number | null | undefined,
  sharePrice: number | null | undefined,
): number {
  if (!newMoney || !sharePrice) return 0
  return Math.floor(newMoney / sharePrice)
}

export interface OpenRoundPostFdsParts {
  /** Pre-round fully-diluted total = the Previous-Round aggregate's Total FDS. */
  base: number | null | undefined
  newMoney: number | null | undefined
  sharePrice: number | null | undefined
  optionPoolIssued: number | null | undefined
  /** CN-converted shares that roll into FDS (override-aware count). */
  notesConverted: number | null | undefined
}

/**
 * Post-round fully-diluted shares = the pre-round aggregate base plus the open
 * round's OWN contributions: new preferred shares + option pool issued + notes
 * converted. Source of truth for OpenRoundCard.totalSharesFdsPost, the Overall
 * Dilution postFDS denominator, AND the Grant Fairness pre/post denominators.
 *
 * NB: this is deliberately NOT round-summary's cumulative total_shares_fds —
 * that figure already accumulates the rounds table from 0, so adding it to the
 * aggregate base would double-count all prior history.
 */
export function openRoundPostFds(parts: OpenRoundPostFdsParts): number {
  const base = parts.base || 0
  const issued = newSharesIssued(parts.newMoney, parts.sharePrice)
  const pool = parts.optionPoolIssued || 0
  const notes = parts.notesConverted || 0
  return base + issued + pool + notes
}

export interface PoolInputs {
  /** A Round-history (FDS) timeline carries the previous-round pool. */
  hasTimeline: boolean
  /** Σ of the timeline milestones' pool increases (aggregate.option_pool_total). */
  timelinePoolTotal: number
  /** The open round's own option_pool_issued (not in the timeline). */
  openRoundPoolIssued: number
  /** Σ of every round's option_pool_issued (legacy / no-timeline path). */
  allRoundsPoolIssued: number
  /** Σ of the option_pools rows (the Carta-import lump). */
  poolsLump: number
}

/**
 * Authorized option pool — one rule everything references:
 *   • With a Round-history timeline carrying a pool: the timeline total
 *     (previous rounds) + the open round's own option_pool_issued.
 *   • Otherwise: the sum of every round's typed pool, else the option_pools lump.
 * Mirrors the Pool Impact timeline so the Grants, Pool, and Fairness pages agree.
 */
export function authorizedPool(p: PoolInputs): number {
  if (p.hasTimeline && p.timelinePoolTotal > 0) return p.timelinePoolTotal + (p.openRoundPoolIssued || 0)
  if (p.allRoundsPoolIssued > 0) return p.allRoundsPoolIssued
  return p.poolsLump || 0
}

/**
 * Available pool = authorized − outstanding − exercised. Outstanding is the
 * current held (issued net of exercised/forfeited/expired); exercised shares
 * converted to common and don't return; forfeited/expired already net out of
 * outstanding, so they're not subtracted again here.
 */
export function availablePool(
  authorized: number,
  used: { outstanding: number; exercised: number },
): number {
  return authorized - (used.outstanding || 0) - (used.exercised || 0)
}

export interface PoolEquationCounts {
  /** Authorized pool — from authorizedPool(). */
  authorized: number
  /** Options currently held (issued net of exercised/forfeited/expired). */
  outstanding: number
  /** Options exercised → converted to common, permanently out of the pool. */
  exercised: number
  /** Forfeited + expired — part of issued, but returned to the pool. */
  forfeitedOrExpired: number
  /** Proposed grants modeled but not yet issued. */
  proposed: number
  /** "Idea" grants/reserves (hypothetical), default 0. */
  ideas?: number
  /** Whether ideas deduct from Future Available. Default true. */
  includeIdeas?: boolean
}

export interface PoolEquationFigures {
  authorized: number
  /** Issued = outstanding + exercised + forfeited/expired. */
  issued: number
  outstanding: number
  exercised: number
  forfeitedOrExpired: number
  /** Available = authorized − outstanding − exercised. */
  available: number
  proposed: number
  ideas: number
  /** Future Available = available − proposed − (ideas, when included). */
  futureAvailable: number
}

/**
 * The Option-Pool identity, in ONE place so the Pool Impact and Option Grants
 * pages (and anything else that shows it) can never disagree on the arithmetic:
 *
 *   Issued          = Outstanding + Exercised + Forfeited/Expired
 *   Available        = Authorized − Outstanding − Exercised
 *   Future Available = Available − Proposed − Ideas(when included)
 *
 * Forfeited/Expired is part of Issued but returns to the pool, so it cancels
 * out of Available; Exercised converted to common and does NOT return.
 */
export function poolEquation(c: PoolEquationCounts): PoolEquationFigures {
  const authorized = c.authorized || 0
  const outstanding = c.outstanding || 0
  const exercised = c.exercised || 0
  const forfeitedOrExpired = c.forfeitedOrExpired || 0
  const proposed = c.proposed || 0
  const ideas = c.ideas || 0
  const issued = outstanding + exercised + forfeitedOrExpired
  const available = availablePool(authorized, { outstanding, exercised })
  const ideasDeducted = (c.includeIdeas ?? true) ? ideas : 0
  const futureAvailable = available - proposed - ideasDeducted
  return { authorized, issued, outstanding, exercised, forfeitedOrExpired, available, proposed, ideas, futureAvailable }
}

export interface GrantLifecycle {
  /** Carta exports store this as the NET outstanding (already minus the
   *  lifecycle counts below), not the original grant size. */
  quantity?: number | null
  /** Original issued size when Carta's "Issued/Granted" column was present. */
  quantity_issued?: number | null
  quantity_exercised?: number | null
  quantity_forfeited?: number | null
  quantity_expired?: number | null
}

/**
 * Original ISSUED size of a grant. Because `quantity` is the NET outstanding,
 * deriving outstanding as `quantity − exercised − forfeited − expired` would
 * double-subtract whenever the explicit Issued column is missing. So: use
 * `quantity_issued` when we have it, else RECONSTRUCT issued by adding the
 * lifecycle counts back onto the net quantity. Then `issued − lifecycle`
 * yields the net quantity again — never double-counting. Single source of
 * truth so the pool bar, the Grants page, and the board export can't drift.
 */
export function grantIssued(g: GrantLifecycle): number {
  const qi = g.quantity_issued
  if (qi != null && qi > 0) return qi
  return (g.quantity || 0) + (g.quantity_exercised || 0) + (g.quantity_forfeited || 0) + (g.quantity_expired || 0)
}

/**
 * Currently-held (unexercised) options. Carta's "Quantity Outstanding" column
 * is the authoritative current figure, and we store it as `quantity` when the
 * export carries it — so TRUST it. Carta exports often split cancellations
 * across separate Forfeited / Expired / Canceled columns that don't cleanly
 * reconcile to Outstanding, so deriving `issued − exercised − forfeited −
 * expired` can drift from Carta's own number. We only fall back to that
 * derivation when `quantity` looks like the issued figure (i.e. no Outstanding
 * column was present) so a sheet that lacks it still works.
 */
export function grantOutstanding(g: GrantLifecycle): number {
  const issued = grantIssued(g)
  // quantity differs from issued ⇒ it's the real (net) Outstanding from Carta.
  if (g.quantity != null && g.quantity !== issued) return g.quantity
  return issued - (g.quantity_exercised || 0) - (g.quantity_forfeited || 0) - (g.quantity_expired || 0)
}

/** Vesting terms — a linear monthly vest after a cliff. */
export interface VestingTerms {
  vesting_start?: string | null
  vest_months?: number | null
  cliff_months?: number | null
}

const MS_PER_MONTH = 86400000 * 30.4375

function vestingStartMs(s: string | null | undefined): number | null {
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s))
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

/**
 * Fraction of a grant vested as of `asOfMs` (epoch ms). Linear monthly accrual
 * after the cliff: 0 before the cliff, then elapsed/vest_months, capped at 1.
 * No vest schedule (vest_months ≤ 0) ⇒ fully vested. Shared so the Option
 * Grants page, the CEO report, and the termination math can't drift.
 */
export function vestedFraction(g: VestingTerms, asOfMs: number): number {
  const vm = g.vest_months || 0
  if (vm <= 0) return 1
  const start = vestingStartMs(g.vesting_start)
  if (start == null) return 0
  const elapsed = (asOfMs - start) / MS_PER_MONTH
  if (elapsed < (g.cliff_months || 0)) return 0
  return Math.max(0, Math.min(1, elapsed / vm))
}

/** Vested share count of an `issued`-size grant as of `asOfMs`. */
export function vestedShares(issued: number, g: VestingTerms, asOfMs: number): number {
  return Math.floor((issued || 0) * vestedFraction(g, asOfMs))
}
