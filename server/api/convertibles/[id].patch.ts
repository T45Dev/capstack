import { db } from '~~/server/utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<Record<string, any>>(event)

  const fields = [
    'stakeholder_name', 'principal', 'interest_accrued', 'interest_rate',
    'issue_date', 'maturity_date', 'valuation_cap', 'conversion_discount',
    'converts_at_round', 'status', 'external_id', 'stakeholder_id',
  ]
  const updates: string[] = []
  const params: any[] = []
  for (const f of fields) {
    if (f in body) {
      updates.push(`${f} = ?`)
      // converts_at_round is a boolean in the request but INTEGER in SQLite
      params.push(f === 'converts_at_round' ? (body[f] ? 1 : 0) : body[f])
    }
  }
  if (!updates.length) return db().prepare('SELECT * FROM convertibles WHERE id = ?').get(id)
  params.push(id)
  db().prepare(`UPDATE convertibles SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  return db().prepare('SELECT * FROM convertibles WHERE id = ?').get(id)
})
