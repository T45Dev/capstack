import { db } from '~~/server/utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<{
    round_name?: string
    new_money?: number
    pre_money?: number
    target_pool_pct?: number | null
    pool_top_up_shares?: number
    cn_conversion_basis?: 'round_price' | 'cap' | 'discount'
    notes?: string | null
  }>(event)

  db().prepare(`
    INSERT INTO assumptions (
      company_id, round_name, new_money, pre_money,
      target_pool_pct, pool_top_up_shares, cn_conversion_basis, notes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(company_id) DO UPDATE SET
      round_name = excluded.round_name,
      new_money = excluded.new_money,
      pre_money = excluded.pre_money,
      target_pool_pct = excluded.target_pool_pct,
      pool_top_up_shares = excluded.pool_top_up_shares,
      cn_conversion_basis = excluded.cn_conversion_basis,
      notes = excluded.notes,
      updated_at = datetime('now')
  `).run(
    id,
    body.round_name || 'Series B',
    body.new_money ?? 0,
    body.pre_money ?? 0,
    body.target_pool_pct ?? null,
    body.pool_top_up_shares ?? 0,
    body.cn_conversion_basis || 'round_price',
    body.notes ?? null,
  )

  return db().prepare('SELECT * FROM assumptions WHERE company_id = ?').get(id)
})
