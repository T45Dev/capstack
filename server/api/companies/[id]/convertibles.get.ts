import { db } from '~~/server/utils/db'

// List every outstanding convertible for the company, with the fields the
// Convertible Notes page needs. Unlike /compute (which only surfaces notes
// converting at the open round + deferred notes without dates), this returns
// the full ledger so attribution to any round — open or closed — keeps the
// note visible on the page.
//
// destination_class_code is the legacy column name; under the new model it
// stores the round's `code` (R1, R2, …). We look up the round's share_price
// to compute each CN's conversion price and resulting shares. CNs whose
// destination doesn't resolve to a round (stale share-class codes from old
// imports, or unassigned) come back with convPrice = 0 / shares = 0.
interface CnLine {
  id: string
  stakeholderName: string
  destinationClassCode: string | null
  conversionDate: string | null
  principal: number
  interestAccrued: number
  totalInvestment: number        // principal + accrued interest
  interestRate: number
  conversionDiscount: number
  valuationCap: number | null
  convPrice: number              // stored (Carta or user) ?? round.share_price
  effectiveConvPrice: number     // min(round PPS × (1 - discount), cap / pre-money FDS)
  shares: number                 // totalInvestment / effectiveConvPrice
  basisApplied: 'destination' | 'deferred'
  includeInSummary: boolean      // when false, round-summary skips this CN
}

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const co = db().prepare('SELECT id FROM companies WHERE id = ?').get(id)
  if (!co) throw createError({ statusCode: 404, message: 'Company not found' })

  // Round timeline + cumulative pre-money FDS per round. Pre-money FDS for
  // round X = cumulative FDS through round X-1, which is what the cap-based
  // effective conv price uses as its denominator. Sort matches
  // round-summary.get (open rounds last, otherwise close_date ascending).
  const rounds = db().prepare(`
    SELECT code, name, share_class_code, share_price, common, preferred_issued,
           option_pool_issued, close_date, seniority, kind, parent_round_code
    FROM rounds WHERE company_id = ?
  `).all(id) as Array<{
    code: string; name: string | null; share_class_code: string | null;
    share_price: number | null;
    common: number; preferred_issued: number; option_pool_issued: number;
    close_date: string | null; seniority: number;
    kind: 'formation' | 'closed' | 'open';
    parent_round_code: string | null;
  }>

  rounds.sort((a, b) => {
    const aOpen = a.kind === 'open'
    const bOpen = b.kind === 'open'
    if (aOpen !== bOpen) return aOpen ? 1 : -1
    const ad = a.close_date
    const bd = b.close_date
    if (ad && bd) {
      if (ad !== bd) return ad.localeCompare(bd)
      return a.seniority - b.seniority
    }
    if (ad) return -1
    if (bd) return 1
    return a.seniority - b.seniority
  })

  const cnRows = db().prepare(`
    SELECT id, stakeholder_name, principal, interest_accrued, interest_rate,
           issue_date, conversion_date, destination_class_code,
           conversion_discount, valuation_cap, conversion_price,
           include_in_summary
    FROM convertibles WHERE company_id = ? AND status = 'outstanding'
  `).all(id) as Array<{
    id: string; stakeholder_name: string | null; principal: number;
    interest_accrued: number; interest_rate: number;
    issue_date: string | null; conversion_date: string | null;
    destination_class_code: string | null;
    conversion_discount: number; valuation_cap: number | null;
    conversion_price: number | null;
    include_in_summary: number;
  }>

  // Accrued interest = principal × rate × (conversion_date − issue_date) / 365.
  // Accrual stops at the conversion date; if one of issue_date,
  // conversion_date, or interest_rate is missing we fall back to the
  // stored interest_accrued value (e.g. Carta's snapshot).
  function accruedInterestFor(c: typeof cnRows[number]): number {
    if (!c.conversion_date || !c.issue_date || !c.interest_rate || c.interest_rate <= 0) {
      return c.interest_accrued || 0
    }
    const conv = new Date(c.conversion_date).getTime()
    const iss = new Date(c.issue_date).getTime()
    if (!isFinite(conv) || !isFinite(iss)) return c.interest_accrued || 0
    const days = (conv - iss) / (1000 * 60 * 60 * 24)
    if (days <= 0) return c.interest_accrued || 0
    return (c.principal || 0) * c.interest_rate * (days / 365)
  }

  // Round destination keys → canonical round.code. Match on either the
  // round's own code or its share_class_code so Carta-imported CN
  // destinations (which use share-class codes like SA2 / PB1) resolve
  // correctly.
  const roundCodeByAttribKey = new Map<string, typeof rounds[number]>()
  for (const r of rounds) {
    roundCodeByAttribKey.set(r.code.toUpperCase(), r)
    if (r.share_class_code) roundCodeByAttribKey.set(r.share_class_code.toUpperCase(), r)
  }

  // Group CNs by destination round so we can walk rounds chronologically
  // and resolve each CN's shares with the correct pre-money FDS — which
  // INCLUDES CN-converted shares from prior rounds. (Building a static
  // preFDSByCode without folding in CN shares produces the wrong number
  // when a cap binds at a later round.)
  const cnsByRound = new Map<string, typeof cnRows>()
  const unresolvedCns: typeof cnRows = []
  for (const c of cnRows) {
    const codeRaw = c.destination_class_code ? String(c.destination_class_code).replace(/-\d+$/, '').toUpperCase() : ''
    const r = codeRaw ? roundCodeByAttribKey.get(codeRaw) : undefined
    if (!r) { unresolvedCns.push(c); continue }
    const key = r.code.toUpperCase()
    const bucket = cnsByRound.get(key) || []
    bucket.push(c)
    cnsByRound.set(key, bucket)
  }

  // Chronological walk: at round R, preFDS = sum over rounds-before-R of
  // (common + preferred_issued + option_pool_issued + CN shares attributed
  // to that round). Compute each CN's shares using that preFDS, then add
  // them to cumulativeFDS before moving on.
  const sharesByCn = new Map<string, { shares: number; effectiveConvPrice: number; convPrice: number; preFDS: number }>()
  const preFDSByRoundCode = new Map<string, number>()
  function qfInitialPreFDS(r: typeof rounds[number], ownPreFDS: number): number {
    let parentCode = r.parent_round_code
    let depth = 0
    while (parentCode && depth < 5) {
      const fromMap = preFDSByRoundCode.get(parentCode.toUpperCase())
      if (fromMap !== undefined) return fromMap
      const parentRound = rounds.find(x => x.code.toUpperCase() === parentCode!.toUpperCase())
      if (!parentRound) break
      parentCode = parentRound.parent_round_code
      depth++
    }
    return ownPreFDS
  }

  let cumulativeFDS = 0
  for (const r of rounds) {
    const ownPreFDS = cumulativeFDS
    preFDSByRoundCode.set(r.code.toUpperCase(), ownPreFDS)
    // CN cap formula uses the QF-initial preFDS (parent's preFDS when
    // this round is a tranche of an earlier-started Qualified
    // Financing). Mirrors the round-summary logic so the CN ledger's
    // Resulting column agrees with the Financings table's Notes
    // converted column.
    const preFDS = qfInitialPreFDS(r, ownPreFDS)
    const roundPPS = r.share_price && r.share_price > 0 ? r.share_price : 0
    const bucket = cnsByRound.get(r.code.toUpperCase()) || []
    let bucketShares = 0
    for (const c of bucket) {
      const interest = accruedInterestFor(c)
      const total = (c.principal || 0) + interest
      const storedConvPrice = c.conversion_price && c.conversion_price > 0 ? c.conversion_price : 0
      const convPrice = storedConvPrice || roundPPS
      const discount = c.conversion_discount || 0
      const cap = c.valuation_cap || 0
      let eff = 0
      if (convPrice > 0) {
        const discountPrice = discount > 0 ? convPrice * (1 - discount) : convPrice
        const capPrice = cap > 0 && preFDS > 0 ? cap / preFDS : 0
        eff = capPrice > 0 ? Math.min(discountPrice, capPrice) : discountPrice
      } else if (cap > 0 && preFDS > 0) {
        eff = cap / preFDS
      }
      const shares = eff > 0 ? total / eff : 0
      sharesByCn.set(c.id, { shares, effectiveConvPrice: eff, convPrice, preFDS })
      bucketShares += shares
    }
    cumulativeFDS += (r.common || 0) + (r.preferred_issued || 0) + (r.option_pool_issued || 0) + bucketShares
  }

  // CNs whose destination couldn't be resolved (deferred / stale): no
  // shares yet, just expose them so the ledger surfaces the issue.
  for (const c of unresolvedCns) {
    sharesByCn.set(c.id, { shares: 0, effectiveConvPrice: 0, convPrice: 0, preFDS: 0 })
  }

  const convertibles: CnLine[] = cnRows.map(c => {
    const interest = accruedInterestFor(c)
    const total = (c.principal || 0) + interest
    const computed = sharesByCn.get(c.id) || { shares: 0, effectiveConvPrice: 0, convPrice: 0, preFDS: 0 }
    const { shares, effectiveConvPrice, convPrice } = computed
    return {
      id: c.id,
      stakeholderName: c.stakeholder_name || '',
      destinationClassCode: c.destination_class_code || null,
      conversionDate: c.conversion_date || null,
      principal: c.principal || 0,
      interestAccrued: interest,
      totalInvestment: total,
      interestRate: c.interest_rate || 0,
      conversionDiscount: c.conversion_discount || 0,
      valuationCap: c.valuation_cap || null,
      convPrice,
      effectiveConvPrice,
      shares,
      basisApplied: c.destination_class_code ? 'destination' : 'deferred',
      includeInSummary: c.include_in_summary !== 0,
    }
  })

  return { convertibles }
})
