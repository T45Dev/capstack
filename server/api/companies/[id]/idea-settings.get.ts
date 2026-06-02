import { db } from '~~/server/utils/db'
import { CANONICAL_IDEA_FIELDS, defaultIdeaHeaderMappings, type IdeaField } from '~~/server/parsers/ideas-smart'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const row = db().prepare('SELECT idea_import_mappings FROM grant_settings WHERE company_id = ?')
    .get(id) as { idea_import_mappings: string | null } | undefined

  const mappings = defaultIdeaHeaderMappings()
  if (row?.idea_import_mappings) {
    try {
      const saved = JSON.parse(row.idea_import_mappings) as Partial<Record<IdeaField, string>>
      for (const [k, v] of Object.entries(saved)) {
        if (typeof v === 'string') (mappings as any)[k] = v
      }
    } catch { /* ignore malformed JSON */ }
  }

  return { fields: CANONICAL_IDEA_FIELDS, mappings }
})
