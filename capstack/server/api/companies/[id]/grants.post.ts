import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const body = await readBody<{
    recipient_name: string
    recipient_type?: string
    round?: string
    quantity: number
    strike?: number
    issue_date?: string
    vesting_start?: string
    vest_months?: number
    cliff_months?: number
    status?: 'outstanding' | 'proposed' | 'cancelled'
    stakeholder_id?: string
    notes?: string
  }>(event)

  if (!body.recipient_name?.trim()) throw createError({ statusCode: 400, message: 'recipient_name required' })
  if (!body.quantity || body.quantity <= 0) throw createError({ statusCode: 400, message: 'quantity must be > 0' })

  const grantId = newId('gr')

  let stakeholderId = body.stakeholder_id || null
  if (!stakeholderId) {
    // Try matching by name
    const existing = db().prepare('SELECT id FROM stakeholders WHERE company_id = ? AND name = ?')
      .get(id, body.recipient_name.trim()) as { id: string } | undefined
    stakeholderId = existing?.id || null
  }

  db().prepare(`
    INSERT INTO grants (
      id, company_id, stakeholder_id, recipient_name, recipient_type, round, quantity, strike,
      issue_date, vesting_start, vest_months, cliff_months, status, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    grantId,
    id,
    stakeholderId,
    body.recipient_name.trim(),
    body.recipient_type || null,
    body.round || null,
    Math.round(body.quantity),
    body.strike ?? null,
    body.issue_date || null,
    body.vesting_start || null,
    body.vest_months ?? 48,
    body.cliff_months ?? 12,
    body.status || 'proposed',
    body.notes || null,
  )

  return db().prepare('SELECT * FROM grants WHERE id = ?').get(grantId)
})
