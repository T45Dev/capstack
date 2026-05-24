import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'

// Add a per-investor allocation to a round. Body accepts either an existing
// stakeholder_id or a new stakeholder_name (in which case we create the
// stakeholder on the fly so the user can just type a name into the matrix
// and have it stick).
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const round = db().prepare('SELECT id, company_id FROM rounds WHERE id = ?').get(id) as any
  if (!round) throw createError({ statusCode: 404, message: 'Round not found' })

  const body = (await readBody<Partial<{
    stakeholder_id: string
    stakeholder_name: string
    stakeholder_type: string
    amount: number
    notes: string | null
  }>>(event)) || {}

  let stakeholderId = body.stakeholder_id || ''
  if (!stakeholderId) {
    const name = (body.stakeholder_name || '').trim()
    if (!name) throw createError({ statusCode: 400, message: 'stakeholder_id or stakeholder_name required' })
    // Try matching an existing stakeholder by name (case-insensitive) so
    // typing "VCT Investments" twice doesn't create two of them.
    const existing = db().prepare(
      'SELECT id FROM stakeholders WHERE company_id = ? AND LOWER(name) = LOWER(?)'
    ).get(round.company_id, name) as { id: string } | undefined
    if (existing) {
      stakeholderId = existing.id
    } else {
      stakeholderId = newId('st')
      db().prepare(
        'INSERT INTO stakeholders (id, company_id, name, type) VALUES (?, ?, ?, ?)'
      ).run(stakeholderId, round.company_id, name, body.stakeholder_type || 'Investor')
    }
  }

  // Idempotent upsert — if this stakeholder already has an allocation in
  // this round, treat the call as an update instead of a 409. Matches the
  // matrix UX where typing into an existing cell shouldn't fail.
  const existingAlloc = db().prepare(
    'SELECT id FROM round_investors WHERE round_id = ? AND stakeholder_id = ?'
  ).get(id, stakeholderId) as { id: string } | undefined

  if (existingAlloc) {
    db().prepare(
      'UPDATE round_investors SET amount = ?, notes = ? WHERE id = ?'
    ).run(body.amount ?? 0, body.notes ?? null, existingAlloc.id)
    return db().prepare('SELECT * FROM round_investors WHERE id = ?').get(existingAlloc.id)
  }

  const riId = newId('ri')
  db().prepare(`
    INSERT INTO round_investors (id, company_id, round_id, stakeholder_id, amount, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(riId, round.company_id, id, stakeholderId, body.amount ?? 0, body.notes ?? null)

  return db().prepare('SELECT * FROM round_investors WHERE id = ?').get(riId)
})
