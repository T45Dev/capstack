import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'

// Create an explicit, named version snapshotting the current working assumptions row.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const body = await readBody<{ label?: string }>(event)
  const label = body?.label?.trim() || `Snapshot ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`

  const current = db().prepare('SELECT * FROM assumptions WHERE company_id = ?').get(id) as any
  if (!current) throw createError({ statusCode: 404, message: 'No working assumptions to snapshot' })

  const vid = newId('av')
  db().prepare(`
    INSERT INTO assumption_versions (
      id, company_id, label, is_auto, round_name, new_money, pre_money, pre_round_fds,
      target_pool_pct, pool_top_up_shares, cn_conversion_basis, notes
    ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    vid, id, label,
    current.round_name, current.new_money, current.pre_money, current.pre_round_fds,
    current.target_pool_pct, current.pool_top_up_shares, current.cn_conversion_basis, current.notes,
  )

  return db().prepare('SELECT * FROM assumption_versions WHERE id = ?').get(vid)
})
