import { parseGrantsFile } from '~~/server/parsers/grants-smart'
import { loadImportMappings } from '~~/server/utils/grant-settings'

// Parse the uploaded file and return what we'd import without committing.
// Lets the UI surface the detected column mapping and a preview of the
// rows so the operator can review before clicking Import. The returned
// blob is the same shape as the commit endpoint expects, plus a sample.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const parts = await readMultipartFormData(event)
  const file = parts?.find(p => p.name === 'file' || p.filename)
  if (!file?.data) throw createError({ statusCode: 400, message: 'No file uploaded' })

  const filename = file.filename || 'grants.xlsx'
  const result = await parseGrantsFile(filename, Buffer.from(file.data), loadImportMappings(id))

  return {
    filename,
    headerRow: result.headerRow,
    rowsRead: result.rowsRead,
    mapping: result.mapping,
    unmappedHeaders: result.unmappedHeaders,
    warnings: result.warnings,
    // Cap the preview at 50 rows so the response stays reasonable; the
    // commit endpoint re-parses the file so we don't need to ship every row.
    sample: result.parsed.slice(0, 50),
    totalParsed: result.parsed.length,
  }
})
