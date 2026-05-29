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

  // Per-stakeholder dilution. linked_to lets the operator merge two
  // stakeholder rows into one (e.g., "Ingenuity Medical LLC" → "Marwan
  // Berrada"); aliases roll up under their primary so the dilution
  // table shows one row per economic holder.
  const stakeholderRows = db().prepare(`
    SELECT
      s.id, s.name, s.type, s.linked_to,
      COALESCE(SUM(h.shares), 0) AS held_shares,
      COALESCE((SELECT SUM(g.quantity) FROM grants g WHERE g.stakeholder_id = s.id AND g.status = 'outstanding'), 0) AS option_shares,
      -- Cost basis = priced-round cash only; formation (founder common)
      -- contributions are excluded per the operator's rule.
      COALESCE((SELECT SUM(ri.amount) FROM round_investors ri
                  JOIN rounds rd ON rd.id = ri.round_id
                 WHERE ri.stakeholder_id = s.id AND rd.kind != 'formation'), 0) AS invested_dollars
    FROM stakeholders s
    LEFT JOIN holdings h ON h.stakeholder_id = s.id
    WHERE s.company_id = ?
    GROUP BY s.id, s.name, s.type, s.linked_to
  `).all(id) as Array<{ id: string; name: string; type: string | null; linked_to: string | null; held_shares: number; option_shares: number; invested_dollars: number }>

  const byId = new Map<string, typeof stakeholderRows[number]>()
  for (const r of stakeholderRows) byId.set(r.id, r)
  // Walk linked_to up to a NULL terminator (cap at 5 hops).
  function primaryIdFor(r: typeof stakeholderRows[number]): string {
    let cur = r
    let depth = 0
    while (cur.linked_to && depth < 5) {
      const next = byId.get(cur.linked_to)
      if (!next) break
      cur = next; depth++
    }
    return cur.id
  }

  interface DilAcc {
    stakeholderId: string
    name: string
    type: string | null
    heldShares: number
    optionShares: number
    cnShares: number
    investedDollars: number  // sum of round_investors.amount across the cluster
    aliasIds: string[]
    aliasNames: string[]
    // Whether ANY contributing row (primary or alias) is an option
    // holder. Lets the dilution UI honor a "options-only" filter even
    // when the primary is investor-typed but linked to an employee.
    hasOptions: boolean
  }
  const accByPrimary = new Map<string, DilAcc>()
  function ensure(pid: string, primary: typeof stakeholderRows[number]): DilAcc {
    let acc = accByPrimary.get(pid)
    if (!acc) {
      acc = {
        stakeholderId: pid,
        name: primary.name,
        type: primary.type || null,
        heldShares: 0, optionShares: 0, cnShares: 0,
        investedDollars: 0,
        aliasIds: [], aliasNames: [], hasOptions: false,
      }
      accByPrimary.set(pid, acc)
    }
    return acc
  }
  for (const r of stakeholderRows) {
    const pid = primaryIdFor(r)
    const primary = byId.get(pid) || r
    const acc = ensure(pid, primary)
    acc.heldShares += r.held_shares
    acc.optionShares += r.option_shares
    acc.cnShares += cnSharesByStakeholder.get(r.id) || 0
    acc.investedDollars += r.invested_dollars || 0
    if (r.option_shares > 0) acc.hasOptions = true
    if (r.id !== pid) {
      acc.aliasIds.push(r.id)
      acc.aliasNames.push(r.name)
    }
  }

  const dilution = [...accByPrimary.values()].map(a => {
    const preTotal = a.heldShares + a.optionShares
    const postTotal = preTotal + a.cnShares
    return {
      stakeholderId: a.stakeholderId,
      name: a.name,
      type: a.type,
      preShares: preTotal,
      cnShares: a.cnShares,
      postShares: postTotal,
      prePct: round.preRoundFDS > 0 ? preTotal / round.preRoundFDS : 0,
      postPct: round.postRoundFDS > 0 ? postTotal / round.postRoundFDS : 0,
      // Linking metadata so the UI can show "(includes Acme LLC)" or
      // similar, and the preferred-filter can keep linked rows visible
      // when any contributor holds options.
      aliasIds: a.aliasIds,
      aliasNames: a.aliasNames,
      hasOptions: a.hasOptions,
      // Cost-basis: sum of cash contributed across all rounds for this
      // stakeholder cluster. Lets the dilution view show what each
      // holder actually paid alongside the current notional value.
      investedDollars: a.investedDollars,
      // Weighted-average per-share entry price for the cluster — useful
      // gut-check against the current PPS.
      avgEntryPPS: a.heldShares > 0 && a.investedDollars > 0
        ? a.investedDollars / a.heldShares
        : null,
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
