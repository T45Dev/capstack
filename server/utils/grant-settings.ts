import { db } from '~~/server/utils/db'
import { defaultHeaderMappings, type GrantField } from '~~/server/parsers/grants-smart'

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
