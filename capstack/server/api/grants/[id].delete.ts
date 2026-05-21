import { db } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const r = db().prepare('DELETE FROM grants WHERE id = ?').run(id)
  return { deleted: r.changes }
})
