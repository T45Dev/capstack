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
    SELECT id, code, name, kind, close_date, share_price, new_money, seniority
    FROM rounds WHERE company_id = ?
    ORDER BY kind = 'open' ASC, COALESCE(close_date, '9999-99-99') ASC, seniority ASC
  `).all(id) as Array<{
    id: string; code: string; name: string | null; kind: 'formation' | 'closed' | 'open';
    close_date: string | null; share_price: number | null; new_money: number; seniority: number;
  }>

  const allocations = db().prepare(`
    SELECT id, round_id, stakeholder_id, amount, notes
    FROM round_investors WHERE company_id = ?
  `).all(id) as Array<{ id: string; round_id: string; stakeholder_id: string; amount: number; notes: string | null }>

  // Investors: every stakeholder that's referenced in allocations, plus
  // every stakeholder typed as 'Investor' on the company (so the matrix
  // shows known investors even if they haven't been allocated yet).
  const involvedIds = new Set<string>(allocations.map(a => a.stakeholder_id))
  const allInvestors = db().prepare(`
    SELECT id, name, type FROM stakeholders WHERE company_id = ?
      AND (type = 'Investor' OR id IN (${involvedIds.size ? Array.from(involvedIds).map(() => '?').join(',') : 'NULL'}))
    ORDER BY name COLLATE NOCASE
  `).all(id, ...Array.from(involvedIds)) as Array<{ id: string; name: string; type: string | null }>

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

  // Sum per round; reconcile against rounds.new_money.
  const sums: Record<string, { allocated: number; new_money: number; delta: number }> = {}
  for (const r of rounds) {
    const allocated = Object.values(matrix[r.id] || {}).reduce((s, v) => s + (v.amount || 0), 0)
    sums[r.id] = { allocated, new_money: r.new_money || 0, delta: allocated - (r.new_money || 0) }
  }

  return {
    rounds: rounds.map(r => ({
      id: r.id, code: r.code, name: r.name, kind: r.kind,
      close_date: r.close_date, share_price: r.share_price, new_money: r.new_money,
    })),
    investors: allInvestors,
    matrix,
    sums,
  }
})
