// Shared cap-table FDS math. The "post-round fully-diluted shares" formula
// is needed in two places — the Open-Round card ("Total FDS post") and the
// Overall Dilution page's postFDS denominator. They MUST agree, so the
// formula lives here and both import it rather than re-deriving it.

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
 * Post-round fully-diluted shares = the pre-round aggregate base plus the
 * open round's OWN contributions: new preferred shares + option pool issued
 * + notes converted. Source of truth for both OpenRoundCard.totalSharesFdsPost
 * and the Overall Dilution page's postFDS denominator.
 *
 * NB: this is deliberately NOT round-summary's cumulative total_shares_fds —
 * that figure already accumulates the rounds table from 0, so adding it to
 * the aggregate base would double-count all prior history.
 */
export function openRoundPostFds(parts: OpenRoundPostFdsParts): number {
  const base = parts.base || 0
  const issued = newSharesIssued(parts.newMoney, parts.sharePrice)
  const pool = parts.optionPoolIssued || 0
  const notes = parts.notesConverted || 0
  return base + issued + pool + notes
}
