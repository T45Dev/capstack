import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<{
    event_date: string
    type: 'grant' | 'pool_topup'
    name: string
    kind?: 'ISO' | 'NSO' | null
    shares: number
    vest_months?: number | null
    cliff_months?: number | null
    notes?: string | null
  }>(event)

  if (!body?.event_date) throw createError({ statusCode: 400, message: 'event_date required' })
  if (!body?.type) throw createError({ statusCode: 400, message: 'type required' })
  if (!body?.name?.trim()) throw createError({ statusCode: 400, message: 'name required' })
  if (!body?.shares || body.shares <= 0) throw createError({ statusCode: 400, message: 'shares must be > 0' })

  const eid = newId('pe')
  db().prepare(`
    INSERT INTO pool_events (
      id, company_id, event_date, type, name, kind, shares, vest_months, cliff_months, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eid, id,
    body.event_date,
    body.type,
    body.name.trim(),
    body.type === 'grant' ? (body.kind || null) : null,
    Math.round(body.shares),
    body.type === 'grant' ? (body.vest_months ?? 48) : null,
    body.type === 'grant' ? (body.cliff_months ?? 12) : null,
    body.notes || null,
  )
  return db().prepare('SELECT * FROM pool_events WHERE id = ?').get(eid)
})
