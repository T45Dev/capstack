import { db } from '~~/server/utils/db'

// Delete a round (= one row in the Summary card). The user has full control:
// they typed the round in, they can delete it. Any CNs whose
// destination_class_code matches this round's code stay in the convertibles
// table but their attribution becomes orphaned (the CN page will surface
// them as "unattributed" until the user picks a new destination).
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const row = db().prepare('SELECT id FROM rounds WHERE id = ?').get(id)
  if (!row) throw createError({ statusCode: 404, message: 'Round not found' })

  db().prepare('DELETE FROM rounds WHERE id = ?').run(id)
  return { ok: true }
})
