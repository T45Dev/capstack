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
    SELECT code, share_price, common, preferred_issued, option_pool_issued,
           close_date, seniority, kind
    FROM rounds WHERE company_id = ?
  `).all(id) as Array<{
    code: string; share_price: number | null;
    common: number; preferred_issued: number; option_pool_issued: number;
    close_date: string | null; seniority: number;
    kind: 'formation' | 'closed' | 'open';
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

  const priceByCode = new Map<string, number>()
  const preFDSByCode = new Map<string, number>()
  let cumulativeFDS = 0
  for (const r of rounds) {
    const key = String(r.code).toUpperCase()
    preFDSByCode.set(key, cumulativeFDS)
    if (r.share_price) priceByCode.set(key, r.share_price)
    cumulativeFDS += (r.common || 0) + (r.preferred_issued || 0) + (r.option_pool_issued || 0)
  }

  const cnRows = db().prepare(`
    SELECT id, stakeholder_name, principal, interest_accrued, interest_rate,
           issue_date, conversion_date, destination_class_code,
           conversion_discount, valuation_cap, conversion_price
    FROM convertibles WHERE company_id = ? AND status = 'outstanding'
  `).all(id) as Array<{
    id: string; stakeholder_name: string | null; principal: number;
    interest_accrued: number; interest_rate: number;
    issue_date: string | null; conversion_date: string | null;
    destination_class_code: string | null;
    conversion_discount: number; valuation_cap: number | null;
    conversion_price: number | null;
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

  const convertibles: CnLine[] = cnRows.map(c => {
    const interest = accruedInterestFor(c)
    const total = (c.principal || 0) + interest
    const codeKey = c.destination_class_code ? String(c.destination_class_code).toUpperCase() : ''
    // Share price (basis for the effective calc): user-typed conversion_price
    // overrides the attributed round's share_price. Editing the Share price
    // cell flows through to Effective price and Shares.
    const storedConvPrice = c.conversion_price && c.conversion_price > 0 ? c.conversion_price : 0
    const roundPPS = codeKey ? (priceByCode.get(codeKey) || 0) : 0
    const convPrice = storedConvPrice || roundPPS

    // Effective conv price uses the Share price as its basis, then applies
    // cap/discount adjustments:
    //   - convPrice × (1 − discount)        when a discount is set
    //   - cap / pre-money FDS at this round when a cap is set + FDS known
    // Whichever is lower wins (best price for the noteholder).
    const discount = c.conversion_discount || 0
    const cap = c.valuation_cap || 0
    const preFDS = codeKey ? (preFDSByCode.get(codeKey) || 0) : 0
    let effectiveConvPrice = 0
    if (convPrice > 0) {
      const discountPrice = discount > 0 ? convPrice * (1 - discount) : convPrice
      const capPrice = cap > 0 && preFDS > 0 ? cap / preFDS : 0
      effectiveConvPrice = capPrice > 0 ? Math.min(discountPrice, capPrice) : discountPrice
    } else if (cap > 0 && preFDS > 0) {
      effectiveConvPrice = cap / preFDS
    }

    // Shares come from total investment ÷ effective conversion price, so
    // cap/discount math flows through to the resulting share count.
    const shares = effectiveConvPrice > 0 ? total / effectiveConvPrice : 0
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
    }
  })

  return { convertibles }
})
