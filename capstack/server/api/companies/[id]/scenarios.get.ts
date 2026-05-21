import { db } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  return db().prepare(`
    SELECT * FROM scenarios WHERE company_id = ? ORDER BY created_at DESC
  `).all(id)
})
