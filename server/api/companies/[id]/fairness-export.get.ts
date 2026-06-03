import ExcelJS from 'exceljs'
import type { FairnessResult } from '~~/server/utils/fairness'

// Excel export for the Employee Grant Fairness module. Mirrors the in-app
// page: recommended equity ranges per level, the per-employee table with the
// three fairness lenses, and a per-round pre/post dilution walk on a second
// sheet. Built from the grant-fairness endpoint so the math stays in one
// place. Query ?round=<code> flows through to select the current-% basis.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const round = (getQuery(event).round as string) || ''
  const data = await $fetch<FairnessResult & { company: { name: string; slug: string } }>(
    `/api/companies/${id}/grant-fairness${round ? `?round=${encodeURIComponent(round)}` : ''}`,
  )

  const sel = data.rounds.find(r => r.code === data.selectedRoundCode)
  const selName = sel ? (sel.name || sel.code) : '—'

  const wb = new ExcelJS.Workbook()
  wb.creator = 'CapStack'
  wb.created = new Date()

  // Shared styles
  const sectionFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF4B5F74' } }
  const headFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFD8D7DB' } }
  const whiteBold = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri', size: 11 }
  const blackBold = { bold: true, color: { argb: 'FF000000' }, name: 'Calibri', size: 11 }
  const thin = { style: 'thin' as const, color: { argb: 'FFB0B7BF' } }
  const borders: Partial<ExcelJS.Borders> = { top: thin, bottom: thin, left: thin, right: thin }
  const flagFill: Record<string, string> = { under: 'FFFFE0E0', over: 'FFFFF1CC', in: 'FFE3F4E1' }
  const flagText: Record<string, string> = { under: 'Under-granted', over: 'Over-granted', in: 'In range', na: '—' }

  // ============ Sheet 1: Fairness ============
  const ws = wb.addWorksheet('Grant Fairness', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  })
  ws.columns = [
    { width: 26 }, { width: 20 }, { width: 12 }, { width: 14 }, { width: 16 },
    { width: 12 }, { width: 12 }, { width: 12 }, { width: 16 }, { width: 16 }, { width: 14 },
  ]
  const LAST = 11
  let r = 1

  function section(text: string) {
    ws.mergeCells(r, 1, r, LAST)
    const c = ws.getCell(r, 1)
    c.value = text; c.font = whiteBold; c.fill = sectionFill
    c.alignment = { horizontal: 'left', vertical: 'middle' }
    ws.getRow(r).height = 20
    r++
  }
  function head(labels: string[]) {
    labels.forEach((l, i) => {
      const c = ws.getCell(r, i + 1)
      c.value = l; c.font = blackBold; c.fill = headFill
      c.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true }
      c.border = borders
    })
    ws.getRow(r).height = 28
    r++
  }

  // Title
  ws.mergeCells(r, 1, r, LAST)
  const title = ws.getCell(r, 1)
  title.value = 'EMPLOYEE GRANT FAIRNESS'
  title.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' }, name: 'Calibri' }
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } }
  title.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(r).height = 28
  r++
  ws.mergeCells(r, 1, r, LAST)
  const sub = ws.getCell(r, 1)
  sub.value = `${data.company.name}  —  current basis: ${selName}  —  ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`
  sub.font = { italic: true, size: 11, name: 'Calibri', color: { argb: 'FF1E293B' } }
  sub.alignment = { horizontal: 'center' }
  r++
  ws.mergeCells(r, 1, r, LAST)
  const meth = ws.getCell(r, 1)
  meth.value = data.methodology
  meth.font = { italic: true, size: 9, name: 'Calibri', color: { argb: 'FF64748B' } }
  meth.alignment = { horizontal: 'left', wrapText: true, vertical: 'top' }
  ws.getRow(r).height = 42
  r += 2

  // Section A — recommended ranges by level
  section('RECOMMENDED EQUITY RANGES BY LEVEL')
  head([
    'Level', '# Emp', 'Entry % Target', 'Entry % Low', 'Entry % High',
    'Post % Target', 'Post % Low', 'Post % High', '$ Target', '$ Low', '$ High',
  ])
  for (const l of data.levels) {
    ws.getCell(r, 1).value = l.level
    ws.getCell(r, 2).value = l.count
    const pcts = [l.entry.target, l.entry.lo, l.entry.hi, l.post.target, l.post.lo, l.post.hi]
    pcts.forEach((v, i) => { const c = ws.getCell(r, 3 + i); c.value = v; c.numFmt = '0.000%' })
    const dollars = [l.value.target, l.value.lo, l.value.hi]
    dollars.forEach((v, i) => { const c = ws.getCell(r, 9 + i); c.value = v; c.numFmt = '"$"#,##0' })
    for (let c = 1; c <= LAST; c++) ws.getCell(r, c).border = borders
    r++
  }
  if (!data.levels.length) {
    ws.mergeCells(r, 1, r, LAST)
    ws.getCell(r, 1).value = 'No job levels assigned yet — set each employee’s Job Level on the Grant Fairness page.'
    ws.getCell(r, 1).font = { italic: true, color: { argb: 'FF94A3B8' }, name: 'Calibri', size: 10 }
    r++
  }
  r++

  // Section B — employees
  section('EMPLOYEES')
  head([
    'Employee', 'Title', 'Level', 'Hire Round', 'Outstanding Options',
    'Entry %', `Pre % (${selName})`, `Post % (${selName})`, 'Equity $ Value', 'Fairness', '',
  ])
  for (const e of data.employees) {
    ws.getCell(r, 1).value = e.name
    ws.getCell(r, 2).value = e.title || ''
    ws.getCell(r, 3).value = e.level || '—'
    ws.getCell(r, 4).value = e.hireRoundName || '—'
    ws.getCell(r, 5).value = e.shares; ws.getCell(r, 5).numFmt = '#,##0'
    ws.getCell(r, 6).value = e.entryPct; ws.getCell(r, 6).numFmt = '0.000%'
    ws.getCell(r, 7).value = e.prePct; ws.getCell(r, 7).numFmt = '0.000%'
    ws.getCell(r, 8).value = e.postPct; ws.getCell(r, 8).numFmt = '0.000%'
    ws.getCell(r, 9).value = e.value; ws.getCell(r, 9).numFmt = '"$"#,##0'
    const f = ws.getCell(r, 10)
    f.value = flagText[e.flag] ?? '—'
    if (e.flag !== 'na') f.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: flagFill[e.flag] } }
    for (let c = 1; c <= LAST; c++) ws.getCell(r, c).border = borders
    r++
  }

  // ============ Sheet 2: Dilution Walk (pre/post per round) ============
  const ws2 = wb.addWorksheet('Dilution Walk', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  })
  const walkCols = [{ width: 26 }, { width: 12 }]
  for (let i = 0; i < data.rounds.length; i++) walkCols.push({ width: 11 }, { width: 11 })
  ws2.columns = walkCols
  const walkLast = 2 + data.rounds.length * 2

  ws2.mergeCells(1, 1, 1, walkLast)
  const wt = ws2.getCell(1, 1)
  wt.value = 'OWNERSHIP % BY ROUND — PRE & POST (current outstanding options as the numerator)'
  wt.font = whiteBold; wt.fill = sectionFill
  wt.alignment = { horizontal: 'left', vertical: 'middle' }
  ws2.getRow(1).height = 20

  // Two header rows: round names spanning their two columns, then Pre/Post.
  ws2.getCell(2, 1).value = 'Employee'; ws2.getCell(2, 1).font = blackBold; ws2.getCell(2, 1).fill = headFill; ws2.getCell(2, 1).border = borders
  ws2.getCell(2, 2).value = 'Level'; ws2.getCell(2, 2).font = blackBold; ws2.getCell(2, 2).fill = headFill; ws2.getCell(2, 2).border = borders
  ws2.mergeCells(2, 1, 3, 1); ws2.mergeCells(2, 2, 3, 2)
  data.rounds.forEach((rd, i) => {
    const c0 = 3 + i * 2
    ws2.mergeCells(2, c0, 2, c0 + 1)
    const rc = ws2.getCell(2, c0)
    rc.value = rd.name || rd.code
    rc.font = blackBold; rc.fill = headFill
    rc.alignment = { horizontal: 'center', vertical: 'middle' }
    rc.border = borders
    ws2.getCell(2, c0 + 1).border = borders
    const pre = ws2.getCell(3, c0); pre.value = 'Pre'; pre.font = blackBold; pre.fill = headFill; pre.border = borders
    const post = ws2.getCell(3, c0 + 1); post.value = 'Post'; post.font = blackBold; post.fill = headFill; post.border = borders
  })
  let wr = 4
  for (const e of data.employees) {
    ws2.getCell(wr, 1).value = e.name
    ws2.getCell(wr, 2).value = e.level || '—'
    data.rounds.forEach((rd, i) => {
      const c0 = 3 + i * 2
      const pr = e.perRound[rd.code]
      const pre = ws2.getCell(wr, c0); pre.value = pr?.prePct ?? 0; pre.numFmt = '0.000%'; pre.border = borders
      const post = ws2.getCell(wr, c0 + 1); post.value = pr?.postPct ?? 0; post.numFmt = '0.000%'; post.border = borders
    })
    ws2.getCell(wr, 1).border = borders
    ws2.getCell(wr, 2).border = borders
    wr++
  }

  const buffer = await wb.xlsx.writeBuffer() as Buffer
  const filename = `${data.company.slug}-grant-fairness-${new Date().toISOString().slice(0, 10)}.xlsx`
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  setHeader(event, 'Content-Length', String(buffer.byteLength))
  return buffer
})
