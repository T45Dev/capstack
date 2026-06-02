import { db } from '~~/server/utils/db'
import { CANONICAL_GRANT_FIELDS, defaultHeaderMappings, type GrantField } from '~~/server/parsers/grants-smart'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const row = db().prepare('SELECT import_mappings FROM grant_settings WHERE company_id = ?')
    .get(id) as { import_mappings: string | null } | undefined

  // Merge any saved overrides on top of the canonical defaults so the UI
  // always renders a value for every field.
  const mappings = defaultHeaderMappings()
  if (row?.import_mappings) {
    try {
      const saved = JSON.parse(row.import_mappings) as Partial<Record<GrantField, string>>
      for (const [k, v] of Object.entries(saved)) {
        if (typeof v === 'string') (mappings as any)[k] = v
      }
    } catch { /* ignore malformed JSON */ }
  }

  return { fields: CANONICAL_GRANT_FIELDS, mappings }
})
