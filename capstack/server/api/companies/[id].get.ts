import { db } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const row = db().prepare('SELECT * FROM companies WHERE id = ?').get(id)
  if (!row) throw createError({ statusCode: 404, message: 'Company not found' })
  return row
})
