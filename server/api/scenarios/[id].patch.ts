import { db } from '~~/server/utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<Record<string, any>>(event)

  const fields = ['name', 'description', 'round_name', 'new_money', 'pre_money', 'pool_top_up_shares', 'exit_values']
  const updates: string[] = []
  const params: any[] = []
  for (const f of fields) {
    if (f in body) {
      updates.push(`${f} = ?`)
      params.push(f === 'exit_values' && Array.isArray(body[f]) ? JSON.stringify(body[f]) : body[f])
    }
  }
  if (!updates.length) return db().prepare('SELECT * FROM scenarios WHERE id = ?').get(id)
  updates.push("updated_at = datetime('now')")
  params.push(id)
  db().prepare(`UPDATE scenarios SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  return db().prepare('SELECT * FROM scenarios WHERE id = ?').get(id)
})
