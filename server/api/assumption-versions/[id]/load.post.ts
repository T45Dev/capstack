import { db } from '~~/server/utils/db'

// Copy a saved version back into the working assumptions row.
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const v = db().prepare('SELECT * FROM assumption_versions WHERE id = ?').get(id) as any
  if (!v) throw createError({ statusCode: 404, message: 'Version not found' })

  db().prepare(`
    INSERT INTO assumptions (
      company_id, round_name, new_money, pre_money, pre_round_fds,
      target_pool_pct, pool_top_up_shares, cn_conversion_basis, notes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(company_id) DO UPDATE SET
      round_name = excluded.round_name,
      new_money = excluded.new_money,
      pre_money = excluded.pre_money,
      pre_round_fds = excluded.pre_round_fds,
      target_pool_pct = excluded.target_pool_pct,
      pool_top_up_shares = excluded.pool_top_up_shares,
      cn_conversion_basis = excluded.cn_conversion_basis,
      notes = excluded.notes,
      updated_at = datetime('now')
  `).run(
    v.company_id,
    v.round_name, v.new_money, v.pre_money, v.pre_round_fds,
    v.target_pool_pct, v.pool_top_up_shares, v.cn_conversion_basis, v.notes,
  )

  return db().prepare('SELECT * FROM assumptions WHERE company_id = ?').get(v.company_id)
})
