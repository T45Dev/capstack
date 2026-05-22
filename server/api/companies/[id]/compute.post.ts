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

  // Convertibles. Each note carries its own conversion_date. When that's set
  // alongside an issue_date and non-zero interest_rate, accrued interest is
  // recomputed live as principal × rate × (conversion_date - issue_date) / 365.
  // Falls back to the snapshot interest_accrued imported from Carta when any
  // input is missing.
  const cnRows = db().prepare(`
    SELECT id, stakeholder_id, stakeholder_name, principal, interest_accrued,
           interest_rate, issue_date, conversion_date, destination_class_code,
           conversion_discount, valuation_cap, converts_at_round
    FROM convertibles WHERE company_id = ? AND status = 'outstanding'
  `).all(id) as any[]

  // Build code -> issue_price so we can resolve each CN's Destination class
  // (Carta tags blocks as "SA2-1", "PB2-3"; the share-class code is the
  // prefix before the "-N" suffix).
  const classPriceByCode = new Map<string, number>()
  for (const sc of (db().prepare(
    'SELECT code, issue_price FROM share_classes WHERE company_id = ?',
  ).all(id) as any[])) {
    if (sc.issue_price) classPriceByCode.set(String(sc.code).toUpperCase(), sc.issue_price)
  }
  function destinationPPSFor(code: string | null | undefined): number | null {
    if (!code) return null
    const stripped = String(code).replace(/-\d+$/, '').toUpperCase()
    return classPriceByCode.get(stripped) ?? null
  }

  function accruedInterestFor(c: any): number {
    if (!c.conversion_date || !c.issue_date || !c.interest_rate || c.interest_rate <= 0) {
      return c.interest_accrued || 0
    }
    const convMs = new Date(c.conversion_date).getTime()
    const issuedMs = new Date(c.issue_date).getTime()
    if (!isFinite(convMs) || !isFinite(issuedMs)) return c.interest_accrued || 0
    const days = (convMs - issuedMs) / (1000 * 60 * 60 * 24)
    if (days <= 0) return c.interest_accrued || 0
    return (c.principal || 0) * c.interest_rate * (days / 365)
  }

  const convertibles: ConvertibleNote[] = cnRows.map(c => ({
    id: c.id,
    stakeholderName: c.stakeholder_name,
    principal: c.principal || 0,
    interestAccrued: accruedInterestFor(c),
    conversionDiscount: c.conversion_discount || 0,
    valuationCap: c.valuation_cap,
    convertsAtRound: c.converts_at_round !== 0,
    conversionDate: c.conversion_date || null,
    issueDate: c.issue_date || null,
    interestRate: c.interest_rate || 0,
    destinationClassCode: c.destination_class_code || null,
    destinationPPS: destinationPPSFor(c.destination_class_code),
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
