import ExcelJS from 'exceljs'
import type { FairnessResult } from '~~/server/utils/fairness'

// Excel export for the Grant Fairness module — one sheet per page tab plus a
// per-round dilution walk. Built from the grant-fairness endpoint so the math
// stays in one place. ?round= and ?includeFuture= flow through.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const q = getQuery(event)
  const qs = new URLSearchParams()
  if (q.round) qs.set('round', String(q.round))
  if (q.includeFuture) qs.set('includeFuture', String(q.includeFuture))
  const data = await $fetch<FairnessResult & { company: { name: string; slug: string } }>(
    `/api/companies/${id}/grant-fairness${qs.toString() ? `?${qs}` : ''}`,
  )
  const sel = data.rounds.find(r => r.code === data.selectedRoundCode)
  const selName = sel ? (sel.name || sel.code) : '—'
  const included = data.holders.filter(h => h.include)

  const wb = new ExcelJS.Workbook()
  wb.creator = 'CapStack'
  wb.created = new Date()

  const sectionFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF4B5F74' } }
  const headFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFD8D7DB' } }
  const whiteBold = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri', size: 11 }
  const blackBold = { bold: true, color: { argb: 'FF000000' }, name: 'Calibri', size: 11 }
  const thin = { style: 'thin' as const, color: { argb: 'FFB0B7BF' } }
  const borders: Partial<ExcelJS.Borders> = { top: thin, bottom: thin, left: thin, right: thin }
  const flagFill: Record<string, string> = { under: 'FFFFE0E0', over: 'FFFFF1CC', in: 'FFE3F4E1' }
  const flagText: Record<string, string> = { under: 'Under-granted', over: 'Over-granted', in: 'In range', na: '—' }

  function header(ws: ExcelJS.Worksheet, row: number, labels: string[]) {
    labels.forEach((l, i) => {
      const c = ws.getCell(row, i + 1)
      c.value = l; c.font = blackBold; c.fill = headFill
      c.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true }
      c.border = borders
    })
    ws.getRow(row).height = 26
  }
  function banner(ws: ExcelJS.Worksheet, span: number, text: string) {
    ws.mergeCells(1, 1, 1, span)
    const c = ws.getCell(1, 1)
    c.value = text; c.font = whiteBold; c.fill = sectionFill
    c.alignment = { horizontal: 'left', vertical: 'middle' }
    ws.getRow(1).height = 20
  }

  // ---- Sheet 1: Optionholders roster ----
  const ws1 = wb.addWorksheet('Optionholders')
  ws1.columns = [{ width: 26 }, { width: 14 }, { width: 22 }, { width: 12 }, { width: 10 }, { width: 16 }, { width: 14 }, { width: 16 }]
  banner(ws1, 8, `OPTIONHOLDERS — ${data.company.name}`)
  header(ws1, 2, ['Name', 'Award type', 'Title', 'Level', 'Include', 'Options', 'Other holdings', 'Total'])
  let r1 = 3
  for (const h of data.holders) {
    ws1.getCell(r1, 1).value = h.name
    ws1.getCell(r1, 2).value = h.awardTypes.join(', ') || '—'
    ws1.getCell(r1, 3).value = h.title || ''
    ws1.getCell(r1, 4).value = h.level || '—'
    ws1.getCell(r1, 5).value = h.include ? 'Yes' : 'No'
    ws1.getCell(r1, 6).value = h.optionShares; ws1.getCell(r1, 6).numFmt = '#,##0'
    ws1.getCell(r1, 7).value = h.heldShares; ws1.getCell(r1, 7).numFmt = '#,##0'
    ws1.getCell(r1, 8).value = h.optionShares + h.heldShares; ws1.getCell(r1, 8).numFmt = '#,##0'
    if (!h.include) ws1.getCell(r1, 5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } }
    for (let c = 1; c <= 8; c++) ws1.getCell(r1, c).border = borders
    r1++
  }

  // ---- Sheet 2: Current holdings, fully diluted to the selected round ----
  const ws2 = wb.addWorksheet('Holdings (FD)')
  ws2.columns = [{ width: 26 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 16 }]
  banner(ws2, 8, `CURRENT HOLDINGS — fully diluted to ${selName}${data.includeFuture ? ' (incl. proposed + ideas)' : ''}`)
  header(ws2, 2, ['Name', 'Level', 'Options', 'Total shares', 'Pre %', 'Post %', 'Entry %', '$ value'])
  let r2 = 3
  for (const h of included) {
    ws2.getCell(r2, 1).value = h.name
    ws2.getCell(r2, 2).value = h.level || '—'
    ws2.getCell(r2, 3).value = h.grantShares; ws2.getCell(r2, 3).numFmt = '#,##0'
    ws2.getCell(r2, 4).value = h.totalShares; ws2.getCell(r2, 4).numFmt = '#,##0'
    ws2.getCell(r2, 5).value = h.prePct; ws2.getCell(r2, 5).numFmt = '0.000%'
    ws2.getCell(r2, 6).value = h.postPct; ws2.getCell(r2, 6).numFmt = '0.000%'
    ws2.getCell(r2, 7).value = h.entryPct; ws2.getCell(r2, 7).numFmt = '0.000%'
    ws2.getCell(r2, 8).value = h.value; ws2.getCell(r2, 8).numFmt = '"$"#,##0'
    for (let c = 1; c <= 8; c++) ws2.getCell(r2, c).border = borders
    r2++
  }

  // ---- Sheet 3: Recommended grant model ----
  const ws3 = wb.addWorksheet('Recommended grants')
  ws3.columns = [{ width: 26 }, { width: 12 }, { width: 14 }, { width: 12 }, { width: 16 }, { width: 16 }, { width: 14 }]
  banner(ws3, 7, `RECOMMENDED GRANT MODEL — basis ${selName}${data.includeFuture ? ' (incl. proposed + ideas)' : ''}`)
  // Ranges by level
  header(ws3, 2, ['Level', '# Holders', 'Target post %', 'Fair range', '', '', ''])
  let r3 = 3
  for (const l of data.levels) {
    ws3.getCell(r3, 1).value = l.level
    ws3.getCell(r3, 2).value = l.count
    ws3.getCell(r3, 3).value = l.post.target; ws3.getCell(r3, 3).numFmt = '0.000%'
    ws3.getCell(r3, 4).value = `${(l.post.lo * 100).toFixed(3)}% – ${(l.post.hi * 100).toFixed(3)}%`
    for (let c = 1; c <= 4; c++) ws3.getCell(r3, c).border = borders
    r3++
  }
  r3 += 1
  header(ws3, r3, ['Name', 'Level', 'Current post %', 'Fairness', 'Recommended + options', 'Resulting post %', ''])
  r3++
  for (const h of included.filter(h => h.level)) {
    ws3.getCell(r3, 1).value = h.name
    ws3.getCell(r3, 2).value = h.level || '—'
    ws3.getCell(r3, 3).value = h.postPct; ws3.getCell(r3, 3).numFmt = '0.000%'
    const f = ws3.getCell(r3, 4)
    f.value = flagText[h.flag] ?? '—'
    if (h.flag !== 'na') f.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: flagFill[h.flag] } }
    ws3.getCell(r3, 5).value = h.recommendedAddl || 0; ws3.getCell(r3, 5).numFmt = '#,##0'
    ws3.getCell(r3, 6).value = h.recommendedPct; ws3.getCell(r3, 6).numFmt = '0.000%'
    for (let c = 1; c <= 6; c++) ws3.getCell(r3, c).border = borders
    r3++
  }
  // Totals
  ws3.getCell(r3, 1).value = 'TOTAL RECOMMENDED NEW OPTIONS'
  ws3.getCell(r3, 1).font = blackBold
  ws3.mergeCells(r3, 1, r3, 4)
  ws3.getCell(r3, 5).value = data.recommendedTotalAddl; ws3.getCell(r3, 5).numFmt = '#,##0'; ws3.getCell(r3, 5).font = blackBold
  for (let c = 1; c <= 6; c++) ws3.getCell(r3, c).border = borders

  // ---- Sheet 4: Dilution walk (pre/post per round) ----
  const ws4 = wb.addWorksheet('Dilution Walk')
  const cols4: Partial<ExcelJS.Column>[] = [{ width: 26 }, { width: 12 }]
  for (let i = 0; i < data.rounds.length; i++) cols4.push({ width: 11 }, { width: 11 })
  ws4.columns = cols4
  const last4 = 2 + data.rounds.length * 2
  banner(ws4, last4, 'OWNERSHIP % BY ROUND — PRE & POST')
  ws4.getCell(2, 1).value = 'Name'; ws4.getCell(2, 2).value = 'Level'
  ws4.mergeCells(2, 1, 3, 1); ws4.mergeCells(2, 2, 3, 2)
  for (const c of [1, 2]) { const cell = ws4.getCell(2, c); cell.font = blackBold; cell.fill = headFill; cell.border = borders }
  data.rounds.forEach((rd, i) => {
    const c0 = 3 + i * 2
    ws4.mergeCells(2, c0, 2, c0 + 1)
    const rc = ws4.getCell(2, c0)
    rc.value = rd.name || rd.code; rc.font = blackBold; rc.fill = headFill
    rc.alignment = { horizontal: 'center' }; rc.border = borders
    ws4.getCell(2, c0 + 1).border = borders
    const pre = ws4.getCell(3, c0); pre.value = 'Pre'; pre.font = blackBold; pre.fill = headFill; pre.border = borders
    const post = ws4.getCell(3, c0 + 1); post.value = 'Post'; post.font = blackBold; post.fill = headFill; post.border = borders
  })
  let r4 = 4
  for (const h of included) {
    ws4.getCell(r4, 1).value = h.name
    ws4.getCell(r4, 2).value = h.level || '—'
    ws4.getCell(r4, 1).border = borders
    ws4.getCell(r4, 2).border = borders
    data.rounds.forEach((rd, i) => {
      const c0 = 3 + i * 2
      const pr = h.perRound[rd.code]
      const pre = ws4.getCell(r4, c0); pre.value = pr?.prePct ?? 0; pre.numFmt = '0.000%'; pre.border = borders
      const post = ws4.getCell(r4, c0 + 1); post.value = pr?.postPct ?? 0; post.numFmt = '0.000%'; post.border = borders
    })
    r4++
  }

  const buffer = await wb.xlsx.writeBuffer() as Buffer
  const filename = `${data.company.slug}-grant-fairness-${new Date().toISOString().slice(0, 10)}.xlsx`
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  setHeader(event, 'Content-Length', String(buffer.byteLength))
  return buffer
})
