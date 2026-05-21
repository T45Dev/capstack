import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const body = await readBody<{
    name: string
    description?: string
    round_name?: string
    new_money?: number
    pre_money?: number
    pool_top_up_shares?: number
    exit_values?: number[]
  }>(event)

  if (!body.name?.trim()) throw createError({ statusCode: 400, message: 'name required' })

  const sid = newId('sc')

  // If no assumptions specified, seed from current assumptions
  let baseline: any = {}
  if (body.new_money == null || body.pre_money == null) {
    baseline = db().prepare('SELECT * FROM assumptions WHERE company_id = ?').get(id) || {}
  }

  db().prepare(`
    INSERT INTO scenarios (
      id, company_id, name, description, round_name,
      new_money, pre_money, pool_top_up_shares, exit_values
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sid,
    id,
    body.name.trim(),
    body.description || null,
    body.round_name || baseline.round_name || 'Series B',
    body.new_money ?? baseline.new_money ?? 0,
    body.pre_money ?? baseline.pre_money ?? 0,
    body.pool_top_up_shares ?? baseline.pool_top_up_shares ?? 0,
    body.exit_values ? JSON.stringify(body.exit_values) : JSON.stringify([100_000_000, 250_000_000, 500_000_000]),
  )

  return db().prepare('SELECT * FROM scenarios WHERE id = ?').get(sid)
})
