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

  // Round-history timeline (Financings). When present, it's the source of
  // truth for the pre-open base: FDS = latest milestone's FDS, pool total =
  // sum of milestone pool increases, share price = latest milestone PPS. Falls
  // back to the typed aggregate when no timeline exists (so nothing changes
  // for companies that haven't entered one).
  const ms = db().prepare(`SELECT as_of_date, fds, pps, option_pool FROM cap_table_milestones WHERE company_id = ? ORDER BY as_of_date ASC, created_at ASC`).all(id) as any[]
  const derived = ms.length > 0
  const latest = ms.length ? ms[ms.length - 1] : null
  const tlFds = latest?.fds ?? null
  const tlPps = latest?.pps ?? null
  const tlPool = derived ? ms.reduce((a, m) => a + (m.option_pool || 0), 0) : null

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
