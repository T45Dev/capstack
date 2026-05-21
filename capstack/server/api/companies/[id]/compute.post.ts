import { db } from '~~/server/utils/db'
import { computeRound, type PreRoundState, type ShareClassPos, type ConvertibleNote, type RoundAssumptions } from '~~/server/utils/calc'

// Body lets the caller override assumptions for live what-if. Falls back to stored.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const body = (await readBody<Partial<RoundAssumptions> & { exit_values?: number[] }>(event)) || {}

  const stored = db().prepare('SELECT * FROM assumptions WHERE company_id = ?').get(id) as any || {}

  const a: RoundAssumptions = {
    newMoney: body.newMoney ?? stored.new_money ?? 0,
    preMoney: body.preMoney ?? stored.pre_money ?? 0,
    poolTopUpShares: body.poolTopUpShares ?? stored.pool_top_up_shares ?? 0,
    cnBasis: body.cnBasis ?? stored.cn_conversion_basis ?? 'round_price',
  }

  // Build pre-round state
  const shareClasses = db().prepare(`
    SELECT id, code, name, kind, issue_price
    FROM share_classes WHERE company_id = ? ORDER BY seniority
  `).all(id) as any[]

  const holdingsAgg = db().prepare(`
    SELECT share_class_id, COALESCE(SUM(shares), 0) AS shares
    FROM holdings WHERE company_id = ? GROUP BY share_class_id
  `).all(id) as any[]
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
  `).get(id) as { outstanding: number; proposed: number }

  const poolAuthorized = (db().prepare(`SELECT COALESCE(SUM(authorized), 0) AS s FROM option_pools WHERE company_id = ?`).get(id) as any)?.s || 0
  const optionsAvailable = Math.max(0, poolAuthorized - grantSum.outstanding - grantSum.proposed)

  const cn = db().prepare(`
    SELECT id, stakeholder_name, principal, interest_accrued, conversion_discount, valuation_cap
    FROM convertibles WHERE company_id = ? AND status = 'outstanding'
  `).all(id) as any[]
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
    optionsAvailable: optionsAvailable,
    poolAuthorized,
    convertibles,
  }

  const round = computeRound(state, a)

  // Per-stakeholder dilution
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
  `).all(id) as any[]

  // CN shares per stakeholder for post-round position
  const cnSharesByStakeholder = new Map<string, number>()
  if (round.pricePerShare > 0) {
    const cnRows = db().prepare(`
      SELECT stakeholder_id, principal, interest_accrued, conversion_discount, valuation_cap
      FROM convertibles WHERE company_id = ? AND status = 'outstanding'
    `).all(id) as any[]
    for (const c of cnRows) {
      if (!c.stakeholder_id) continue
      const total = (c.principal || 0) + (c.interest_accrued || 0)
      let convPrice = round.pricePerShare
      if (a.cnBasis === 'discount' && c.conversion_discount > 0) convPrice = round.pricePerShare * (1 - c.conversion_discount)
      else if (a.cnBasis === 'cap' && c.valuation_cap && state.shareClasses.length > 0) {
        const eff = round.effectiveFDS
        if (eff > 0) convPrice = Math.min(round.pricePerShare, c.valuation_cap / eff)
      }
      const shares = convPrice > 0 ? total / convPrice : 0
      cnSharesByStakeholder.set(c.stakeholder_id, (cnSharesByStakeholder.get(c.stakeholder_id) || 0) + shares)
    }
  }

  const dilution = stakeholderRows.map(r => {
    const preTotal = r.held_shares + r.option_shares
    const cnShares = cnSharesByStakeholder.get(r.id) || 0
    const postTotal = preTotal + cnShares
    return {
      stakeholderId: r.id,
      name: r.name,
      preShares: preTotal,
      cnShares,
      postShares: postTotal,
      prePct: round.effectiveFDS > 0 ? preTotal / round.effectiveFDS : 0,
      postPct: round.postRoundFDS > 0 ? postTotal / round.postRoundFDS : 0,
    }
  }).sort((a, b) => b.postShares - a.postShares)

  return {
    assumptions: a,
    state: {
      shareClasses: scPos,
      optionsOutstanding: state.optionsOutstanding,
      optionsAvailable: state.optionsAvailable,
      poolAuthorized: state.poolAuthorized,
    },
    round,
    dilution,
  }
})
