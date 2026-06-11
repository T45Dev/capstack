import { db } from '~~/server/utils/db'
import { newId, slugify } from '~~/server/utils/ids'

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    name: string
    ticker?: string
    formation_date?: string
    starting_round?: string
    starting_round_date?: string
  }>(event)
  if (!body?.name?.trim()) throw createError({ statusCode: 400, message: 'name is required' })

  // Prevent duplicate companies (case-insensitive, trimmed). The slug is
  // de-duped below, but two workspaces sharing a display name is confusing —
  // reject it up front.
  const dupe = db().prepare('SELECT 1 FROM companies WHERE LOWER(name) = LOWER(?)').get(body.name.trim())
  if (dupe) throw createError({ statusCode: 409, message: `A company named "${body.name.trim()}" already exists.` })

  const id = newId('co')
  let slug = slugify(body.name)
  if (!slug) slug = id
  let candidate = slug
  let i = 2
  while (db().prepare('SELECT 1 FROM companies WHERE slug = ?').get(candidate)) {
    candidate = `${slug}-${i++}`
  }

  db().prepare(`
    INSERT INTO companies (id, name, slug, ticker, formation_date, starting_round, starting_round_date)
    VALUES (@id, @name, @slug, @ticker, @formation_date, @starting_round, @starting_round_date)
  `).run({
    id,
    name: body.name.trim(),
    slug: candidate,
    ticker: body.ticker?.trim() || null,
    formation_date: body.formation_date || null,
    starting_round: body.starting_round?.trim() || null,
    starting_round_date: body.starting_round_date || null,
  })

  // Seed default assumptions, using the picked starting round as the round_name
  // so the user lands on a sensible baseline.
  db().prepare(`
    INSERT INTO assumptions (company_id, round_name, new_money, pre_money)
    VALUES (?, ?, 0, 0)
  `).run(id, body.starting_round?.trim() || 'Series B')

  return db().prepare('SELECT * FROM companies WHERE id = ?').get(id)
})
