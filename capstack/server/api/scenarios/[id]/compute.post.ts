import { db } from '~~/server/utils/db'
import { computeRound, type PreRoundState, type ShareClassPos, type ConvertibleNote, type RoundAssumptions, exitPayout } from '~~/server/utils/calc'

// Same shape as /companies/:id/compute but reads assumptions from the scenario row.
export default defineEventHandler((event) => {
  const sid = getRouterParam(event, 'id')
  if (!sid) throw createError({ statusCode: 400, message: 'id required' })

  const scenario = db().prepare('SELECT * FROM scenarios WHERE id = ?').get(sid) as any
  if (!scenario) throw createError({ statusCode: 404, message: 'Scenario not found' })

  const companyId = scenario.company_id

  const a: RoundAssumptions = {
    newMoney: scenario.new_money || 0,
    preMoney: scenario.pre_money || 0,
    poolTopUpShares: scenario.pool_top_up_shares || 0,
    cnBasis: 'round_price',
  }

  const shareClasses = db().prepare(`
    SELECT id, code, name, kind, issue_price
    FROM share_classes WHERE company_id = ? ORDER BY seniority
  `).all(companyId) as any[]

  const holdingsAgg = db().prepare(`
    SELECT share_class_id, COALESCE(SUM(shares), 0) AS shares
    FROM holdings WHERE company_id = ? GROUP BY share_class_id
  `).all(companyId) as any[]
  const sharesByClass = new Map<string, number>()
  for (const h of holdingsAgg) sharesByClass.set(h.share_class_id, h.shares)

  const scPos: ShareClassPos[] = shareClasses.map(sc => ({
    id: sc.id,
    code: sc.code,
    name: sc.name,
    kind: sc.kind,
    shares: sharesByClass.get(sc.id) || 0,
    issuePrice: sc.issue_price,
  }))

  const grantSum = db().prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'outstanding' THEN quantity ELSE 0 END), 0) AS outstanding,
      COALESCE(SUM(CASE WHEN status = 'proposed' THEN quantity ELSE 0 END), 0) AS proposed
    FROM grants WHERE company_id = ?
  `).get(companyId) as { outstanding: number; proposed: number }

  const poolAuthorized = (db().prepare(`SELECT COALESCE(SUM(authorized), 0) AS s FROM option_pools WHERE company_id = ?`).get(companyId) as any)?.s || 0
  const optionsAvailable = Math.max(0, poolAuthorized - grantSum.outstanding - grantSum.proposed)

  const cn = db().prepare(`
    SELECT id, stakeholder_name, principal, interest_accrued, conversion_discount, valuation_cap
    FROM convertibles WHERE company_id = ? AND status = 'outstanding'
  `).all(companyId) as any[]
  const convertibles: ConvertibleNote[] = cn.map(c => ({
    id: c.id,
    stakeholderName: c.stakeholder_name,
    principal: c.principal || 0,
    interestAccrued: c.interest_accrued || 0,
    conversionDiscount: c.conversion_discount || 0,
    valuationCap: c.valuation_cap,
  }))

  const state: PreRoundState = {
    shareClasses: scPos,
    optionsOutstanding: grantSum.outstanding,
    optionsAvailable,
    poolAuthorized,
    convertibles,
  }

  const round = computeRound(state, a)

  // Per-stakeholder shares
  const stakeholderRows = db().prepare(`
    SELECT
      s.id, s.name,
      COALESCE(SUM(h.shares), 0) AS held_shares,
      COALESCE((SELECT SUM(g.quantity) FROM grants g WHERE g.stakeholder_id = s.id AND g.status = 'outstanding'), 0) AS option_shares,
      COALESCE((SELECT SUM(c.principal + c.interest_accrued) FROM convertibles c WHERE c.stakeholder_id = s.id AND c.status = 'outstanding'), 0) AS cn_dollars
    FROM stakeholders s
    LEFT JOIN holdings h ON h.stakeholder_id = s.id
    WHERE s.company_id = ?
    GROUP BY s.id, s.name
  `).all(companyId) as any[]

  const cnSharesByStakeholder = new Map<string, number>()
  if (round.pricePerShare > 0) {
    const cnRows = db().prepare(`
      SELECT stakeholder_id, principal, interest_accrued
      FROM convertibles WHERE company_id = ? AND status = 'outstanding' AND stakeholder_id IS NOT NULL
    `).all(companyId) as any[]
    for (const c of cnRows) {
      const total = (c.principal || 0) + (c.interest_accrued || 0)
      const shares = total / round.pricePerShare
      cnSharesByStakeholder.set(c.stakeholder_id, (cnSharesByStakeholder.get(c.stakeholder_id) || 0) + shares)
    }
  }

  // Exit values: parse from scenario.exit_values JSON or default
  let exitValues: number[] = [100_000_000, 250_000_000, 500_000_000]
  try {
    if (scenario.exit_values) exitValues = JSON.parse(scenario.exit_values)
  } catch { /* keep default */ }

  const dilution = stakeholderRows.map(r => {
    const preTotal = r.held_shares + r.option_shares
    const cnShares = cnSharesByStakeholder.get(r.id) || 0
    const postTotal = preTotal + cnShares
    const exits = exitValues.map(ev => exitPayout(postTotal, round.postRoundFDS, ev))
    return {
      stakeholderId: r.id,
      name: r.name,
      preShares: preTotal,
      cnShares,
      postShares: postTotal,
      prePct: round.effectiveFDS > 0 ? preTotal / round.effectiveFDS : 0,
      postPct: round.postRoundFDS > 0 ? postTotal / round.postRoundFDS : 0,
      exits,
    }
  }).sort((a, b) => b.postShares - a.postShares)

  return { scenario, assumptions: a, round, dilution, exitValues }
})
