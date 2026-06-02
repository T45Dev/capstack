import { db } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  // Detach any grants pointing at this schedule so they don't dangle. Their
  // snapshotted vest_months/cliff_months are preserved.
  db().prepare('UPDATE grants SET vesting_schedule_id = NULL WHERE vesting_schedule_id = ?').run(id)
  db().prepare('DELETE FROM vesting_schedules WHERE id = ?').run(id)
  return { ok: true }
})
