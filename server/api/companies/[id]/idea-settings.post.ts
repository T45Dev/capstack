import { db } from '~~/server/utils/db'
import { CANONICAL_IDEA_FIELDS, type IdeaField } from '~~/server/parsers/ideas-smart'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<{ mappings?: Partial<Record<IdeaField, string>> }>(event)

  const allowed = new Set(CANONICAL_IDEA_FIELDS.map(f => f.field))
  const clean: Partial<Record<IdeaField, string>> = {}
  for (const [k, v] of Object.entries(body.mappings || {})) {
    if (allowed.has(k as IdeaField) && typeof v === 'string' && v.trim()) {
      clean[k as IdeaField] = v.trim()
    }
  }

  // Upsert onto the shared grant_settings row, leaving grants import_mappings
  // untouched.
  db().prepare(`
    INSERT INTO grant_settings (company_id, idea_import_mappings, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(company_id) DO UPDATE SET idea_import_mappings = excluded.idea_import_mappings, updated_at = datetime('now')
  `).run(id, JSON.stringify(clean))

  return { ok: true }
})
