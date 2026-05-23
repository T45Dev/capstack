import { db } from '~~/server/utils/db'

// Partial update for a round row. Used by the Cap Table Summary card to let
// the user override the imported close_date (and a few other manually
// adjustable fields) without re-running the importer.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<Record<string, any>>(event)

  const fields = [
    'name', 'kind', 'close_date', 'share_class_code',
    'share_price', 'new_money', 'debt_canceled', 'seniority', 'notes',
  ]
  const updates: string[] = []
  const params: any[] = []
  for (const f of fields) {
    if (f in body) {
      updates.push(`${f} = ?`)
      // Normalize empty strings on text fields to null so a cleared input
      // doesn't leave a literal "" behind.
      const v = body[f]
      params.push(v === '' ? null : v)
    }
  }
  if (!updates.length) return db().prepare('SELECT * FROM rounds WHERE id = ?').get(id)
  params.push(id)
  db().prepare(`UPDATE rounds SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  return db().prepare('SELECT * FROM rounds WHERE id = ?').get(id)
})
