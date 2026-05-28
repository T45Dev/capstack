import { db } from '~~/server/utils/db'

// Upsert the Previous-Round aggregate. Body is a partial: any field
// omitted (or undefined) is left alone, so the UI can PATCH-like
// behaviour by sending only the changed field per blur.
interface Body {
  pre_money?: number | null
  new_money?: number | null
  share_price?: number | null
  cumulated_financing?: number | null
  total_shares_fds?: number | null
  option_pool_total?: number | null
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const co = db().prepare('SELECT id FROM companies WHERE id = ?').get(id)
  if (!co) throw createError({ statusCode: 404, message: 'Company not found' })

  const body = await readBody<Body>(event)
  const fields: Array<keyof Body> = [
    'pre_money', 'new_money', 'share_price',
    'cumulated_financing', 'total_shares_fds', 'option_pool_total',
  ]

  // Build the SET clause from only the keys that were sent. Sending
  // `null` clears the field; omitting the key leaves it alone.
  const sets: string[] = []
  const vals: Array<number | null> = []
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(body, f)) {
      sets.push(`${f} = ?`)
      vals.push(body[f] ?? null)
    }
  }

  if (sets.length === 0) {
    // Empty PATCH — just upsert an empty row so the company has an
    // aggregate-round record from this point on.
    db().prepare(`
      INSERT INTO aggregate_round (company_id) VALUES (?)
      ON CONFLICT(company_id) DO NOTHING
    `).run(id)
  } else {
    db().prepare(`
      INSERT INTO aggregate_round (company_id, ${fields.filter(f => Object.prototype.hasOwnProperty.call(body, f)).join(', ')}, updated_at)
      VALUES (?, ${sets.map(() => '?').join(', ')}, datetime('now'))
      ON CONFLICT(company_id) DO UPDATE SET
        ${sets.join(', ')},
        updated_at = datetime('now')
    `).run(id, ...vals, ...vals)
  }

  return { ok: true }
})
