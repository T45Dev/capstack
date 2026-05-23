import { db } from '~~/server/utils/db'
import { computeRound, type ConvertibleNote, type RoundInputs, exitPayout } from '~~/server/utils/calc'

export default defineEventHandler((event) => {
  const sid = getRouterParam(event, 'id')
  if (!sid) throw createError({ statusCode: 400, message: 'id required' })

  const scenario = db().prepare('SELECT * FROM scenarios WHERE id = ?').get(sid) as any
  if (!scenario) throw createError({ statusCode: 404, message: 'Scenario not found' })

  const companyId = scenario.company_id
  const assumptions = db().prepare('SELECT * FROM assumptions WHERE company_id = ?').get(companyId) as any || {}

  // Baseline pre-round FDS from cap table
  const holdingsTotal = (db().prepare(`SELECT COALESCE(SUM(shares), 0) AS s FROM holdings WHERE company_id = ?`).get(companyId) as any)?.s || 0
  const optionsOutstanding = (db().prepare(`SELECT COALESCE(SUM(quantity), 0) AS s FROM grants WHERE company_id = ? AND status = 'outstanding'`).get(companyId) as any)?.s || 0
  const optionsProposed = (db().prepare(`SELECT COALESCE(SUM(quantity), 0) AS s FROM grants WHERE company_id = ? AND status = 'proposed'`).get(companyId) as any)?.s || 0
  const poolAuthorized = (db().prepare(`SELECT COALESCE(SUM(authorized), 0) AS s FROM option_pools WHERE company_id = ?`).get(companyId) as any)?.s || 0
  const optionsAvailable = Math.max(0, poolAuthorized - optionsOutstanding - optionsProposed)
  const fdsFromCapTable = holdingsTotal + optionsOutstanding + optionsAvailable + (scenario.pool_top_up_shares || 0)

  const preRoundFDS = assumptions.pre_round_fds != null
    ? Number(assumptions.pre_round_fds) + (scenario.pool_top_up_shares || 0)
    : fdsFromCapTable

  const cnRows = db().prepare(`
    SELECT id, stakeholder_id, stakeholder_name, principal, interest_accrued,
           conversion_discount, valuation_cap, converts_at_round
    FROM convertibles WHERE company_id = ? AND status = 'outstanding'
  `).all(companyId) as any[]
  const convertibles: ConvertibleNote[] = cnRows.map(c => ({
    id: c.id,
    stakeholderName: c.stakeholder_name,
    principal: c.principal || 0,
    interestAccrued: c.interest_accrued || 0,
    conversionDiscount: c.conversion_discount || 0,
    valuationCap: c.valuation_cap,
    convertsAtRound: c.converts_at_round !== 0,
  }))

  const inputs: RoundInputs = {
    preRoundFDS,
    preMoney: scenario.pre_money || 0,
    newMoney: scenario.new_money || 0,
    convertibles,
    cnBasis: assumptions.cn_conversion_basis || 'best',
  }

  const round = computeRound(inputs)

  // CN shares per stakeholder
  const stakeholderIdByCN = new Map<string, string | null>()
  for (const c of cnRows) stakeholderIdByCN.set(c.id, c.stakeholder_id)
  const cnSharesByStakeholder = new Map<string, number>()
  for (const detail of round.cnDetails) {
    const shId = stakeholderIdByCN.get(detail.id)
    if (!shId) continue
    cnSharesByStakeholder.set(shId, (cnSharesByStakeholder.get(shId) || 0) + detail.shares)
  }

  let exitValues: number[] = [100_000_000, 250_000_000, 500_000_000]
  try {
    if (scenario.exit_values) exitValues = JSON.parse(scenario.exit_values)
  } catch { /* keep default */ }

  const stakeholderRows = db().prepare(`
    SELECT
      s.id, s.name,
      COALESCE(SUM(h.shares), 0) AS held_shares,
      COALESCE((SELECT SUM(g.quantity) FROM grants g WHERE g.stakeholder_id = s.id AND g.status = 'outstanding'), 0) AS option_shares
    FROM stakeholders s
    LEFT JOIN holdings h ON h.stakeholder_id = s.id
    WHERE s.company_id = ?
    GROUP BY s.id, s.name
  `).all(companyId) as any[]

  // Idea events from the Option Pool Impact page. Grants + reserves are
  // hypothetical share allocations that dilute everyone if they happen; the
  // dilution table shows them as their own rows with an `isIdea` flag so
  // scenarios.vue can label them clearly. Pool top-ups are folded into the
  // post-round denominator alongside the scenario's pool_top_up_shares.
  // Other idea types (exercise / forfeit / floor) don't change the FDS pie.
  const ideaRows = db().prepare(`
    SELECT id, event_date, type, name, shares
    FROM pool_events WHERE company_id = ?
  `).all(companyId) as Array<{ id: string; event_date: string; type: string; name: string; shares: number }>

  const ideaGrantShares = ideaRows
    .filter(i => i.type === 'grant' || i.type === 'reserve')
    .reduce((a, i) => a + (i.shares || 0), 0)
  const ideaTopupShares = ideaRows
    .filter(i => i.type === 'pool_topup')
    .reduce((a, i) => a + (i.shares || 0), 0)

  // Effective post-round FDS used for dilution math. Idea grants come out of
  // post-round FDS (they're new outstanding); idea top-ups expand the pool.
  const dilutedPostFDS = round.postRoundFDS + ideaGrantShares + ideaTopupShares

  const dilution = stakeholderRows.map(r => {
    const preTotal = r.held_shares + r.option_shares
    const cnShares = cnSharesByStakeholder.get(r.id) || 0
    const postTotal = preTotal + cnShares
    const exits = exitValues.map(ev => exitPayout(postTotal, dilutedPostFDS, ev))
    return {
      stakeholderId: r.id,
      name: r.name,
      preShares: preTotal,
      cnShares,
      postShares: postTotal,
      prePct: round.preRoundFDS > 0 ? preTotal / round.preRoundFDS : 0,
      postPct: dilutedPostFDS > 0 ? postTotal / dilutedPostFDS : 0,
      exits,
      isIdea: false,
    }
  })

  // Append synthetic dilution rows for each idea grant / reserve. They have
  // no holdings, just the projected new shares.
  for (const idea of ideaRows) {
    if (idea.type !== 'grant' && idea.type !== 'reserve') continue
    const shares = idea.shares || 0
    const exits = exitValues.map(ev => exitPayout(shares, dilutedPostFDS, ev))
    dilution.push({
      stakeholderId: `idea:${idea.id}`,
      name: idea.name,
      preShares: 0,
      cnShares: 0,
      postShares: shares,
      prePct: 0,
      postPct: dilutedPostFDS > 0 ? shares / dilutedPostFDS : 0,
      exits,
      isIdea: true,
    })
  }

  dilution.sort((a, b) => b.postShares - a.postShares)

  const enrichedRound = { ...round, postRoundFDS: dilutedPostFDS, ideaGrantShares, ideaTopupShares }
  return { scenario, inputs, round: enrichedRound, dilution, exitValues }
})
