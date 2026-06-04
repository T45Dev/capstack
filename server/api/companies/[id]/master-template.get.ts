import ExcelJS from 'exceljs'
import { db } from '~~/server/utils/db'
import { MASTER_TABS } from '~~/server/utils/masterTemplate'
import { THELANDER_ROLES } from '~~/server/utils/thelander'

// Download the master import template: one workbook, one tab per entity, with
// the exact headers the importer expects. Row 1 = an instruction note, row 2 =
// headers (frozen). A leading "Instructions" tab documents the controlled
// (non-free-text) fields and their allowed values.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  const company = db().prepare('SELECT name, slug FROM companies WHERE id = ?').get(id) as any
  if (!company) throw createError({ statusCode: 404, message: 'Company not found' })

  const wb = new ExcelJS.Workbook()
  wb.creator = 'CapStack'
  wb.created = new Date()

  // ---- Instructions tab (first) ----
  const ins = wb.addWorksheet('Instructions')
  ins.columns = [{ width: 18 }, { width: 30 }, { width: 40 }, { width: 52 }]
  ins.mergeCells(1, 1, 1, 4)
  const title = ins.getCell(1, 1)
  title.value = 'CapStack master import — fill one tab per entity. Enter each person once on Stakeholders; other tabs reference them by Name.'
  title.font = { bold: true, color: { argb: 'FF111827' }, size: 12 }
  title.alignment = { wrapText: true, vertical: 'middle' }
  ins.getRow(1).height = 30
  const head = ['Tab', 'Column', 'Allowed values / format', 'Notes']
  head.forEach((h, i) => {
    const c = ins.getCell(3, i + 1)
    c.value = h; c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }
  })
  let r = 4
  for (const tab of MASTER_TABS) {
    for (const col of tab.columns) {
      if (!col.values && !col.format && !col.help) continue
      ins.getCell(r, 1).value = tab.sheet
      ins.getCell(r, 2).value = col.header
      ins.getCell(r, 3).value = col.values ? col.values.join(' · ') : (col.format || '')
      ins.getCell(r, 4).value = col.help || ''
      ins.getCell(r, 4).alignment = { wrapText: true }
      r++
    }
  }
  // Valid Thelander roles for the Benchmark-role column.
  r += 1
  ins.getCell(r, 1).value = 'Benchmark role — valid values (Stakeholders tab):'
  ins.getCell(r, 1).font = { bold: true }
  r++
  ins.mergeCells(r, 1, r, 4)
  ins.getCell(r, 1).value = THELANDER_ROLES.join(' · ')
  ins.getCell(r, 1).alignment = { wrapText: true, vertical: 'top' }
  ins.getRow(r).height = 90

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
      // Dropdown for controlled columns (non-blocking — suggestions).
      if (c.values && c.values.length) {
        const colLetter = ws.getColumn(i + 1).letter
        for (let rr = 3; rr <= 200; rr++) {
          ws.getCell(`${colLetter}${rr}`).dataValidation = {
            type: 'list', allowBlank: true, showErrorMessage: false,
            formulae: [`"${c.values.join(',')}"`],
          }
        }
      }
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
