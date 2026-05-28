import { parseCartaXlsx, detectCartaSheetRoles } from '~~/server/parsers/carta'
import ExcelJS from 'exceljs'

// Dry-run parse: same code path as the real import but no DB writes.
// Returns counts + a handful of sample rows per category so the upload
// UI can show "this is what we're about to import" before the operator
// commits. Sheet roles are auto-detected — the override dropdowns are
// gone from the redesigned UI in favour of just trusting detection.
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

  // Detect sheet roles once so we can return them alongside the parse
  // result (the UI displays "we'll read X from the Detailed Cap Table sheet").
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
      detailedCapTable: detected.detailedCapTableSheet || null,
      optionPlan:       detected.optionPlanSheet       || null,
      convertibleNotes: detected.convertibleNotesSheet || null,
      summaryCapTable:  detected.summaryCapTableSheet  || null,
    },
    counts: {
      shareClasses: parsed.shareClasses.length,
      stakeholders: parsed.stakeholders.length,
      holdings:     parsed.holdings.length,
      grants:       parsed.grants.length,
      convertibles: parsed.convertibles.length,
    },
    samples: {
      shareClasses: parsed.shareClasses.slice(0, SAMPLE_N),
      stakeholders: parsed.stakeholders.slice(0, SAMPLE_N),
      holdings:     parsed.holdings.slice(0, SAMPLE_N),
      grants:       parsed.grants.slice(0, SAMPLE_N),
      convertibles: parsed.convertibles.slice(0, SAMPLE_N),
    },
    poolAuthorized: parsed.poolAuthorized,
    warnings: parsed.warnings,
  }
})
