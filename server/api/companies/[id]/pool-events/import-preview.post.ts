import { parseIdeasFile } from '~~/server/parsers/ideas-smart'
import { loadIdeaImportMappings } from '~~/server/utils/grant-settings'

// Parse an uploaded ideas (Future grant) file and return what we'd import
// without committing, so the UI can show the detected mapping + a sample.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const parts = await readMultipartFormData(event)
  const file = parts?.find(p => p.name === 'file' || p.filename)
  if (!file?.data) throw createError({ statusCode: 400, message: 'No file uploaded' })

  const filename = file.filename || 'ideas.xlsx'
  const result = await parseIdeasFile(filename, Buffer.from(file.data), loadIdeaImportMappings(id))

  return {
    filename,
    headerRow: result.headerRow,
    rowsRead: result.rowsRead,
    mapping: result.mapping,
    unmappedHeaders: result.unmappedHeaders,
    warnings: result.warnings,
    sample: result.parsed.slice(0, 50),
    totalParsed: result.parsed.length,
  }
})
