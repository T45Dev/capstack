import { db } from '~~/server/utils/db'
import { defaultHeaderMappings, type GrantField } from '~~/server/parsers/grants-smart'
import { defaultIdeaHeaderMappings, type IdeaField } from '~~/server/parsers/ideas-smart'

// Load a company's import header-mapping overrides, merged on top of the
// canonical defaults. Shared by the preview + commit import endpoints so both
// honor the operator's Option Grants settings.
export function loadImportMappings(companyId: string): Partial<Record<GrantField, string>> {
  const mappings = defaultHeaderMappings()
  const row = db().prepare('SELECT import_mappings FROM grant_settings WHERE company_id = ?')
    .get(companyId) as { import_mappings: string | null } | undefined
  if (row?.import_mappings) {
    try {
      const saved = JSON.parse(row.import_mappings) as Partial<Record<GrantField, string>>
      for (const [k, v] of Object.entries(saved)) {
        if (typeof v === 'string' && v.trim()) (mappings as any)[k] = v
      }
    } catch { /* ignore malformed JSON */ }
  }
  return mappings
}

// Ideas (option-grant ideas) import header-mapping overrides, merged on top of
// the canonical defaults. Stored on the same grant_settings row.
export function loadIdeaImportMappings(companyId: string): Partial<Record<IdeaField, string>> {
  const mappings = defaultIdeaHeaderMappings()
  const row = db().prepare('SELECT idea_import_mappings FROM grant_settings WHERE company_id = ?')
    .get(companyId) as { idea_import_mappings: string | null } | undefined
  if (row?.idea_import_mappings) {
    try {
      const saved = JSON.parse(row.idea_import_mappings) as Partial<Record<IdeaField, string>>
      for (const [k, v] of Object.entries(saved)) {
        if (typeof v === 'string' && v.trim()) (mappings as any)[k] = v
      }
    } catch { /* ignore malformed JSON */ }
  }
  return mappings
}
