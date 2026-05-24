import { db } from '~~/server/utils/db'

// List per-investor allocations for a round. Each row maps a stakeholder to
// the $ amount they're contributing (or contributed) to this round; the
// share count is derived from the round's share_price so a $5M contribution
// at $1/sh is 5M shares. Used by the Cap Table investors matrix and the
// scenarios compute.
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const round = db().prepare('SELECT id, share_price FROM rounds WHERE id = ?').get(id) as any
  if (!round) throw createError({ statusCode: 404, message: 'Round not found' })

  const rows = db().prepare(`
    SELECT ri.id, ri.stakeholder_id, ri.amount, ri.notes, s.name AS stakeholder_name, s.type AS stakeholder_type
    FROM round_investors ri
    JOIN stakeholders s ON s.id = ri.stakeholder_id
    WHERE ri.round_id = ?
    ORDER BY s.name COLLATE NOCASE
  `).all(id) as Array<{
    id: string; stakeholder_id: string; amount: number; notes: string | null;
    stakeholder_name: string; stakeholder_type: string | null;
  }>

  const pps = round.share_price && round.share_price > 0 ? Number(round.share_price) : 0
  return {
    round_id: id,
    share_price: pps,
    investors: rows.map(r => ({
      id: r.id,
      stakeholder_id: r.stakeholder_id,
      stakeholder_name: r.stakeholder_name,
      stakeholder_type: r.stakeholder_type,
      amount: r.amount || 0,
      shares: pps > 0 ? (r.amount || 0) / pps : 0,
      notes: r.notes,
    })),
    total_amount: rows.reduce((s, r) => s + (r.amount || 0), 0),
  }
})
