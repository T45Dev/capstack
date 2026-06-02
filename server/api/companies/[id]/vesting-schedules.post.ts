import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'

const CADENCES = new Set(['monthly', 'quarterly', 'annual'])

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<{
    name?: string
    vest_months?: number
    cliff_months?: number
    cadence?: string
  }>(event)

  const name = (body.name || '').trim()
  if (!name) throw createError({ statusCode: 400, message: 'name required' })
  const cadence = CADENCES.has(body.cadence || '') ? body.cadence! : 'monthly'

  const schedId = newId('vs')
  db().prepare(`
    INSERT INTO vesting_schedules (id, company_id, name, vest_months, cliff_months, cadence)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    schedId,
    id,
    name,
    Math.max(0, Math.round(body.vest_months ?? 48)),
    Math.max(0, Math.round(body.cliff_months ?? 12)),
    cadence,
  )
  return db().prepare('SELECT * FROM vesting_schedules WHERE id = ?').get(schedId)
})
