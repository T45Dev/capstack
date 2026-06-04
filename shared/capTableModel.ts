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
