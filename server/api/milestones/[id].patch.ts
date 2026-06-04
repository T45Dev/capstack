import { db } from '~~/server/utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<Record<string, any>>(event)

  const fields = ['as_of_date', 'label', 'fds', 'pps', 'option_pool']
  const updates: string[] = []
  const params: any[] = []
  for (const f of fields) {
    if (f in body) {
      updates.push(`${f} = ?`)
      const v = body[f]
      if (f === 'fds' || f === 'pps' || f === 'option_pool') {
        const n = v == null || v === '' ? null : Number(String(v).replace(/[$,\s]/g, ''))
        params.push(n != null && Number.isFinite(n) ? n : null)
      } else {
        params.push(v === '' || v == null ? null : String(v).trim())
      }
    }
  }
  if (!updates.length) return db().prepare('SELECT * FROM cap_table_milestones WHERE id = ?').get(id)
  params.push(id)
  db().prepare(`UPDATE cap_table_milestones SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  return db().prepare('SELECT id, as_of_date, label, fds, pps, option_pool FROM cap_table_milestones WHERE id = ?').get(id)
})
