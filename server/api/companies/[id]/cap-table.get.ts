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
           issue_date, maturity_date, conversion_date,
           valuation_cap, conversion_discount, converts_at_round, status
    FROM convertibles WHERE company_id = ?
  `).all(id) as Array<{
    id: string; stakeholder_id: string | null; stakeholder_name: string;
    principal: number; interest_accrued: number; valuation_cap: number | null;
    conversion_discount: number; converts_at_round: number; status: string;
  }>

  const pools = db().prepare(`
    SELECT id, name, authorized, adopted_date FROM option_pools WHERE company_id = ?
  `).all(id)

  // Current PPS = highest issue_price across share classes (most recent priced round).
  let currentPPS = 0
  for (const sc of share_classes) {
    if (sc.issue_price && sc.issue_price > currentPPS) currentPPS = sc.issue_price
  }

  // Per-stakeholder convertible totals. We project each holder's CN $ into a
  // share count at the current PPS so the cap table can show CNs as a synthetic
  // share class. The actual round conversion happens at the round PPS in the
  // compute endpoint — this is purely a "what does the cap table look like
  // assuming CNs convert" projection.
  const cnByStakeholder = new Map<string, { dollars: number; count: number }>()
  let cnUnattributedDollars = 0
  let cnUnattributedCount = 0
  for (const c of convertibles) {
    if (c.status !== 'outstanding') continue
    const total = (c.principal || 0) + (c.interest_accrued || 0)
    if (!c.stakeholder_id) {
      cnUnattributedDollars += total
      cnUnattributedCount += 1
      continue
    }
    const row = cnByStakeholder.get(c.stakeholder_id) || { dollars: 0, count: 0 }
    row.dollars += total
    row.count += 1
    cnByStakeholder.set(c.stakeholder_id, row)
  }
  const cn_by_stakeholder = Array.from(cnByStakeholder.entries()).map(([sid, v]) => ({
    stakeholder_id: sid,
    dollars: v.dollars,
    shares: currentPPS > 0 ? v.dollars / currentPPS : 0,
    count: v.count,
  }))
  const cnTotalDollars = cn_by_stakeholder.reduce((a, c) => a + c.dollars, 0) + cnUnattributedDollars
  const cnTotalShares = currentPPS > 0 ? cnTotalDollars / currentPPS : 0

  return {
    company, share_classes, stakeholders, holdings, grants, convertibles, pools,
    current_pps: currentPPS,
    cn_by_stakeholder,
    cn_unattributed: {
      dollars: cnUnattributedDollars,
      shares: currentPPS > 0 ? cnUnattributedDollars / currentPPS : 0,
      count: cnUnattributedCount,
    },
    cn_totals: { dollars: cnTotalDollars, shares: cnTotalShares },
  }
})
