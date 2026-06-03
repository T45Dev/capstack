import { db } from '~~/server/utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<Record<string, any>>(event)

  const fields = ['event_date', 'type', 'name', 'kind', 'shares', 'vest_months', 'cliff_months', 'notes', 'job_title', 'job_level']
  const updates: string[] = []
  const params: any[] = []
  for (const f of fields) {
    if (f in body) {
      updates.push(`${f} = ?`)
      params.push(body[f])
    }
  }
  if (!updates.length) return db().prepare('SELECT * FROM pool_events WHERE id = ?').get(id)
  params.push(id)
  db().prepare(`UPDATE pool_events SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  return db().prepare('SELECT * FROM pool_events WHERE id = ?').get(id)
})
