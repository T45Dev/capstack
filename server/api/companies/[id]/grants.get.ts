import { db } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const grants = db().prepare(`
    SELECT g.*, s.name AS linked_stakeholder, vs.name AS vesting_schedule_name
    FROM grants g
    LEFT JOIN stakeholders s ON s.id = g.stakeholder_id
    LEFT JOIN vesting_schedules vs ON vs.id = g.vesting_schedule_id
    WHERE g.company_id = ?
    ORDER BY g.status ASC, g.created_at DESC
  `).all(id)

  const pools = db().prepare(`
    SELECT * FROM option_pools WHERE company_id = ?
  `).all(id)

  return { grants, pools }
})
