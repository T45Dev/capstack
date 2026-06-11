import { db } from '~~/server/utils/db'

// Remove the Carta-seeded funding rounds. Funding rounds are never imported
// — they're entered by hand on the Rounds page — so any round carrying a
// share_class_code is a legacy import artifact. Hand-entered rounds (no
// share_class_code) and the open round are left untouched. Also clears the
// investor rows tied to the removed rounds.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const co = db().prepare('SELECT id FROM companies WHERE id = ?').get(id)
  if (!co) throw createError({ statusCode: 404, message: 'Company not found' })

  const run = db().transaction(() => {
    const n = (db().prepare(
      `SELECT COUNT(*) AS c FROM rounds WHERE company_id = ? AND share_class_code IS NOT NULL`,
    ).get(id) as { c: number }).c
    db().prepare(`DELETE FROM round_investors WHERE company_id = ? AND round_id IN (
      SELECT id FROM rounds WHERE company_id = ? AND share_class_code IS NOT NULL
    )`).run(id, id)
    db().prepare(`DELETE FROM rounds WHERE company_id = ? AND share_class_code IS NOT NULL`).run(id)
    return n
  })

  return { removed: run(), ok: true }
})
