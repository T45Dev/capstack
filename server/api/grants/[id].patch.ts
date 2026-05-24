import { db } from '~~/server/utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<Record<string, any>>(event)

  const fields = [
    'recipient_name', 'recipient_type', 'round', 'quantity', 'strike',
    'issue_date', 'vesting_start', 'vest_months', 'cliff_months', 'status',
    'approval_status', 'notes',
    // Per-grant detail from the Carta option-plan sheet — editable so the
    // operator can correct values if the import misread something.
    'quantity_issued', 'quantity_exercised', 'quantity_forfeited',
    'award_type', 'acceleration',
  ]
  const updates: string[] = []
  const params: any[] = []
  for (const f of fields) {
    if (f in body) {
      updates.push(`${f} = ?`)
      params.push(body[f])
    }
  }
  if (!updates.length) return db().prepare('SELECT * FROM grants WHERE id = ?').get(id)
  params.push(id)
  db().prepare(`UPDATE grants SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  return db().prepare('SELECT * FROM grants WHERE id = ?').get(id)
})
