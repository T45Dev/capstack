import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<{ as_of_date?: string; label?: string | null; fds?: number | null; pps?: number | null }>(event)
  if (!body?.as_of_date) throw createError({ statusCode: 400, message: 'as_of_date required' })
  const mid = newId('ms')
  db().prepare(`
    INSERT INTO cap_table_milestones (id, company_id, as_of_date, label, fds, pps)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(mid, id, body.as_of_date, body.label?.trim() || null, body.fds ?? null, body.pps ?? null)
  return db().prepare('SELECT id, as_of_date, label, fds, pps FROM cap_table_milestones WHERE id = ?').get(mid)
})
