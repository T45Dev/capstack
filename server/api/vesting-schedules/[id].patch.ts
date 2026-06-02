import { db } from '~~/server/utils/db'

const CADENCES = new Set(['monthly', 'quarterly', 'annual'])

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<Record<string, any>>(event)

  const updates: string[] = []
  const params: any[] = []
  if ('name' in body) {
    const name = String(body.name || '').trim()
    if (!name) throw createError({ statusCode: 400, message: 'name cannot be empty' })
    updates.push('name = ?'); params.push(name)
  }
  if ('vest_months' in body) { updates.push('vest_months = ?'); params.push(Math.max(0, Math.round(Number(body.vest_months) || 0))) }
  if ('cliff_months' in body) { updates.push('cliff_months = ?'); params.push(Math.max(0, Math.round(Number(body.cliff_months) || 0))) }
  if ('cadence' in body && CADENCES.has(body.cadence)) { updates.push('cadence = ?'); params.push(body.cadence) }

  if (!updates.length) return db().prepare('SELECT * FROM vesting_schedules WHERE id = ?').get(id)
  params.push(id)
  db().prepare(`UPDATE vesting_schedules SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  return db().prepare('SELECT * FROM vesting_schedules WHERE id = ?').get(id)
})
