import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'

// Demote a proposed grant to a pool "idea" (an anonymous future-grant event on
// the Option Pool Impact timeline). The inverse of promoting an idea to a real
// proposed grant. Carries the grant's identity across — name, shares,
// vest/cliff, role, award type, notes — then deletes the grant so it stops
// counting as a live proposal. Atomic: either both happen or neither.
//
// Award type maps to the idea's `kind` (ISO/NSO); RSU has no pool-event kind so
// it lands as null. The idea is dated off the grant's vesting/issue date.
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const grant = db().prepare('SELECT * FROM grants WHERE id = ?').get(id) as any
  if (!grant) throw createError({ statusCode: 404, message: 'Grant not found' })
  if (grant.status === 'outstanding') {
    throw createError({ statusCode: 400, message: 'Only proposed grants can be demoted to an idea' })
  }

  const today = new Date().toISOString().slice(0, 10)
  const eventDate = (grant.vesting_start || grant.issue_date || today).slice(0, 10)
  const kind = grant.award_type === 'ISO' || grant.award_type === 'NSO' ? grant.award_type : null
  const eid = newId('pe')

  const tx = db().transaction(() => {
    db().prepare(`
      INSERT INTO pool_events (
        id, company_id, event_date, type, name, kind, shares,
        vest_months, cliff_months, notes, job_title, job_level, recipient_type
      ) VALUES (?, ?, ?, 'grant', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eid,
      grant.company_id,
      eventDate,
      grant.recipient_name || 'Idea',
      kind,
      Math.max(1, Math.floor(grant.quantity || 0)),
      grant.vest_months ?? 48,
      grant.cliff_months ?? 12,
      grant.notes || null,
      grant.job_title || null,
      grant.job_level || null,
      grant.recipient_type || null,
    )
    db().prepare('DELETE FROM grants WHERE id = ?').run(id)
  })
  tx()

  return { ok: true, pool_event_id: eid }
})
