import ExcelJS from 'exceljs'
import { db } from '~~/server/utils/db'
import { MASTER_TABS } from '~~/server/utils/masterTemplate'

// Download the master import template: one workbook, one tab per entity, with
// the exact headers the importer expects. Row 1 = an instruction note, row 2 =
// headers (frozen).
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const company = db().prepare('SELECT name, slug FROM companies WHERE id = ?').get(id) as any
  if (!company) throw createError({ statusCode: 404, message: 'Company not found' })

  const wb = new ExcelJS.Workbook()
  wb.creator = 'CapStack'
  wb.created = new Date()

  for (const tab of MASTER_TABS) {
    const ws = wb.addWorksheet(tab.sheet)
    ws.columns = tab.columns.map(c => ({ width: Math.max(14, c.header.length + 2) }))
    // Note row.
    ws.mergeCells(1, 1, 1, tab.columns.length)
    const note = ws.getCell(1, 1)
    note.value = tab.note
    note.font = { italic: true, color: { argb: 'FF6B7280' }, size: 10 }
    note.alignment = { vertical: 'middle', wrapText: true }
    ws.getRow(1).height = 22
    // Header row.
    tab.columns.forEach((c, i) => {
      const cell = ws.getCell(2, i + 1)
      cell.value = c.header
      cell.font = { bold: true, color: { argb: 'FF111827' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF9CA3AF' } } }
    })
    ws.views = [{ state: 'frozen', ySplit: 2 }]
  }

  const buffer = await wb.xlsx.writeBuffer() as Buffer
  const filename = `${company.slug || 'capstack'}-master-template.xlsx`
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  setHeader(event, 'Content-Length', String(buffer.byteLength))
  return buffer
})
