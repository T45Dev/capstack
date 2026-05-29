import { inspectCartaXlsx } from '~~/server/parsers/carta'

// Inspect-only: takes the uploaded xlsx, returns the sheet list +
// auto-detected role mapping (which sheet looks like the Detailed Cap
// Table, the Stock Option Plan, the Convertible Notes ledger, etc.).
// No DB writes. The import UI calls this on file selection so the
// operator can confirm or override the sheet-role mapping before
// committing to a full import.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const parts = await readMultipartFormData(event).catch((e: any) => {
    throw createError({ statusCode: 400, message: `Failed to read upload: ${e?.message || e}` })
  })
  if (!parts?.length) throw createError({ statusCode: 400, message: 'No file uploaded' })

  const file = parts.find(p => p.name === 'file' || (p.filename && /\.(xlsx|xlsm)$/i.test(p.filename)))
  if (!file?.data) throw createError({ statusCode: 400, message: 'Missing file part' })

  try {
    return await inspectCartaXlsx(Buffer.from(file.data))
  } catch (e: any) {
    throw createError({ statusCode: 400, message: `Failed to inspect xlsx: ${e?.message || e}` })
  }
})
