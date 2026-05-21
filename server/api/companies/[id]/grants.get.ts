import { db } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const grants = db().prepare(`
    SELECT g.*, s.name AS linked_stakeholder
    FROM grants g
    LEFT JOIN stakeholders s ON s.id = g.stakeholder_id
    WHERE g.company_id = ?
    ORDER BY g.status ASC, g.created_at DESC
  `).all(id)

  const pools = db().prepare(`
    SELECT * FROM option_pools WHERE company_id = ?
  `).all(id)

  return { grants, pools }
})
