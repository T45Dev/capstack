import ExcelJS from 'exceljs'
import { db } from '~~/server/utils/db'
import { computeRound, type ConvertibleNote } from '~~/server/utils/calc'

// Generates a board-approval xlsx that follows the S3VC Option Grants
// Workbook template (tab 3, "Board Option Grant Approval"). Returned as a
// downloadable .xlsx attachment.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  // ---- Gather data ----
  const company = db().prepare('SELECT * FROM companies WHERE id = ?').get(id) as any
  if (!company) throw createError({ statusCode: 404, message: 'Company not found' })

  const assumptions = db().prepare('SELECT * FROM assumptions WHERE company_id = ?').get(id) as any
  const proposedGrants = db().prepare(`
    SELECT g.*
    FROM grants g
    WHERE g.company_id = ? AND g.status = 'proposed'
    ORDER BY g.quantity DESC
  `).all(id) as any[]

  const allGrants = db().prepare(`SELECT * FROM grants WHERE company_id = ?`).all(id) as any[]
  const shareClasses = db().prepare(`SELECT * FROM share_classes WHERE company_id = ?`).all(id) as any[]
  const holdings = db().prepare(`SELECT * FROM holdings WHERE company_id = ?`).all(id) as any[]
  const convertibles = db().prepare(`SELECT * FROM convertibles WHERE company_id = ? AND status = 'outstanding'`).all(id) as any[]
  const pools = db().prepare(`SELECT * FROM option_pools WHERE company_id = ?`).all(id) as any[]

  // ---- Compute pre / post FDS ----
  const holdingsTotal = holdings.reduce((a, h) => a + (h.shares || 0), 0)
  const outstandingTotal = allGrants.filter(g => g.status === 'outstanding').reduce((a, g) => a + g.quantity, 0)
  const proposedTotal = proposedGrants.reduce((a, g) => a + g.quantity, 0)
  const poolAuthorized = pools.reduce((a, p) => a + (p.authorized || 0), 0)
  const optionsAvailable = Math.max(0, poolAuthorized - outstandingTotal - proposedTotal)
  const fdsFromCapTable = holdingsTotal + outstandingTotal + optionsAvailable + (assumptions?.pool_top_up_shares || 0)
  const preFDS = assumptions?.pre_round_fds ?? fdsFromCapTable

  const cnNotes: ConvertibleNote[] = convertibles.map(c => ({
    id: c.id,
    stakeholderName: c.stakeholder_name,
    principal: c.principal || 0,
    interestAccrued: c.interest_accrued || 0,
    conversionDiscount: c.conversion_discount || 0,
    valuationCap: c.valuation_cap,
    convertsAtRound: c.converts_at_round !== 0,
  }))
  const round = computeRound({
    preRoundFDS: preFDS,
    preMoney: assumptions?.pre_money ?? 0,
    newMoney: assumptions?.new_money ?? 0,
    convertibles: cnNotes,
    cnBasis: assumptions?.cn_conversion_basis ?? 'best',
  })
  // If no round is modelled, post-FDS falls back to pre-FDS so the % columns still resolve.
  const postFDS = round.postRoundFDS > 0 ? round.postRoundFDS : preFDS

  // company.starting_round is the canonical round CODE (the pre-baseline
  // picker stores codes so renames of the display name don't break the
  // link). Resolve it to a friendly name for the header. Legacy data may
  // hold a name instead — match by code first, then by name.
  const baselineRef = company.starting_round as string | null
  let baselineRoundName: string | null = null
  if (baselineRef) {
    const r = db().prepare(
      'SELECT name, code FROM rounds WHERE company_id = ? AND (code = ? OR name = ?) LIMIT 1',
    ).get(id, baselineRef, baselineRef) as { name: string | null; code: string } | undefined
    baselineRoundName = r ? (r.name || r.code) : baselineRef
  }
  const roundName: string = assumptions?.round_name || baselineRoundName || 'Round'
  // "Series B" -> "B", "Series A-2" -> "A-2", "Bridge" -> "Bridge"
  const roundSuffix = roundName.replace(/^Series\s+/i, '')

  // ---- Look-up tables for section 2 ----
  const shareClassKind = new Map<string, string>()
  for (const sc of shareClasses) shareClassKind.set(sc.id, (sc.kind || '').toLowerCase())

  const positionByStakeholder = new Map<string, { common: number; preferred: number; warrants: number }>()
  for (const h of holdings) {
    const kind = shareClassKind.get(h.share_class_id) || ''
    const row = positionByStakeholder.get(h.stakeholder_id) || { common: 0, preferred: 0, warrants: 0 }
    if (kind === 'common') row.common += h.shares
    else if (kind === 'warrant') row.warrants += h.shares
    else row.preferred += h.shares
    positionByStakeholder.set(h.stakeholder_id, row)
  }
  const outstandingOptionsByStakeholder = new Map<string, number>()
  for (const g of allGrants) {
    if (g.status === 'outstanding' && g.stakeholder_id) {
      outstandingOptionsByStakeholder.set(
        g.stakeholder_id,
        (outstandingOptionsByStakeholder.get(g.stakeholder_id) || 0) + g.quantity,
      )
    }
  }

  // ---- Build workbook ----
  const wb = new ExcelJS.Workbook()
  wb.creator = 'CapStack'
  wb.created = new Date()
  const ws = wb.addWorksheet('Board Approval', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
    properties: { defaultRowHeight: 15 },
  })

  ws.columns = [
    { width: 18 }, // A — Last
    { width: 18 }, // B — First
    { width: 18 }, // C — Role / Category
    { width: 16 }, // D — Approval Status
    { width: 16 }, // E — New Grant
    { width: 14 }, // F — Exercise Price
    { width: 28 }, // G — Vesting
    { width: 18 }, // H — % FD Pre
    { width: 18 }, // I — % FD Post
  ]

  // Styles
  const sectionFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF4B5F74' } }
  const colHeaderFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFD8D7DB' } }
  const subGroupFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFE5E7EB' } }
  const whiteBold = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri', size: 11 }
  const blackBold = { bold: true, color: { argb: 'FF000000' }, name: 'Calibri', size: 11 }
  const thin: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FFB0B7BF' } }
  const allBorders: Partial<ExcelJS.Borders> = { top: thin, bottom: thin, left: thin, right: thin }

  function setSectionHeader(row: number, text: string) {
    ws.mergeCells(row, 1, row, 9)
    const c = ws.getCell(row, 1)
    c.value = text
    c.font = whiteBold
    c.fill = sectionFill
    c.alignment = { horizontal: 'left', vertical: 'middle' }
    ws.getRow(row).height = 20
  }

  function setColHeader(row: number, headers: string[]) {
    headers.forEach((h, i) => {
      const c = ws.getCell(row, i + 1)
      c.value = h
      c.font = blackBold
      c.fill = colHeaderFill
      c.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true }
      c.border = allBorders
    })
    ws.getRow(row).height = 30
  }

  function applyBorders(row: number, startCol = 1, endCol = 9) {
    for (let c = startCol; c <= endCol; c++) ws.getCell(row, c).border = allBorders
  }

  function splitName(full: string): { last: string; first: string } {
    const trimmed = (full || '').trim()
    if (!trimmed) return { last: '', first: '' }
    const idx = trimmed.lastIndexOf(' ')
    if (idx === -1) return { last: trimmed, first: '' }
    return { last: trimmed.slice(idx + 1), first: trimmed.slice(0, idx) }
  }

  function vestingDesc(vestMonths: number | null | undefined, cliffMonths: number | null | undefined): string {
    const v = vestMonths || 0
    const c = cliffMonths || 0
    if (!v) return ''
    const cliffPart = c === 0 ? 'no cliff' : (c % 12 === 0 ? `${c / 12}-year cliff` : `${c}-month cliff`)
    return `1/${v} monthly, ${cliffPart}`
  }

  let r = 1

  // ---- Title block ----
  ws.mergeCells(r, 1, r, 9)
  const titleCell = ws.getCell(r, 1)
  titleCell.value = 'BOARD OPTION GRANT APPROVAL'
  titleCell.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' }, name: 'Calibri' }
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(r).height = 28
  r++

  ws.mergeCells(r, 1, r, 9)
  const subtitleCell = ws.getCell(r, 1)
  const formattedDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  subtitleCell.value = `${company.name}  —  ${roundName}  —  ${formattedDate}`
  subtitleCell.font = { italic: true, size: 11, name: 'Calibri', color: { argb: 'FF1E293B' } }
  subtitleCell.alignment = { horizontal: 'center' }
  r++

  ws.mergeCells(r, 1, r, 9)
  const confCell = ws.getCell(r, 1)
  confCell.value = 'Confidential'
  confCell.font = { italic: true, size: 10, color: { argb: 'FF64748B' }, name: 'Calibri' }
  confCell.alignment = { horizontal: 'center' }
  r += 2

  // ---- Section 1: Proposed new grants ----
  setSectionHeader(r, 'PROPOSED NEW GRANTS')
  r++

  // GRANTEE | GRANT DETAILS sub-headers
  ws.mergeCells(r, 1, r, 4)
  const granteeGroup = ws.getCell(r, 1)
  granteeGroup.value = 'GRANTEE'
  granteeGroup.font = blackBold
  granteeGroup.fill = subGroupFill
  granteeGroup.alignment = { horizontal: 'center', vertical: 'middle' }
  granteeGroup.border = allBorders
  ws.mergeCells(r, 5, r, 9)
  const detailGroup = ws.getCell(r, 5)
  detailGroup.value = 'GRANT DETAILS'
  detailGroup.font = blackBold
  detailGroup.fill = subGroupFill
  detailGroup.alignment = { horizontal: 'center', vertical: 'middle' }
  detailGroup.border = allBorders
  r++

  setColHeader(r, [
    'Last', 'First', 'Role / Category', 'Approval Status',
    'New Grant (# Options)', 'Exercise Price', 'Vesting',
    `% FD Securities Pre-${roundSuffix}`, `% FD Securities Post-${roundSuffix}`,
  ])
  r++

  for (const g of proposedGrants) {
    const { last, first } = splitName(g.recipient_name)
    ws.getCell(r, 1).value = last
    ws.getCell(r, 2).value = first
    ws.getCell(r, 3).value = g.recipient_type || ''
    ws.getCell(r, 4).value = g.approval_status || 'Pending'
    ws.getCell(r, 5).value = g.quantity
    ws.getCell(r, 5).numFmt = '#,##0'
    if (g.strike != null) {
      ws.getCell(r, 6).value = g.strike
      ws.getCell(r, 6).numFmt = '"$"#,##0.0000'
    }
    ws.getCell(r, 7).value = vestingDesc(g.vest_months, g.cliff_months)
    ws.getCell(r, 8).value = preFDS > 0 ? g.quantity / preFDS : 0
    ws.getCell(r, 8).numFmt = '0.000%'
    ws.getCell(r, 9).value = postFDS > 0 ? g.quantity / postFDS : 0
    ws.getCell(r, 9).numFmt = '0.000%'
    applyBorders(r)
    r++
  }

  // Total row
  ws.mergeCells(r, 1, r, 4)
  const totalLabel = ws.getCell(r, 1)
  totalLabel.value = 'TOTAL NEW GRANTS'
  totalLabel.font = whiteBold
  totalLabel.fill = sectionFill
  totalLabel.alignment = { horizontal: 'left', vertical: 'middle' }
  totalLabel.border = allBorders

  const totalQty = ws.getCell(r, 5)
  totalQty.value = proposedTotal
  totalQty.numFmt = '#,##0'
  totalQty.font = whiteBold
  totalQty.fill = sectionFill
  totalQty.border = allBorders

  for (let c = 6; c <= 7; c++) {
    const cell = ws.getCell(r, c)
    cell.font = whiteBold
    cell.fill = sectionFill
    cell.border = allBorders
  }

  const totalPctPre = ws.getCell(r, 8)
  totalPctPre.value = preFDS > 0 ? proposedTotal / preFDS : 0
  totalPctPre.numFmt = '0.000%'
  totalPctPre.font = whiteBold
  totalPctPre.fill = sectionFill
  totalPctPre.border = allBorders

  const totalPctPost = ws.getCell(r, 9)
  totalPctPost.value = postFDS > 0 ? proposedTotal / postFDS : 0
  totalPctPost.numFmt = '0.000%'
  totalPctPost.font = whiteBold
  totalPctPost.fill = sectionFill
  totalPctPost.border = allBorders
  r += 2

  // ---- Section 2: Total ownership summary for new grantees ----
  setSectionHeader(r, 'TOTAL OWNERSHIP SUMMARY FOR NEW GRANTEES')
  r++

  setColHeader(r, [
    'Last', 'First', 'New Grant', 'Outstanding Options',
    'Common Stock', 'Preferred Stock', 'Total Securities',
    `% FD Securities Pre-${roundSuffix}`, `% FD Securities Post-${roundSuffix}`,
  ])
  r++

  let sumNew = 0, sumOut = 0, sumCommon = 0, sumPref = 0, sumTotal = 0
  for (const g of proposedGrants) {
    const { last, first } = splitName(g.recipient_name)
    const existing = g.stakeholder_id ? positionByStakeholder.get(g.stakeholder_id) : null
    const existingOptions = (g.stakeholder_id ? outstandingOptionsByStakeholder.get(g.stakeholder_id) : 0) || 0
    const common = existing?.common || 0
    const preferred = existing?.preferred || 0
    const total = g.quantity + existingOptions + common + preferred

    ws.getCell(r, 1).value = last
    ws.getCell(r, 2).value = first
    ws.getCell(r, 3).value = g.quantity
    ws.getCell(r, 4).value = existingOptions
    ws.getCell(r, 5).value = common
    ws.getCell(r, 6).value = preferred
    ws.getCell(r, 7).value = total
    for (let c = 3; c <= 7; c++) ws.getCell(r, c).numFmt = '#,##0'
    ws.getCell(r, 8).value = preFDS > 0 ? total / preFDS : 0
    ws.getCell(r, 9).value = postFDS > 0 ? total / postFDS : 0
    ws.getCell(r, 8).numFmt = '0.000%'
    ws.getCell(r, 9).numFmt = '0.000%'
    applyBorders(r)

    sumNew += g.quantity
    sumOut += existingOptions
    sumCommon += common
    sumPref += preferred
    sumTotal += total
    r++
  }

  // Total row for section 2
  ws.mergeCells(r, 1, r, 2)
  const sec2Label = ws.getCell(r, 1)
  sec2Label.value = 'TOTAL'
  sec2Label.font = whiteBold
  sec2Label.fill = sectionFill
  sec2Label.alignment = { horizontal: 'left', vertical: 'middle' }
  sec2Label.border = allBorders

  const sec2Values = [sumNew, sumOut, sumCommon, sumPref, sumTotal]
  sec2Values.forEach((v, i) => {
    const c = ws.getCell(r, 3 + i)
    c.value = v
    c.numFmt = '#,##0'
    c.font = whiteBold
    c.fill = sectionFill
    c.border = allBorders
  })
  const sec2Pct1 = ws.getCell(r, 8)
  sec2Pct1.value = preFDS > 0 ? sumTotal / preFDS : 0
  sec2Pct1.numFmt = '0.000%'
  sec2Pct1.font = whiteBold
  sec2Pct1.fill = sectionFill
  sec2Pct1.border = allBorders
  const sec2Pct2 = ws.getCell(r, 9)
  sec2Pct2.value = postFDS > 0 ? sumTotal / postFDS : 0
  sec2Pct2.numFmt = '0.000%'
  sec2Pct2.font = whiteBold
  sec2Pct2.fill = sectionFill
  sec2Pct2.border = allBorders
  r += 2

  // ---- Section 3: Option pool summary by category ----
  setSectionHeader(r, 'OPTION POOL SUMMARY (INCLUDING NEW GRANTS)')
  r++

  setColHeader(r, [
    'Category', 'Prior Grants', 'New Grants', 'Forfeited Grants',
    'Outstanding Options', 'Exercised Options', 'Outstanding + Exercised + New',
    `% FD Securities Pre-${roundSuffix}`, `% FD Securities Post-${roundSuffix}`,
  ])
  r++

  const categoryMap: Record<string, string[]> = {
    'Employees': ['employee'],
    'BoD / Advisors': ['board', 'board member', 'advisor', 'consultant', 'sab'],
    'Ex-Employees': ['ex-employee', 'former employee'],
  }
  const inCategory = (g: any, types: string[]) =>
    types.includes((g.recipient_type || '').toLowerCase())

  let catSumPrior = 0, catSumNew = 0, catSumForf = 0, catSumOutstanding = 0, catSumExercised = 0, catSumTotal = 0
  for (const [label, types] of Object.entries(categoryMap)) {
    const prior = allGrants.filter(g => g.status === 'outstanding' && inCategory(g, types)).reduce((a, g) => a + g.quantity, 0)
    const newG = proposedGrants.filter(g => inCategory(g, types)).reduce((a, g) => a + g.quantity, 0)
    const forf = -allGrants.filter(g => g.status === 'cancelled' && inCategory(g, types)).reduce((a, g) => a + g.quantity, 0)
    const outstanding = prior
    const exercised = 0 // not tracked
    const total = outstanding + exercised + newG

    ws.getCell(r, 1).value = label
    ws.getCell(r, 2).value = prior
    ws.getCell(r, 3).value = newG
    ws.getCell(r, 4).value = forf
    ws.getCell(r, 5).value = outstanding
    ws.getCell(r, 6).value = exercised
    ws.getCell(r, 7).value = total
    for (let c = 2; c <= 7; c++) ws.getCell(r, c).numFmt = '#,##0'
    ws.getCell(r, 8).value = preFDS > 0 ? total / preFDS : 0
    ws.getCell(r, 9).value = postFDS > 0 ? total / postFDS : 0
    ws.getCell(r, 8).numFmt = '0.000%'
    ws.getCell(r, 9).numFmt = '0.000%'
    applyBorders(r)

    catSumPrior += prior
    catSumNew += newG
    catSumForf += forf
    catSumOutstanding += outstanding
    catSumExercised += exercised
    catSumTotal += total
    r++
  }

  // Total allocated row
  const totRowVals = [catSumPrior, catSumNew, catSumForf, catSumOutstanding, catSumExercised, catSumTotal]
  ws.getCell(r, 1).value = 'TOTAL ALLOCATED'
  ws.getCell(r, 1).font = whiteBold
  ws.getCell(r, 1).fill = sectionFill
  ws.getCell(r, 1).border = allBorders
  totRowVals.forEach((v, i) => {
    const c = ws.getCell(r, 2 + i)
    c.value = v
    c.numFmt = '#,##0'
    c.font = whiteBold
    c.fill = sectionFill
    c.border = allBorders
  })
  ws.getCell(r, 8).value = preFDS > 0 ? catSumTotal / preFDS : 0
  ws.getCell(r, 8).numFmt = '0.000%'
  ws.getCell(r, 8).font = whiteBold
  ws.getCell(r, 8).fill = sectionFill
  ws.getCell(r, 8).border = allBorders
  ws.getCell(r, 9).value = postFDS > 0 ? catSumTotal / postFDS : 0
  ws.getCell(r, 9).numFmt = '0.000%'
  ws.getCell(r, 9).font = whiteBold
  ws.getCell(r, 9).fill = sectionFill
  ws.getCell(r, 9).border = allBorders
  r += 2

  // Authorized + remaining + total FD
  function summaryRow(label: string, value: number) {
    ws.mergeCells(r, 1, r, 6)
    const lab = ws.getCell(r, 1)
    lab.value = label
    lab.font = blackBold
    lab.alignment = { horizontal: 'left', vertical: 'middle' }
    lab.border = allBorders
    const v = ws.getCell(r, 7)
    v.value = value
    v.numFmt = '#,##0'
    v.font = blackBold
    v.border = allBorders
    ws.getCell(r, 8).value = preFDS > 0 ? value / preFDS : 0
    ws.getCell(r, 8).numFmt = '0.000%'
    ws.getCell(r, 8).border = allBorders
    ws.getCell(r, 9).value = postFDS > 0 ? value / postFDS : 0
    ws.getCell(r, 9).numFmt = '0.000%'
    ws.getCell(r, 9).border = allBorders
    r++
  }

  summaryRow('TOTAL OPTIONS AUTHORIZED', poolAuthorized)
  summaryRow('TOTAL OPTIONS REMAINING AFTER ABOVE GRANTS', Math.max(0, poolAuthorized - catSumTotal))
  // Total FD just for reference (no percent of itself).
  ws.mergeCells(r, 1, r, 6)
  const fdLab = ws.getCell(r, 1)
  fdLab.value = 'TOTAL FULLY DILUTED SECURITIES'
  fdLab.font = blackBold
  fdLab.alignment = { horizontal: 'left', vertical: 'middle' }
  fdLab.border = allBorders
  const fdVal = ws.getCell(r, 7)
  fdVal.value = postFDS
  fdVal.numFmt = '#,##0'
  fdVal.font = blackBold
  fdVal.border = allBorders
  for (let c = 8; c <= 9; c++) ws.getCell(r, c).border = allBorders
  r += 2

  // ---- Definitions ----
  setSectionHeader(r, 'DEFINITIONS')
  r++

  const definitions = [
    'Outstanding Securities = Common Shares + Preferred Shares + Warrants + Options Outstanding + other securities',
    'Fully Diluted Securities = Outstanding Securities + Options Authorized but Unissued*',
    'Options Authorized* = Granted Options – Forfeited Options + Unissued Options',
    'Granted Options = Options Outstanding + Options Exercised',
    'Options Outstanding = Vested & Unvested Options that have been Granted and neither Exercised nor Forfeited',
    '',
    '* under Equity Incentive Plan',
  ]
  for (const d of definitions) {
    ws.mergeCells(r, 1, r, 9)
    const c = ws.getCell(r, 1)
    c.value = d
    c.font = { size: 10, name: 'Calibri', color: { argb: 'FF1E293B' }, italic: d.startsWith('*') }
    c.alignment = { horizontal: 'left' }
    r++
  }

  // ---- Send ----
  const buffer = await wb.xlsx.writeBuffer() as Buffer
  const filename = `${company.slug}-board-approval-${new Date().toISOString().slice(0, 10)}.xlsx`
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  setHeader(event, 'Content-Length', String(buffer.byteLength))
  return buffer
})
