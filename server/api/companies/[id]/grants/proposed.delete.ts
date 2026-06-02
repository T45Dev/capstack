import { db } from '~~/server/utils/db'

// Bulk-clear all proposed grants for a company. Used by the "Clear proposed"
// action so the operator can reset the draft list (e.g. after a duplicated
// import) and re-import cleanly. Only touches status='proposed' — outstanding
// and cancelled grants are left alone.
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const r = db().prepare(`DELETE FROM grants WHERE company_id = ? AND status = 'proposed'`).run(id)
  return { deleted: r.changes }
})
