import { db } from '~~/server/utils/db'

// Previous-Round aggregate: the typed summary numbers for everything
// before the open round, plus a computed pool-attributed total from
// the grants table (so the user sees a live "available" alongside the
// typed pool total).
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const row = db().prepare(`
    SELECT pre_money, new_money, share_price, cumulated_financing,
           total_shares_fds, option_pool_total, updated_at
    FROM aggregate_round WHERE company_id = ?
  `).get(id) as Record<string, number | string | null> | undefined

  // Pool attributed = outstanding + exercised. Forfeited and expired
  // shares return to the pool, so they don't subtract from available.
  // Matches the pool-impact page's accounting.
  const g = db().prepare(`
    SELECT
      COALESCE(SUM(quantity), 0) AS outstanding,
      COALESCE(SUM(quantity_exercised), 0) AS exercised,
      COALESCE(SUM(quantity_forfeited), 0) AS forfeited,
      COALESCE(SUM(quantity_expired), 0) AS expired
    FROM grants WHERE company_id = ?
  `).get(id) as { outstanding: number; exercised: number; forfeited: number; expired: number }

  // The Rounds table is the single source of truth for the pre-open base.
  // Everything before the open round = the closed/formation rounds: FDS =
  // the latest such round's pinned Total FDS (total_shares_fds_override),
  // pool total = sum of their option_pool_issued, share price = the latest
  // one's price. Falls back to the typed aggregate_round row when no rounds
  // have been entered yet.
  const histRounds = db().prepare(`
    SELECT share_price, option_pool_issued, total_shares_fds_override
    FROM rounds WHERE company_id = ? AND kind != 'open'
    ORDER BY (close_date IS NULL), close_date ASC, seniority ASC
  `).all(id) as Array<{ share_price: number | null; option_pool_issued: number | null; total_shares_fds_override: number | null }>
  const derived = histRounds.length > 0
  const latest = histRounds.length ? histRounds[histRounds.length - 1] : null
  const tlFds = latest?.total_shares_fds_override ?? null
  const tlPps = latest?.share_price ?? null
  const tlPool = derived ? histRounds.reduce((a, r) => a + (r.option_pool_issued || 0), 0) : null

  const total_shares_fds = derived ? tlFds : (row?.total_shares_fds ?? null)
  const option_pool_total = derived ? tlPool : (row?.option_pool_total ?? null)
  const share_price = derived && tlPps != null ? tlPps : (row?.share_price ?? null)

  const poolAttributed = g.outstanding + g.exercised
  const poolTotal = (option_pool_total as number | null) ?? 0
  const poolAvailable = poolTotal - poolAttributed

  return {
    pre_money:           row?.pre_money ?? null,
    new_money:           row?.new_money ?? null,
    share_price,
    cumulated_financing: row?.cumulated_financing ?? null,
    total_shares_fds,
    option_pool_total,
    derived_from_history: derived,
    pool_attributed:     poolAttributed,
    pool_available:      poolAvailable,
    grants_breakdown: {
      outstanding: g.outstanding,
      exercised:   g.exercised,
      forfeited:   g.forfeited,
      expired:     g.expired,
    },
    updated_at: row?.updated_at ?? null,
  }
})
