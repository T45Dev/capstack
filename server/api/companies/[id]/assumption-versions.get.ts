import { db } from '~~/server/utils/db'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  return db().prepare(`
    SELECT id, label, is_auto, round_name, new_money, pre_money, pre_round_fds,
           target_pool_pct, pool_top_up_shares, cn_conversion_basis, notes, created_at
    FROM assumption_versions
    WHERE company_id = ?
    ORDER BY created_at DESC
  `).all(id)
})
