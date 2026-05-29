import { db } from '~~/server/utils/db'

// Partial update for a round row. Used by the Cap Table Summary card to let
// the user override the imported close_date (and a few other manually
// adjustable fields) without re-running the importer.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<Record<string, any>>(event)

  const fields = [
    'code', 'name', 'kind', 'close_date', 'share_class_code',
    'share_price', 'new_money', 'debt_canceled', 'option_pool_issued',
    'pre_money', 'preferred_issued', 'preferred_issued_override', 'common',
    'notes_converted_override', 'total_shares_fds_override',
    'parent_round_code', 'seniority', 'notes',
    // liq pref terms — drive exit waterfall
    'liq_pref_multiple', 'participation', 'participation_cap', 'pref_tier',
  ]
  // Columns with NOT NULL DEFAULT 0 in the rounds schema. The card sends
  // its full body on Save; an "unfilled" number field arrives as null,
  // and naively writing null would violate the constraint and fail the
  // whole PATCH. Coerce these to 0 when the body explicitly nulls them.
  const numericNotNull = new Set([
    'new_money', 'debt_canceled', 'option_pool_issued',
    'preferred_issued', 'common', 'liq_pref_multiple',
    'pref_tier', 'seniority',
  ])
  const updates: string[] = []
  const params: any[] = []
  for (const f of fields) {
    if (f in body) {
      updates.push(`${f} = ?`)
      let v = body[f]
      // Normalize empty strings on text fields to null so a cleared input
      // doesn't leave a literal "" behind.
      if (v === '') v = null
      if (v == null && numericNotNull.has(f)) v = 0
      params.push(v)
    }
  }
  if (!updates.length) return db().prepare('SELECT * FROM rounds WHERE id = ?').get(id)
  params.push(id)
  db().prepare(`UPDATE rounds SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  return db().prepare('SELECT * FROM rounds WHERE id = ?').get(id)
})
