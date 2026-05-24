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
  convPrice: number
  shares: number
  basisApplied: 'destination' | 'deferred'
}

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const co = db().prepare('SELECT id FROM companies WHERE id = ?').get(id)
  if (!co) throw createError({ statusCode: 404, message: 'Company not found' })

  const priceByCode = new Map<string, number>()
  for (const r of (db().prepare(
    'SELECT code, share_price FROM rounds WHERE company_id = ?',
  ).all(id) as Array<{ code: string; share_price: number | null }>)) {
    if (r.share_price) priceByCode.set(String(r.code).toUpperCase(), r.share_price)
  }

  const cnRows = db().prepare(`
    SELECT id, stakeholder_name, principal, interest_accrued, interest_rate,
           issue_date, conversion_date, destination_class_code
    FROM convertibles WHERE company_id = ? AND status = 'outstanding'
  `).all(id) as Array<{
    id: string; stakeholder_name: string | null; principal: number;
    interest_accrued: number; interest_rate: number;
    issue_date: string | null; conversion_date: string | null;
    destination_class_code: string | null;
  }>

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
    const convPrice = codeKey ? (priceByCode.get(codeKey) || 0) : 0
    const shares = convPrice > 0 ? total / convPrice : 0
    return {
      id: c.id,
      stakeholderName: c.stakeholder_name || '',
      destinationClassCode: c.destination_class_code || null,
      conversionDate: c.conversion_date || null,
      principal: c.principal || 0,
      interestAccrued: interest,
      convPrice,
      shares,
      basisApplied: shares > 0 ? 'destination' : 'deferred',
    }
  })

  return { convertibles }
})
