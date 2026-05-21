import { db } from '~~/server/utils/db'
import { computeRound, type ConvertibleNote, type RoundInputs, type CNBasis } from '~~/server/utils/calc'

// Body lets the caller override assumptions for live what-if. Falls back to stored.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const body = (await readBody<Partial<{
    newMoney: number
    preMoney: number
    preRoundFDS: number | null
    cnBasis: CNBasis
  }>>(event)) || {}

  const stored = db().prepare('SELECT * FROM assumptions WHERE company_id = ?').get(id) as any || {}

  // ----- Compute baseline FDS from cap table (for hint / fallback) -----
  const holdingsTotal = (db().prepare(`SELECT COALESCE(SUM(shares), 0) AS s FROM holdings WHERE company_id = ?`).get(id) as any)?.s || 0
  const optionsOutstanding = (db().prepare(`SELECT COALESCE(SUM(quantity), 0) AS s FROM grants WHERE company_id = ? AND status = 'outstanding'`).get(id) as any)?.s || 0
  const optionsProposed = (db().prepare(`SELECT COALESCE(SUM(quantity), 0) AS s FROM grants WHERE company_id = ? AND status = 'proposed'`).get(id) as any)?.s || 0
  const poolAuthorized = (db().prepare(`SELECT COALESCE(SUM(authorized), 0) AS s FROM option_pools WHERE company_id = ?`).get(id) as any)?.s || 0
  const optionsAvailable = Math.max(0, poolAuthorized - optionsOutstanding - optionsProposed)
  const fdsFromCapTable = holdingsTotal + optionsOutstanding + optionsAvailable + (stored.pool_top_up_shares || 0)

  const preRoundFDS = body.preRoundFDS != null
    ? Number(body.preRoundFDS)
    : (stored.pre_round_fds != null ? Number(stored.pre_round_fds) : fdsFromCapTable)

  // Convertibles
  const cnRows = db().prepare(`
    SELECT id, stakeholder_id, stakeholder_name, principal, interest_accrued, conversion_discount, valuation_cap
    FROM convertibles WHERE company_id = ? AND status = 'outstanding'
  `).all(id) as any[]
  const convertibles: ConvertibleNote[] = cnRows.map(c => ({
    id: c.id,
    stakeholderName: c.stakeholder_name,
    principal: c.principal || 0,
    interestAccrued: c.interest_accrued || 0,
    conversionDiscount: c.conversion_discount || 0,
    valuationCap: c.valuation_cap,
  }))

  const inputs: RoundInputs = {
    preRoundFDS,
    preMoney: body.preMoney ?? stored.pre_money ?? 0,
    newMoney: body.newMoney ?? stored.new_money ?? 0,
    convertibles,
    cnBasis: body.cnBasis ?? stored.cn_conversion_basis ?? 'best',
  }

  const round = computeRound(inputs)

  // CN shares per stakeholder for post-round position
  const stakeholderIdByCN = new Map<string, string | null>()
  for (const c of cnRows) stakeholderIdByCN.set(c.id, c.stakeholder_id)

  const cnSharesByStakeholder = new Map<string, number>()
  for (const detail of round.cnDetails) {
    const shId = stakeholderIdByCN.get(detail.id)
    if (!shId) continue
    cnSharesByStakeholder.set(shId, (cnSharesByStakeholder.get(shId) || 0) + detail.shares)
  }

  // Per-stakeholder dilution
  const stakeholderRows = db().prepare(`
    SELECT
      s.id, s.name,
      COALESCE(SUM(h.shares), 0) AS held_shares,
      COALESCE((SELECT SUM(g.quantity) FROM grants g WHERE g.stakeholder_id = s.id AND g.status = 'outstanding'), 0) AS option_shares
    FROM stakeholders s
    LEFT JOIN holdings h ON h.stakeholder_id = s.id
    WHERE s.company_id = ?
    GROUP BY s.id, s.name
  `).all(id) as any[]

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
      prePct: round.preRoundFDS > 0 ? preTotal / round.preRoundFDS : 0,
      postPct: round.postRoundFDS > 0 ? postTotal / round.postRoundFDS : 0,
    }
  }).sort((a, b) => b.postShares - a.postShares)

  return {
    inputs,
    capTableBaseline: {
      holdingsTotal,
      optionsOutstanding,
      optionsAvailable,
      poolAuthorized,
      poolTopUp: stored.pool_top_up_shares || 0,
      fdsFromCapTable,
    },
    round,
    dilution,
  }
})
