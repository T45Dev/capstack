import { db } from '~~/server/utils/db'
import { buildMasterWorkbook } from '~~/server/utils/masterWorkbook'

// Download the blank master import template: one workbook, one tab per entity,
// a leading Instructions sheet, and dropdowns on controlled columns. See
// masterWorkbook.buildMasterWorkbook for the shared construction (also used by
// the Carta prefill endpoint).
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const company = db().prepare('SELECT name, slug FROM companies WHERE id = ?').get(id) as any
  if (!company) throw createError({ statusCode: 404, message: 'Company not found' })

  const buffer = await buildMasterWorkbook(company)
  const filename = `${company.slug || 'capstack'}-master-template.xlsx`
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  setHeader(event, 'Content-Length', String(buffer.byteLength))
  return buffer
})
