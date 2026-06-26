import { db } from '~~/server/utils/db'
import { grantIssued, grantOutstanding, vestedFraction } from '~~/shared/capTableModel'

// Terminate a grant. At termination the UNVESTED portion forfeits immediately
// (returns to the pool); the VESTED portion stays exercisable for an exercise
// window (default 90 days). Whatever vested isn't exercised by termination +
// window expires (also returns to the pool) — materialized here if the window
// has already closed, otherwise lazily once it does (see grants.get).
//
// We pin quantity_issued to the original size so the lifecycle counts
// (forfeited / expired / exercised / outstanding) always reconcile.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<{ termination_date?: string; exercise_window_days?: number }>(event)

  const g = db().prepare('SELECT * FROM grants WHERE id = ?').get(id) as any
  if (!g) throw createError({ statusCode: 404, message: 'Grant not found' })
  if (g.termination_date) throw createError({ statusCode: 400, message: 'Grant is already terminated' })

  const termDate = (body.termination_date || new Date().toISOString().slice(0, 10)).slice(0, 10)
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(termDate)
  if (!m) throw createError({ statusCode: 400, message: 'invalid termination_date' })
  const termMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const windowDays = Number.isFinite(body.exercise_window_days) && (body.exercise_window_days as number) >= 0
    ? Math.floor(body.exercise_window_days as number)
    : 90

  const issued = grantIssued(g)
  const out = grantOutstanding(g)                          // currently held
  const exercised = g.quantity_exercised || 0
  const vestedOfIssued = Math.floor(issued * vestedFraction(g, termMs))
  const vestedHeld = Math.max(0, Math.min(out, vestedOfIssued - exercised)) // vested still held
  const unvested = out - vestedHeld                        // forfeits now

  const expMs = termMs + windowDays * 86400000
  const expDate = new Date(expMs).toISOString().slice(0, 10)
  const windowClosed = expMs <= Date.now()

  const newForfeited = (g.quantity_forfeited || 0) + unvested
  const newExpired = (g.quantity_expired || 0) + (windowClosed ? vestedHeld : 0)
  const newQuantity = windowClosed ? 0 : vestedHeld

  db().prepare(`
    UPDATE grants SET
      quantity = ?, quantity_issued = ?,
      quantity_forfeited = ?, forfeited_date = ?,
      quantity_expired = ?, expired_date = ?,
      termination_date = ?, exercise_window_days = ?
    WHERE id = ?
  `).run(
    newQuantity, issued,
    newForfeited, termDate,
    newExpired, windowClosed ? expDate : (g.expired_date || null),
    termDate, windowDays,
    id,
  )

  return {
    grant: db().prepare('SELECT * FROM grants WHERE id = ?').get(id),
    summary: { vested_held: vestedHeld, unvested_forfeited: unvested, exercise_window_days: windowDays, expires_on: expDate, window_closed: windowClosed },
  }
})
