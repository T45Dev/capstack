import { db } from '~~/server/utils/db'
import { grantIssued, grantOutstanding } from '~~/shared/capTableModel'

// Exercise part or all of a grant. Exercised options convert to common stock:
// quantity_exercised grows, outstanding (quantity) shrinks by the same amount.
// They were carved out of the pool at issuance and do NOT return — so the pool
// timeline shows the exercise as a zero-direction event (informational), while
// Available = Authorized − Outstanding − Exercised stays correct.
//
// Capped at the currently-held outstanding count. Multiple exercises accumulate
// into quantity_exercised and stamp the latest last_exercised_date.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<{ shares?: number; exercise_date?: string }>(event)

  const g = db().prepare('SELECT * FROM grants WHERE id = ?').get(id) as any
  if (!g) throw createError({ statusCode: 404, message: 'Grant not found' })

  const out = grantOutstanding(g)
  let shares = Math.floor(Number(body.shares) || 0)
  if (shares <= 0) throw createError({ statusCode: 400, message: 'shares must be > 0' })
  if (shares > out) shares = out // can't exercise more than is held
  const exDate = (body.exercise_date || new Date().toISOString().slice(0, 10)).slice(0, 10)

  const issued = grantIssued(g)
  const newExercised = (g.quantity_exercised || 0) + shares
  const newQuantity = out - shares

  db().prepare(`
    UPDATE grants SET quantity = ?, quantity_issued = ?, quantity_exercised = ?, last_exercised_date = ?
    WHERE id = ?
  `).run(newQuantity, issued, newExercised, exDate, id)

  return {
    grant: db().prepare('SELECT * FROM grants WHERE id = ?').get(id),
    summary: { exercised: shares, total_exercised: newExercised, outstanding: newQuantity },
  }
})
