import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'

// Create a new manually-entered round on the Summary card. The user types
// everything (code, name, close_date, pre_money, share_price, etc.); the
// importer no longer seeds rounds.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const co = db().prepare('SELECT id FROM companies WHERE id = ?').get(id)
  if (!co) throw createError({ statusCode: 404, message: 'Company not found' })

  const body = (await readBody<Partial<{
    code: string
    name: string
    kind: 'formation' | 'closed' | 'open'
    close_date: string | null
    share_class_code: string | null
    share_price: number | null
    new_money: number
    debt_canceled: number
    option_pool_issued: number
    pre_money: number | null
    preferred_issued: number
    common: number
    notes: string | null
  }>>(event)) || {}

  // Auto-generate a unique code when the user hasn't provided one.
  let code = (body.code || '').trim()
  if (!code) {
    const existing = db().prepare('SELECT code FROM rounds WHERE company_id = ?').all(id) as Array<{ code: string }>
    let n = existing.length + 1
    while (existing.some(r => r.code === `R${n}`)) n++
    code = `R${n}`
  } else {
    const conflict = db().prepare('SELECT 1 FROM rounds WHERE company_id = ? AND code = ?').get(id, code)
    if (conflict) throw createError({ statusCode: 409, message: `Round code "${code}" already exists.` })
  }

  // Seniority: append at the end (display will sort by close_date).
  const maxSenRow = db().prepare('SELECT COALESCE(MAX(seniority), 0) AS s FROM rounds WHERE company_id = ?').get(id) as { s: number }
  const seniority = (maxSenRow?.s || 0) + 1

  const rdId = newId('rd')
  db().prepare(`
    INSERT INTO rounds (
      id, company_id, code, name, kind, close_date, share_class_code,
      share_price, new_money, debt_canceled, option_pool_issued, pre_money,
      preferred_issued, common, seniority, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rdId, id,
    code,
    body.name || code,
    body.kind || 'closed',
    body.close_date || null,
    body.share_class_code || null,
    body.share_price ?? null,
    body.new_money ?? 0,
    body.debt_canceled ?? 0,
    body.option_pool_issued ?? 0,
    body.pre_money ?? null,
    body.preferred_issued ?? 0,
    body.common ?? 0,
    seniority,
    body.notes || null,
  )

  return db().prepare('SELECT * FROM rounds WHERE id = ?').get(rdId)
})
