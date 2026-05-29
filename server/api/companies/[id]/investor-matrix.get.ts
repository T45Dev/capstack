import { db } from '~~/server/utils/db'

// The investors-by-round matrix. Returns:
//   - rounds (cols)
//   - investors (rows: every stakeholder that has at least one allocation OR
//     is typed as 'Investor' on the stakeholders table, so the UI can also
//     show empty cells for existing investors)
//   - allocations[round_id][stakeholder_id] = { id, amount, shares }
// The Cap Table page renders this as an editable matrix below the Summary
// card. Sum of amounts per round should reconcile with rounds.new_money;
// the UI highlights any mismatch.
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const rounds = db().prepare(`
    SELECT id, code, name, kind, close_date, share_price, new_money, preferred_issued, seniority
    FROM rounds WHERE company_id = ?
    ORDER BY kind = 'open' ASC, COALESCE(close_date, '9999-99-99') ASC, seniority ASC
  `).all(id) as Array<{
    id: string; code: string; name: string | null; kind: 'formation' | 'closed' | 'open';
    close_date: string | null; share_price: number | null; new_money: number;
    preferred_issued: number; seniority: number;
  }>

  const allocations = db().prepare(`
    SELECT id, round_id, stakeholder_id, amount, notes
    FROM round_investors WHERE company_id = ?
  `).all(id) as Array<{ id: string; round_id: string; stakeholder_id: string; amount: number; notes: string | null }>

  // Preferred-investor filter: per the operator's rule, a "preferred
  // investor" is anyone who isn't an option-holder. We exclude any
  // stakeholder who has an outstanding grant from this matrix even if
  // they also paid into a ledger (Carta records option exercises with
  // cash, so without this filter Employee X would show up as a
  // "preferred investor" too).
  const optionHolderIds = new Set<string>(
    (db().prepare(
      `SELECT DISTINCT stakeholder_id FROM grants WHERE company_id = ? AND stakeholder_id IS NOT NULL`,
    ).all(id) as Array<{ stakeholder_id: string }>).map(r => r.stakeholder_id),
  )

  // Investors: every stakeholder that's referenced in allocations OR
  // holds an outstanding convertible OR is typed as 'Investor' on the
  // company. Minus any option-holder (per the operator rule:
  // "preferred investors are anyone that isn't an option holder").
  // A CN-only investor — someone who only put money in via a note,
  // no equity yet — still belongs on this matrix; the CN column is
  // what surfaces their stake.
  const involvedIds = new Set<string>(allocations.map(a => a.stakeholder_id))
  const cnHolderIds = new Set<string>(
    (db().prepare(
      `SELECT DISTINCT stakeholder_id FROM convertibles WHERE company_id = ? AND status = 'outstanding' AND stakeholder_id IS NOT NULL`,
    ).all(id) as Array<{ stakeholder_id: string }>).map(r => r.stakeholder_id),
  )
  for (const c of cnHolderIds) involvedIds.add(c)
  const rawInvestors = db().prepare(`
    SELECT id, name, type FROM stakeholders WHERE company_id = ?
      AND (type = 'Investor' OR id IN (${involvedIds.size ? Array.from(involvedIds).map(() => '?').join(',') : 'NULL'}))
    ORDER BY name COLLATE NOCASE
  `).all(id, ...Array.from(involvedIds)) as Array<{ id: string; name: string; type: string | null }>
  const allInvestors = rawInvestors.filter(s => !optionHolderIds.has(s.id))

  // Convertible-note totals per stakeholder. The Preferred Investor
  // matrix surfaces these alongside the per-round cash columns so the
  // operator can see paper-money + cash in one view. Total = principal
  // + accrued (the effective cash-equivalent the note represents);
  // breakdown surfaces principal separately for cell tooltips.
  const cnRows = db().prepare(`
    SELECT stakeholder_id,
           COALESCE(SUM(principal), 0) AS principal,
           COALESCE(SUM(interest_accrued), 0) AS accrued,
           COUNT(*) AS notes
    FROM convertibles
    WHERE company_id = ? AND status = 'outstanding' AND stakeholder_id IS NOT NULL
    GROUP BY stakeholder_id
  `).all(id) as Array<{ stakeholder_id: string; principal: number; accrued: number; notes: number }>
  const cnByStakeholder = new Map<string, { principal: number; accrued: number; total: number; notes: number }>()
  for (const r of cnRows) {
    cnByStakeholder.set(r.stakeholder_id, {
      principal: r.principal,
      accrued:   r.accrued,
      total:     r.principal + r.accrued,
      notes:     r.notes,
    })
  }

  // allocations[round_id][stakeholder_id]
  const matrix: Record<string, Record<string, { id: string; amount: number; shares: number; notes: string | null }>> = {}
  const ppsByRound = new Map<string, number>()
  for (const r of rounds) ppsByRound.set(r.id, r.share_price && r.share_price > 0 ? Number(r.share_price) : 0)
  for (const r of rounds) matrix[r.id] = {}
  for (const a of allocations) {
    const pps = ppsByRound.get(a.round_id) || 0
    if (!matrix[a.round_id]) matrix[a.round_id] = {}
    matrix[a.round_id][a.stakeholder_id] = {
      id: a.id,
      amount: a.amount || 0,
      shares: pps > 0 ? Math.floor((a.amount || 0) / pps) : 0,
      notes: a.notes,
    }
  }

  // Sum per round in BOTH currencies. The matrix is shares-first, so
  // the UI reconciles allocated_shares vs preferred_issued; we still
  // expose the $ sums so the cell tooltip can show "$X allocated of
  // $Y new money" for operators with the dollar habit.
  const sums: Record<string, {
    allocated: number; new_money: number; delta: number;
    allocated_shares: number; preferred_issued: number; delta_shares: number;
  }> = {}
  for (const r of rounds) {
    const allocated = Object.values(matrix[r.id] || {}).reduce((s, v) => s + (v.amount || 0), 0)
    const allocatedShares = Object.values(matrix[r.id] || {}).reduce((s, v) => s + (v.shares || 0), 0)
    sums[r.id] = {
      allocated,
      new_money: r.new_money || 0,
      delta: allocated - (r.new_money || 0),
      allocated_shares: allocatedShares,
      preferred_issued: r.preferred_issued || 0,
      delta_shares: allocatedShares - (r.preferred_issued || 0),
    }
  }

  // Per-stakeholder CN totals to surface as an extra column in the
  // matrix. Filtered to only the visible (non-option-holder) investors
  // so the column lines up with the row set.
  const cn: Record<string, { principal: number; accrued: number; total: number; notes: number }> = {}
  for (const inv of allInvestors) {
    const row = cnByStakeholder.get(inv.id)
    if (row) cn[inv.id] = row
  }
  const cnTotal = Object.values(cn).reduce((s, v) => s + v.total, 0)

  return {
    rounds: rounds.map(r => ({
      id: r.id, code: r.code, name: r.name, kind: r.kind,
      close_date: r.close_date, share_price: r.share_price,
      new_money: r.new_money, preferred_issued: r.preferred_issued,
    })),
    investors: allInvestors,
    matrix,
    sums,
    cn,                   // per-investor CN totals (keyed by stakeholder id)
    cn_total: cnTotal,    // footer total across visible investors
  }
})
