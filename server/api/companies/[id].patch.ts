import { db } from '~~/server/utils/db'

// Partial update for a company. Used by the workspace breadcrumb to switch
// the "Most Recently Closed Round" (companies.starting_round) — the pre-
// baseline that drives compute math. Add more fields here as needed.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const body = (await readBody<Partial<{
    name: string
    ticker: string | null
    formation_date: string | null
    starting_round: string | null
    starting_round_date: string | null
  }>>(event)) || {}

  const existing = db().prepare('SELECT * FROM companies WHERE id = ?').get(id) as any
  if (!existing) throw createError({ statusCode: 404, message: 'Company not found' })

  // Renaming: reject a name already used by another company (case-insensitive).
  if (body.name !== undefined) {
    const trimmed = (body.name || '').trim()
    if (!trimmed) throw createError({ statusCode: 400, message: 'name cannot be empty' })
    if (trimmed.toLowerCase() !== String(existing.name).toLowerCase()) {
      const dupe = db().prepare('SELECT 1 FROM companies WHERE LOWER(name) = LOWER(?) AND id != ?').get(trimmed, id)
      if (dupe) throw createError({ statusCode: 409, message: `A company named "${trimmed}" already exists.` })
    }
  }

  const next = {
    name: body.name !== undefined ? (body.name || '').trim() : existing.name,
    ticker: body.ticker !== undefined ? body.ticker : existing.ticker,
    formation_date: body.formation_date !== undefined ? body.formation_date : existing.formation_date,
    starting_round: body.starting_round !== undefined ? (body.starting_round || null) : existing.starting_round,
    starting_round_date: body.starting_round_date !== undefined ? body.starting_round_date : existing.starting_round_date,
  }

  db().prepare(`
    UPDATE companies
    SET name = @name,
        ticker = @ticker,
        formation_date = @formation_date,
        starting_round = @starting_round,
        starting_round_date = @starting_round_date
    WHERE id = @id
  `).run({ id, ...next })

  return db().prepare('SELECT * FROM companies WHERE id = ?').get(id)
})
