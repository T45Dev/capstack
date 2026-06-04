import { db } from '~~/server/utils/db'

// Cap-table FDS/PPS milestones (the hire-basis timeline), oldest first.
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  return db().prepare(`
    SELECT id, as_of_date, label, fds, pps, option_pool
    FROM cap_table_milestones
    WHERE company_id = ?
    ORDER BY as_of_date ASC, created_at ASC
  `).all(id)
})
