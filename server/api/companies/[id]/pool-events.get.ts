import { db } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  return db().prepare(`
    SELECT id, event_date, type, name, kind, shares, vest_months, cliff_months, notes, created_at
    FROM pool_events
    WHERE company_id = ?
    ORDER BY event_date ASC, created_at ASC
  `).all(id)
})
