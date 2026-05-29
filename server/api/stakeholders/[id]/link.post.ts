import { db } from '~~/server/utils/db'

// Link a stakeholder to another as an alias. Body: { linked_to: id | null }.
// Passing null unlinks. Both stakeholders must belong to the same company.
//
// Guard against cycles: refuse to link A → B if B already chains to A.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const body = await readBody<{ linked_to: string | null }>(event)
  const target = body?.linked_to ?? null

  const me = db().prepare(
    'SELECT id, company_id FROM stakeholders WHERE id = ?',
  ).get(id) as { id: string; company_id: string } | undefined
  if (!me) throw createError({ statusCode: 404, message: 'Stakeholder not found' })

  if (target == null) {
    db().prepare('UPDATE stakeholders SET linked_to = NULL WHERE id = ?').run(id)
    return { ok: true, linked_to: null }
  }

  if (target === id) {
    throw createError({ statusCode: 400, message: 'A stakeholder cannot link to itself' })
  }

  const dest = db().prepare(
    'SELECT id, company_id, linked_to FROM stakeholders WHERE id = ?',
  ).get(target) as { id: string; company_id: string; linked_to: string | null } | undefined
  if (!dest) throw createError({ statusCode: 404, message: 'Target stakeholder not found' })
  if (dest.company_id !== me.company_id) {
    throw createError({ statusCode: 400, message: 'Target belongs to a different company' })
  }

  // Cycle check: walk the target's chain; if we ever reach `me`, refuse.
  let cur: string | null = dest.linked_to
  let depth = 0
  while (cur && depth < 10) {
    if (cur === id) {
      throw createError({ statusCode: 400, message: 'Linking would create a cycle' })
    }
    const row = db().prepare('SELECT linked_to FROM stakeholders WHERE id = ?').get(cur) as { linked_to: string | null } | undefined
    cur = row?.linked_to ?? null
    depth++
  }

  // If our own row currently has aliases pointing AT us, reparent them
  // to the new primary so the chain stays flat.
  db().prepare('UPDATE stakeholders SET linked_to = ? WHERE linked_to = ?').run(target, id)
  db().prepare('UPDATE stakeholders SET linked_to = ? WHERE id = ?').run(target, id)

  return { ok: true, linked_to: target }
})
