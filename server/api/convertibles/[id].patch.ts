import { db } from '~~/server/utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<Record<string, any>>(event)

  const fields = [
    'stakeholder_name', 'principal', 'interest_accrued', 'interest_rate',
    'issue_date', 'maturity_date', 'conversion_date',
    'valuation_cap', 'conversion_discount', 'conversion_price',
    'destination_class_code',
    'converts_at_round', 'include_in_summary',
    'status', 'external_id', 'stakeholder_id',
  ]
  const boolFields = new Set(['converts_at_round', 'include_in_summary'])
  const updates: string[] = []
  const params: any[] = []
  for (const f of fields) {
    if (f in body) {
      updates.push(`${f} = ?`)
      // Booleans in the request map to 0/1 INTEGER in SQLite.
      params.push(boolFields.has(f) ? (body[f] ? 1 : 0) : body[f])
    }
  }
  if (!updates.length) return db().prepare('SELECT * FROM convertibles WHERE id = ?').get(id)
  params.push(id)
  db().prepare(`UPDATE convertibles SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  return db().prepare('SELECT * FROM convertibles WHERE id = ?').get(id)
})
