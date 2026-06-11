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

  // The Previous-Round aggregate = the cap-table state BEFORE the round being
  // modeled. The "current round" mirrors the dilution / grants / fairness
  // pages: the open round if one is flagged, else the latest non-formation
  // round. Those pages compute post = base + the current round's OWN
  // contribution (new shares + pool + notes), so this base must EXCLUDE the
  // current round — returning the current round's own cumulative double-counts
  // it (the "Series B counted twice → 64.2M" bug). We read the COMPUTED
  // cumulative from round-summary (which nets exercised options and honors any
  // pinned Total FDS) for the round immediately before the current one. Falls
  // back to the typed aggregate_round row when no rounds exist yet.
  const summary = await event.$fetch<{ rounds: Array<{ kind: string; share_price: number | null; option_pool_issued: number; total_shares_fds: number }> }>(`/api/companies/${id}/round-summary`).catch(() => null)
  const allRounds = summary?.rounds || []
  let currentIdx = allRounds.findIndex(r => r.kind === 'open')
  if (currentIdx < 0) {
    for (let i = allRounds.length - 1; i >= 0; i--) {
      if (allRounds[i]!.kind !== 'formation') { currentIdx = i; break }
    }
  }
  // Everything strictly before the current round.
  const priorRounds = currentIdx > 0 ? allRounds.slice(0, currentIdx) : []
  const derived = allRounds.length > 0
  const prior = priorRounds.length ? priorRounds[priorRounds.length - 1] : null
  const tlFds = derived ? (prior?.total_shares_fds ?? 0) : null
  const tlPps = prior?.share_price ?? null
  const tlPool = derived ? priorRounds.reduce((a, r) => a + (r.option_pool_issued || 0), 0) : null

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
