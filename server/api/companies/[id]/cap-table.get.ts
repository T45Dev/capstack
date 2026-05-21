import { db } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const company = db().prepare('SELECT * FROM companies WHERE id = ?').get(id)
  if (!company) throw createError({ statusCode: 404, message: 'Company not found' })

  const share_classes = db().prepare(`
    SELECT id, code, name, kind, seniority, authorized, issue_price
    FROM share_classes WHERE company_id = ?
    ORDER BY seniority ASC, kind DESC, code ASC
  `).all(id) as Array<{ id: string; issue_price: number | null; kind: string }>

  const stakeholders = db().prepare(`
    SELECT id, name, email, type, external_id FROM stakeholders WHERE company_id = ? ORDER BY name COLLATE NOCASE
  `).all(id)

  const holdings = db().prepare(`
    SELECT stakeholder_id, share_class_id, shares FROM holdings WHERE company_id = ?
  `).all(id)

  const grants = db().prepare(`
    SELECT id, stakeholder_id, recipient_name, recipient_type, round, quantity, status
    FROM grants WHERE company_id = ?
  `).all(id)

  const convertibles = db().prepare(`
    SELECT id, stakeholder_id, stakeholder_name, principal, interest_accrued, interest_rate,
           issue_date, maturity_date, valuation_cap, conversion_discount, converts_at_round, status
    FROM convertibles WHERE company_id = ?
  `).all(id)

  const pools = db().prepare(`
    SELECT id, name, authorized, adopted_date FROM option_pools WHERE company_id = ?
  `).all(id)

  // Current PPS = highest issue_price across preferred share classes (the most recent priced round).
  // Falls back to highest issue_price overall, then 0.
  let currentPPS = 0
  for (const sc of share_classes) {
    if (sc.issue_price && sc.issue_price > currentPPS) currentPPS = sc.issue_price
  }

  return { company, share_classes, stakeholders, holdings, grants, convertibles, pools, current_pps: currentPPS }
})
