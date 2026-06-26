import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'

// Promote a pool "idea" (an anonymous future-grant event on the Option Pool
// Impact timeline) back up to a real proposed grant. The inverse of
// demote-to-idea: it carries the idea's identity across — name, shares,
// vest/cliff, role, award type, notes — into a fresh proposed grant, then
// deletes the pool event so the idea stops double-counting. Atomic: either
// both happen or neither.
//
// The idea's `kind` (ISO/NSO) maps back to the grant's award_type; a null kind
// (e.g. a bare 'reserve') leaves award_type null. The idea's event_date seeds
// the grant's vesting_start. Stakeholder is matched by name, mirroring the
// grants.post create path, so a promoted idea links to a real holder when one
// exists.
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const pe = db().prepare('SELECT * FROM pool_events WHERE id = ?').get(id) as any
  if (!pe) throw createError({ statusCode: 404, message: 'Pool event not found' })

  const name = (pe.name || 'Proposed grant').trim()
  const stakeholder = db().prepare('SELECT id FROM stakeholders WHERE company_id = ? AND name = ?')
    .get(pe.company_id, name) as { id: string } | undefined
  const eventDate = (pe.event_date || new Date().toISOString().slice(0, 10)).slice(0, 10)
  const grantId = newId('gr')

  const tx = db().transaction(() => {
    db().prepare(`
      INSERT INTO grants (
        id, company_id, stakeholder_id, recipient_name, recipient_type, quantity,
        vesting_start, vest_months, cliff_months, award_type, job_title, job_level,
        status, approval_status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 'Pending', ?)
    `).run(
      grantId,
      pe.company_id,
      stakeholder?.id || null,
      name,
      pe.recipient_type || null,
      Math.max(1, Math.floor(pe.shares || 0)),
      eventDate,
      pe.vest_months ?? 48,
      pe.cliff_months ?? 12,
      pe.kind || null,
      pe.job_title || null,
      pe.job_level || null,
      pe.notes || null,
    )
    db().prepare('DELETE FROM pool_events WHERE id = ?').run(id)
  })
  tx()

  return { ok: true, grant_id: grantId }
})
