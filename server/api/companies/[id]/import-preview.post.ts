import { parseCartaXlsx, detectCartaSheetRoles } from '~~/server/parsers/carta'
import ExcelJS from 'exceljs'

// Dry-run parse: same code path as the real import, no DB writes.
// Returns counts + sample rows so the upload UI can show "this is
// what we're about to land" before the operator commits. We only
// preview the things the import actually writes — stakeholders,
// option grants, and the pool size. Share classes / holdings /
// convertibles / round suggestions are user-managed and never
// imported, so they're omitted from the preview too.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  let parts
  try {
    parts = await readMultipartFormData(event)
  } catch (e: any) {
    throw createError({ statusCode: 400, message: `Failed to read upload: ${e?.message || e}` })
  }
  if (!parts?.length) throw createError({ statusCode: 400, message: 'No file uploaded' })

  const file = parts.find(p => p.name === 'file' || (p.filename && /\.(xlsx|xlsm)$/i.test(p.filename)))
  if (!file?.data) throw createError({ statusCode: 400, message: 'Missing file part' })

  const buf = Buffer.from(file.data)

  let detected
  try {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as any)
    detected = detectCartaSheetRoles(wb)
  } catch (e: any) {
    throw createError({ statusCode: 400, message: `Failed to read workbook: ${e?.message || e}` })
  }

  let parsed
  try {
    parsed = await parseCartaXlsx(buf)
  } catch (e: any) {
    throw createError({ statusCode: 400, message: `Failed to parse xlsx: ${e?.message || e}` })
  }

  const SAMPLE_N = 5

  return {
    filename: file.filename || 'cap-table.xlsx',
    companyName: parsed.companyName || null,
    asOfDate: parsed.asOfDate || null,
    sheets: {
      // Only the sheets we actually read for the import are surfaced.
      // The convertibles + cap-table sheets are still parsed for
      // diagnostics (warnings, audit row) but they don't drive any
      // DB writes, so we don't advertise them in the preview.
      optionPlan: detected.optionPlanSheet || null,
      summaryCapTable: detected.summaryCapTableSheet || null,
    },
    counts: {
      stakeholders: parsed.stakeholders.length,
      grants:       parsed.grants.length,
    },
    samples: {
      stakeholders: parsed.stakeholders.slice(0, SAMPLE_N),
      grants:       parsed.grants.slice(0, SAMPLE_N),
    },
    poolAuthorized: parsed.poolAuthorized,
    warnings: parsed.warnings,
  }
})
