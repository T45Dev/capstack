import { db } from '~~/server/utils/db'

// Update a per-round investor allocation. Used by the matrix UI when the
// operator types a different $ amount or adjusts notes.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const body = await readBody<Record<string, any>>(event)
  const fields = ['amount', 'notes']
  const updates: string[] = []
  const params: any[] = []
  for (const f of fields) {
    if (f in body) {
      updates.push(`${f} = ?`)
      params.push(body[f] === '' ? null : body[f])
    }
  }
  if (!updates.length) return db().prepare('SELECT * FROM round_investors WHERE id = ?').get(id)
  params.push(id)
  db().prepare(`UPDATE round_investors SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  return db().prepare('SELECT * FROM round_investors WHERE id = ?').get(id)
})
