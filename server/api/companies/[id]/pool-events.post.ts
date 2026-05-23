import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'

// Idea event types per spec §5.6. 'grant' and 'pool_topup' are the originals;
// 'exercise' / 'forfeit' / 'floor' / 'reserve' were added when the spec
// formalised the idea sub-types.
type PoolEventType = 'grant' | 'pool_topup' | 'exercise' | 'forfeit' | 'floor' | 'reserve'
const VALID_TYPES: PoolEventType[] = ['grant', 'pool_topup', 'exercise', 'forfeit', 'floor', 'reserve']

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<{
    event_date: string
    type: PoolEventType
    name: string
    kind?: 'ISO' | 'NSO' | null
    shares: number
    vest_months?: number | null
    cliff_months?: number | null
    notes?: string | null
  }>(event)

  if (!body?.event_date) throw createError({ statusCode: 400, message: 'event_date required' })
  if (!body?.type || !VALID_TYPES.includes(body.type)) throw createError({ statusCode: 400, message: `type must be one of ${VALID_TYPES.join(', ')}` })
  if (!body?.name?.trim()) throw createError({ statusCode: 400, message: 'name required' })
  if (!body?.shares || body.shares <= 0) throw createError({ statusCode: 400, message: 'shares must be > 0' })

  const isGrant = body.type === 'grant'
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
    isGrant ? (body.kind || null) : null,
    Math.round(body.shares),
    isGrant ? (body.vest_months ?? 48) : null,
    isGrant ? (body.cliff_months ?? 12) : null,
    body.notes || null,
  )
  return db().prepare('SELECT * FROM pool_events WHERE id = ?').get(eid)
})
