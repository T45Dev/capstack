import { db } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  // Lazily expire terminated grants whose exercise window has closed: the vested
  // options still held at termination_date + exercise_window_days expire and
  // return to the pool. Idempotent — only touches past-window grants that still
  // have outstanding shares, so the pool timeline & counts stay correct over time.
  const today = new Date().toISOString().slice(0, 10)
  const pendingExpiry = db().prepare(`
    SELECT id, quantity, quantity_expired, termination_date, exercise_window_days
    FROM grants
    WHERE company_id = ? AND termination_date IS NOT NULL
      AND exercise_window_days IS NOT NULL AND COALESCE(quantity, 0) > 0
  `).all(id) as Array<{ id: string; quantity: number; quantity_expired: number | null; termination_date: string; exercise_window_days: number }>
  if (pendingExpiry.length) {
    const upd = db().prepare('UPDATE grants SET quantity_expired = ?, expired_date = ?, quantity = 0 WHERE id = ?')
    db().transaction(() => {
      for (const r of pendingExpiry) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(r.termination_date || '')
        if (!m) continue
        const expMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + (r.exercise_window_days || 0) * 86400000
        const expDate = new Date(expMs).toISOString().slice(0, 10)
        if (expDate <= today) upd.run((r.quantity_expired || 0) + r.quantity, expDate, r.id)
      }
    })()
  }

  const grants = db().prepare(`
    SELECT g.*, s.name AS linked_stakeholder, vs.name AS vesting_schedule_name
    FROM grants g
    LEFT JOIN stakeholders s ON s.id = g.stakeholder_id
    LEFT JOIN vesting_schedules vs ON vs.id = g.vesting_schedule_id
    WHERE g.company_id = ?
    ORDER BY g.status ASC, g.created_at DESC
  `).all(id)

  const pools = db().prepare(`
    SELECT * FROM option_pools WHERE company_id = ?
  `).all(id)

  return { grants, pools }
})
