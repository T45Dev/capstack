import { db } from '~~/server/utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<Record<string, any>>(event)

  const fields = [
    'stakeholder_name', 'principal', 'interest_accrued', 'interest_rate',
    'issue_date', 'maturity_date', 'conversion_date',
    'valuation_cap', 'conversion_discount', 'conversion_price',
    'destination_class_code',
    'converts_at_round', 'include_in_summary',
    'financing_stage_code',
    'status', 'external_id', 'stakeholder_id',
  ]
  const boolFields = new Set(['converts_at_round', 'include_in_summary'])

  // Snapshot the old destination so we can also unlock the round the CN is
  // LEAVING (not just the one it's joining) when destination_class_code
  // changes.
  const before = db().prepare(
    'SELECT company_id, destination_class_code FROM convertibles WHERE id = ?',
  ).get(id) as { company_id: string; destination_class_code: string | null } | undefined

  const updates: string[] = []
  const params: any[] = []
  for (const f of fields) {
    if (f in body) {
      updates.push(`${f} = ?`)
      // Booleans in the request map to 0/1 INTEGER in SQLite.
      params.push(boolFields.has(f) ? (body[f] ? 1 : 0) : body[f])
    }
  }
  if (!updates.length) return db().prepare('SELECT * FROM convertibles WHERE id = ?').get(id)
  params.push(id)
  db().prepare(`UPDATE convertibles SET ${updates.join(', ')} WHERE id = ?`).run(...params)

  // The setup wizard pins notes_converted_override on each round at import
  // so the cap table matches Carta's snapshot exactly. That override silently
  // wins over the engine's CN-derived cnShares — which means editing a CN's
  // destination here would otherwise have no visible effect on the rounds it
  // touches. Clear the override on the old AND new destination rounds so the
  // engine re-derives from the post-edit CN attributions.
  if (before && 'destination_class_code' in body) {
    const clear = (code: string | null) => {
      if (!code) return
      const c = String(code).replace(/-\d+$/, '').toUpperCase()
      db().prepare(`
        UPDATE rounds SET notes_converted_override = NULL
        WHERE company_id = ?
          AND (UPPER(code) = ? OR UPPER(share_class_code) = ?)
      `).run(before.company_id, c, c)
    }
    clear(before.destination_class_code)
    clear(body.destination_class_code)
  }

  return db().prepare('SELECT * FROM convertibles WHERE id = ?').get(id)
})

