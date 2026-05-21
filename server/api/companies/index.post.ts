import { db } from '~~/server/utils/db'
import { newId, slugify } from '~~/server/utils/ids'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name: string; ticker?: string; formation_date?: string }>(event)
  if (!body?.name?.trim()) throw createError({ statusCode: 400, message: 'name is required' })

  const id = newId('co')
  let slug = slugify(body.name)
  if (!slug) slug = id
  // Ensure uniqueness
  let candidate = slug
  let i = 2
  while (db().prepare('SELECT 1 FROM companies WHERE slug = ?').get(candidate)) {
    candidate = `${slug}-${i++}`
  }

  db().prepare(`
    INSERT INTO companies (id, name, slug, ticker, formation_date)
    VALUES (@id, @name, @slug, @ticker, @formation_date)
  `).run({
    id,
    name: body.name.trim(),
    slug: candidate,
    ticker: body.ticker?.trim() || null,
    formation_date: body.formation_date || null,
  })

  // Seed default assumptions
  db().prepare(`
    INSERT INTO assumptions (company_id, round_name, new_money, pre_money)
    VALUES (?, 'Series B', 0, 0)
  `).run(id)

  return db().prepare('SELECT * FROM companies WHERE id = ?').get(id)
})
