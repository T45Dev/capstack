import { db } from '~~/server/utils/db'
import { CANONICAL_GRANT_FIELDS, type GrantField } from '~~/server/parsers/grants-smart'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const body = await readBody<{ mappings?: Partial<Record<GrantField, string>> }>(event)

  // Keep only known canonical fields with non-empty string headers.
  const allowed = new Set(CANONICAL_GRANT_FIELDS.map(f => f.field))
  const clean: Partial<Record<GrantField, string>> = {}
  for (const [k, v] of Object.entries(body.mappings || {})) {
    if (allowed.has(k as GrantField) && typeof v === 'string' && v.trim()) {
      clean[k as GrantField] = v.trim()
    }
  }

  db().prepare(`
    INSERT INTO grant_settings (company_id, import_mappings, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(company_id) DO UPDATE SET import_mappings = excluded.import_mappings, updated_at = datetime('now')
  `).run(id, JSON.stringify(clean))

  return { ok: true }
})
