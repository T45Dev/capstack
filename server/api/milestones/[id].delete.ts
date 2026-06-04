import { db } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  db().prepare('DELETE FROM cap_table_milestones WHERE id = ?').run(id)
  return { ok: true }
})
