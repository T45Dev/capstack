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

  const poolAttributed = g.outstanding + g.exercised
  const poolTotal = (row?.option_pool_total as number | null) ?? 0
  const poolAvailable = poolTotal - poolAttributed

  return {
    pre_money:           row?.pre_money ?? null,
    new_money:           row?.new_money ?? null,
    share_price:         row?.share_price ?? null,
    cumulated_financing: row?.cumulated_financing ?? null,
    total_shares_fds:    row?.total_shares_fds ?? null,
    option_pool_total:   row?.option_pool_total ?? null,
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
