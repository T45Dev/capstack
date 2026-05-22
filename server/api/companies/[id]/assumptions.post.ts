import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<{
    round_name?: string
    round_close_date?: string | null
    new_money?: number
    pre_money?: number
    pre_round_fds?: number | null
    target_pool_pct?: number | null
    pool_top_up_shares?: number
    cn_conversion_basis?: 'best' | 'round_price' | 'cap' | 'discount'
    notes?: string | null
  }>(event)

  // Capture the previous values so we can auto-snapshot when something
  // meaningful changed.
  const prev = db().prepare('SELECT * FROM assumptions WHERE company_id = ?').get(id) as any

  db().prepare(`
    INSERT INTO assumptions (
      company_id, round_name, round_close_date, new_money, pre_money, pre_round_fds,
      target_pool_pct, pool_top_up_shares, cn_conversion_basis, notes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(company_id) DO UPDATE SET
      round_name = excluded.round_name,
      round_close_date = excluded.round_close_date,
      new_money = excluded.new_money,
      pre_money = excluded.pre_money,
      pre_round_fds = excluded.pre_round_fds,
      target_pool_pct = excluded.target_pool_pct,
      pool_top_up_shares = excluded.pool_top_up_shares,
      cn_conversion_basis = excluded.cn_conversion_basis,
      notes = excluded.notes,
      updated_at = datetime('now')
  `).run(
    id,
    body.round_name || 'Series B',
    body.round_close_date || null,
    body.new_money ?? 0,
    body.pre_money ?? 0,
    body.pre_round_fds ?? null,
    body.target_pool_pct ?? null,
    body.pool_top_up_shares ?? 0,
    body.cn_conversion_basis || 'best',
    body.notes ?? null,
  )

  // Auto-snapshot the *previous* state into the version history, but only
  // when the numeric/decision fields actually changed. Avoids spamming history
  // with notes-only edits.
  if (prev) {
    const changed =
      (prev.round_name || '') !== (body.round_name || 'Series B') ||
      (prev.round_close_date || null) !== (body.round_close_date || null) ||
      Number(prev.new_money ?? 0) !== Number(body.new_money ?? 0) ||
      Number(prev.pre_money ?? 0) !== Number(body.pre_money ?? 0) ||
      (prev.pre_round_fds ?? null) !== (body.pre_round_fds ?? null) ||
      Number(prev.pool_top_up_shares ?? 0) !== Number(body.pool_top_up_shares ?? 0) ||
      (prev.cn_conversion_basis || 'best') !== (body.cn_conversion_basis || 'best')
    if (changed) {
      db().prepare(`
        INSERT INTO assumption_versions (
          id, company_id, label, is_auto, round_name, new_money, pre_money, pre_round_fds,
          target_pool_pct, pool_top_up_shares, cn_conversion_basis, notes
        ) VALUES (?, ?, NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newId('av'), id,
        prev.round_name, prev.new_money, prev.pre_money, prev.pre_round_fds,
        prev.target_pool_pct, prev.pool_top_up_shares, prev.cn_conversion_basis, prev.notes,
      )
    }
  }

  return db().prepare('SELECT * FROM assumptions WHERE company_id = ?').get(id)
})
