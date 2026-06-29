import ExcelJS from 'exceljs'
import { db } from '~~/server/utils/db'
import { grantIssued, authorizedPool, poolEquation } from '~~/shared/capTableModel'

// Generates a board-approval xlsx that follows the S3VC Option Grants
// Workbook template (tab 3, "Board Option Grant Approval"). Returned as a
// downloadable .xlsx attachment.
//
// Layout (per the board's preferred format):
//   1. Proposed new grants — Last, First, Role/Category, New Grant,
//      Exercise Price, Vesting, % FD Post.
//   2. Total ownership summary — Last, First, New Grant, Outstanding
//      Options, Common, Preferred, Total Securities, % FD Post,
//      Vesting Begin, Vesting Schedule, Notes. Sorted by Total desc.
//   3. Option pool summary by category — Prior / New / Forfeited /
//      Outstanding / Exercised / Total, with real lifecycle math.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  // Export scope (?scope=approved|proposed|ideas):
  //   approved → only proposed grants the board has marked Approved
  //   proposed → all live proposals (Approved + Pending; Rejected excluded)
  //   ideas    → the above PLUS anonymous pool ideas (future reserves)
  const scope = (() => {
    const s = String(getQuery(event).scope || 'proposed').toLowerCase()
    return s === 'approved' || s === 'ideas' ? s : 'proposed'
  })()

  // ---- Gather data ----
  const company = db().prepare('SELECT * FROM companies WHERE id = ?').get(id) as any
  if (!company) throw createError({ statusCode: 404, message: 'Company not found' })

  const assumptions = db().prepare('SELECT * FROM assumptions WHERE company_id = ?').get(id) as any

  // ---- Canon sources (one data point, one source) ----
  // Grants (committed + proposed) and the option pool come from the SAME
  // /grants endpoint the Option Grants page reads; FDS / round name / pool
  // timeline come from round-summary + aggregate-round. We never re-query the
  // grants table directly here: the /grants endpoint lazily expires past-window
  // terminated grants and returns the reconciled lifecycle view, so reading the
  // raw table showed STALE grant data (shares still 'outstanding' that the
  // Grants page had already expired / the operator had since edited).
  interface SumRound { kind: string; name: string | null; code: string; option_pool_issued: number; total_shares_fds: number }
  interface AggResp { option_pool_total: number | null; derived_from_history?: boolean }
  interface GrantsResp { grants: any[]; pools: Array<{ authorized: number }> }
  const [grantsResp, summary, aggregate] = await Promise.all([
    (event.$fetch as any)(`/api/companies/${id}/grants`).catch(() => ({ grants: [], pools: [] })) as Promise<GrantsResp>,
    (event.$fetch as any)(`/api/companies/${id}/round-summary`).catch(() => null) as Promise<{ rounds: SumRound[] } | null>,
    (event.$fetch as any)(`/api/companies/${id}/aggregate-round`).catch(() => null) as Promise<AggResp | null>,
  ])
  const allGrants: any[] = grantsResp.grants || []

  // Committed/proposed grants for sections 1 & 2 — filtered off canon by scope:
  //   approved → only board-Approved proposals
  //   proposed → all live proposals (Approved + Pending; Rejected excluded)
  // Sorted largest-first, matching the old query's ORDER BY quantity DESC.
  const proposedGrants: any[] = allGrants
    .filter(g => g.status === 'proposed'
      && (scope === 'approved'
        ? g.approval_status === 'Approved'
        : (g.approval_status == null || g.approval_status !== 'Rejected')))
    .sort((a, b) => (b.quantity || 0) - (a.quantity || 0))

  // Ideas: anonymous future reserves from the pool, surfaced as proposed-grant
  // rows (no strike/stakeholder). Their shares roll into the proposed total and
  // the post-FDS denominator just like real proposals.
  if (scope === 'ideas') {
    const ideas = db().prepare(`
      SELECT id, name, kind, shares, vest_months, cliff_months, notes, recipient_type
      FROM pool_events
      WHERE company_id = ? AND type IN ('grant', 'reserve') AND shares > 0
      ORDER BY shares DESC
    `).all(id) as any[]
    for (const ie of ideas) {
      proposedGrants.push({
        id: `idea:${ie.id}`,
        recipient_name: ie.name || 'Proposed',
        recipient_type: ie.recipient_type || 'Employees',
        award_type: ie.kind || null,
        quantity: ie.shares || 0,
        strike: null,
        vest_months: ie.vest_months ?? null,
        cliff_months: ie.cliff_months ?? null,
        vesting_start: null,
        vesting_schedule_id: null,
        stakeholder_id: null,
        status: 'proposed',
        approval_status: null,
      })
    }
  }

  // Cap-table reference data (separate canon: holdings / share classes). Pools
  // and grants come from the /grants endpoint above; vesting-schedule defs are
  // reference rows, not grant data.
  const shareClasses = db().prepare(`SELECT * FROM share_classes WHERE company_id = ?`).all(id) as any[]
  const holdings = db().prepare(`SELECT * FROM holdings WHERE company_id = ?`).all(id) as any[]
  const pools = grantsResp.pools || []
  const vestingSchedules = db().prepare(`SELECT id, name, vest_months, cliff_months FROM vesting_schedules WHERE company_id = ?`).all(id) as any[]
  const scheduleById = new Map<string, any>()
  for (const s of vestingSchedules) scheduleById.set(s.id, s)

  // ---- FDS / round name / pool from CANON (round-summary + aggregate, fetched
  //      above), never the legacy `assumptions` row or the raw option_pools lump.
  const sumRounds: SumRound[] = summary?.rounds || []
  // Current round mirrors the Rounds/dilution pages: the open round if flagged,
  // else the latest non-formation round.
  let curIdx = sumRounds.findIndex(r => r.kind === 'open')
  if (curIdx < 0) {
    for (let i = sumRounds.length - 1; i >= 0; i--) {
      if (sumRounds[i]!.kind !== 'formation') { curIdx = i; break }
    }
  }
  const curRound = curIdx >= 0 ? sumRounds[curIdx]! : null
  const priorRound = curIdx > 0 ? sumRounds[curIdx - 1]! : null
  const openRound = sumRounds.find(r => r.kind === 'open') || null

  const holdingsTotal = holdings.reduce((a, h) => a + (h.shares || 0), 0)
  const outstandingTotal = allGrants.filter(g => g.status === 'outstanding').reduce((a, g) => a + g.quantity, 0)
  const proposedTotal = proposedGrants.reduce((a, g) => a + g.quantity, 0)

  // Authorized pool — the SAME canonical helper the Grants / Pool Impact / board
  // slide use (timeline total + the open round's own issued, else Σ typed pool,
  // else the option_pools lump). The raw option_pools sum ignored pool shares
  // the operator typed onto rounds, so it read stale.
  const poolAuthorizedGross = authorizedPool({
    hasTimeline: !!aggregate?.derived_from_history,
    timelinePoolTotal: aggregate?.option_pool_total || 0,
    openRoundPoolIssued: openRound?.option_pool_issued || 0,
    allRoundsPoolIssued: sumRounds.reduce((a, r) => a + (r.option_pool_issued || 0), 0),
    poolsLump: pools.reduce((a, p) => a + (p.authorized || 0), 0),
  })
  // Exercised / forfeited / expired off the SAME outstanding-grant set the board
  // slide aggregates, then run the SHARED poolEquation so Authorized is net of
  // exercised (those options converted to common — FDS, not the pool) exactly
  // like the slide, Grants page, and round-summary. Exercised stays visible in
  // section 3 as an informational column, but it is NOT pool-allocated.
  const exercisedTotal = allGrants
    .filter(g => g.status === 'outstanding')
    .reduce((a, g) => a + (g.quantity_exercised || 0), 0)
  const forfeitedOrExpiredTotal = allGrants
    .filter(g => g.status === 'outstanding')
    .reduce((a, g) => a + (g.quantity_forfeited || 0) + (g.quantity_expired || 0), 0)
  const poolEq = poolEquation({
    authorized: poolAuthorizedGross,
    outstanding: outstandingTotal,
    exercised: exercisedTotal,
    forfeitedOrExpired: forfeitedOrExpiredTotal,
    proposed: proposedTotal,
    ideas: 0,
    includeIdeas: false,
  })
  const poolAuthorized = poolEq.authorized            // = gross − exercised (canon net)
  const optionsAvailable = Math.max(0, poolEq.futureAvailable) // net − outstanding − proposed
  const fdsFromCapTable = holdingsTotal + outstandingTotal + optionsAvailable + (assumptions?.pool_top_up_shares || 0)

  // postFDS = the current round's cumulative Total FDS (the denominator every
  // ownership % divides by); preFDS = the prior round's. round-summary nets
  // exercised options, honors pinned snapshots, and derives the share price the
  // board-workbook way — we just consume it. Fallback only when no rounds exist.
  const preFDS = (priorRound?.total_shares_fds && priorRound.total_shares_fds > 0)
    ? priorRound.total_shares_fds
    : (assumptions?.pre_round_fds ?? fdsFromCapTable)
  const postFDS = (curRound?.total_shares_fds && curRound.total_shares_fds > 0)
    ? curRound.total_shares_fds
    : preFDS

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
  // Round name is the CURRENT (open) round from canon — so renaming or flipping
  // the open round on the Rounds page flows straight through to the export
  // header and the "% FD Post-<round>" column. assumptions/baseline are only
  // fallbacks for a company with no rounds entered yet.
  const roundName: string = (curRound?.name || curRound?.code) || baselineRoundName || assumptions?.round_name || 'Round'
  // "Series B" -> "B", "Series A-2" -> "A-2", "Bridge" -> "Bridge"
  const roundSuffix = roundName.replace(/^Series\s+/i, '')
  const pctPostHeader = `% FD Securities Post-${roundSuffix}`

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
  wb.creator = 'Pariva'
  wb.created = new Date()
  const ws = wb.addWorksheet('Board Approval', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
    properties: { defaultRowHeight: 15 },
  })

  const LAST_COL = 11
  ws.columns = [
    { width: 18 }, // A — Last
    { width: 14 }, // B — First
    { width: 18 }, // C — Role / Category
    { width: 16 }, // D — New Grant
    { width: 14 }, // E — Exercise Price
    { width: 26 }, // F — Vesting
    { width: 16 }, // G — Total Securities / % FD Post
    { width: 16 }, // H — % FD Post
    { width: 14 }, // I — Vesting Begin
    { width: 22 }, // J — Vesting Schedule
    { width: 42 }, // K — Notes
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
    ws.mergeCells(row, 1, row, LAST_COL)
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

  function applyBorders(row: number, startCol = 1, endCol = LAST_COL) {
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

  // "Vesting Schedule" label — prefer the operator-named schedule, else
  // derive a friendly label from the grant's own vest/cliff months.
  function scheduleLabel(g: any): string {
    const sched = g.vesting_schedule_id ? scheduleById.get(g.vesting_schedule_id) : null
    if (sched?.name) return sched.name
    const vm = g.vest_months ?? 48
    const cm = g.cliff_months ?? 12
    if (vm === 48 && cm === 12) return 'Standard 4-year vest'
    const yrs = vm % 12 === 0 ? `${vm / 12}-year vest` : `${vm}-month vest`
    return cm === 0 ? `${yrs}, no cliff` : yrs
  }

  function setDateCell(row: number, col: number, raw: string | null | undefined) {
    if (!raw) return
    const d = new Date(`${String(raw).slice(0, 10)}T00:00:00`)
    if (isNaN(d.getTime())) { ws.getCell(row, col).value = String(raw); return }
    const cell = ws.getCell(row, col)
    cell.value = d
    cell.numFmt = 'm/d/yy'
  }

  // ---- Formula helpers ----
  // Cells carry live Excel formulas so the sheet recalculates when an
  // operator edits an input. We still pass a `result` so viewers that don't
  // recalc on open (and our own tests) show the right number immediately.
  function colLetter(n: number): string {
    let s = ''
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) }
    return s
  }
  const cellAddr = (col: number, row: number) => `${colLetter(col)}${row}`
  const absAddr = (col: number, row: number) => `$${colLetter(col)}$${row}`
  const setFormula = (row: number, col: number, formula: string, result: number) => {
    ws.getCell(row, col).value = { formula, result }
  }

  // The % FD column divides by the Post-Round FDS cell, which is written in
  // the footer below these rows. Collect them and resolve once we know that
  // cell's address (forward references are valid in Excel).
  const pctCells: { row: number; col: number; numerator: string; result: number }[] = []
  const setPct = (row: number, col: number, numerator: string, result: number) => {
    pctCells.push({ row, col, numerator, result })
  }

  let r = 1

  // ---- Title block ----
  ws.mergeCells(r, 1, r, LAST_COL)
  const titleCell = ws.getCell(r, 1)
  titleCell.value = 'BOARD OPTION GRANT APPROVAL'
  titleCell.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' }, name: 'Calibri' }
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(r).height = 28
  r++

  ws.mergeCells(r, 1, r, LAST_COL)
  const subtitleCell = ws.getCell(r, 1)
  const formattedDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  subtitleCell.value = `${company.name}  —  ${roundName}  —  ${formattedDate}`
  subtitleCell.font = { italic: true, size: 11, name: 'Calibri', color: { argb: 'FF1E293B' } }
  subtitleCell.alignment = { horizontal: 'center' }
  r++

  ws.mergeCells(r, 1, r, LAST_COL)
  const confCell = ws.getCell(r, 1)
  confCell.value = 'Confidential'
  confCell.font = { italic: true, size: 10, color: { argb: 'FF64748B' }, name: 'Calibri' }
  confCell.alignment = { horizontal: 'center' }
  r += 2

  // ---- Section 1: Proposed new grants ----
  setSectionHeader(r, 'COMMITTED NEW GRANTS')
  r++

  // GRANTEE | GRANT DETAILS sub-headers
  ws.mergeCells(r, 1, r, 3)
  const granteeGroup = ws.getCell(r, 1)
  granteeGroup.value = 'GRANTEE'
  granteeGroup.font = blackBold
  granteeGroup.fill = subGroupFill
  granteeGroup.alignment = { horizontal: 'center', vertical: 'middle' }
  granteeGroup.border = allBorders
  ws.mergeCells(r, 4, r, 7)
  const detailGroup = ws.getCell(r, 4)
  detailGroup.value = 'GRANT DETAILS'
  detailGroup.font = blackBold
  detailGroup.fill = subGroupFill
  detailGroup.alignment = { horizontal: 'center', vertical: 'middle' }
  detailGroup.border = allBorders
  r++

  setColHeader(r, [
    'Last', 'First', 'Role / Category',
    'New Grant (# Options)', 'Exercise Price', 'Vesting', pctPostHeader,
  ])
  r++

  const sec1First = r
  for (const g of proposedGrants) {
    const { last, first } = splitName(g.recipient_name)
    ws.getCell(r, 1).value = last
    ws.getCell(r, 2).value = first
    ws.getCell(r, 3).value = g.recipient_type || ''
    ws.getCell(r, 4).value = g.quantity
    ws.getCell(r, 4).numFmt = '#,##0'
    if (g.strike != null) {
      ws.getCell(r, 5).value = g.strike
      ws.getCell(r, 5).numFmt = '"$"#,##0.0000'
    }
    ws.getCell(r, 6).value = vestingDesc(g.vest_months, g.cliff_months)
    ws.getCell(r, 7).numFmt = '0.000%'
    setPct(r, 7, cellAddr(4, r), postFDS > 0 ? g.quantity / postFDS : 0)
    applyBorders(r, 1, 7)
    r++
  }
  const sec1Last = r - 1
  const sec1Count = proposedGrants.length

  // Total row
  ws.mergeCells(r, 1, r, 3)
  const totalLabel = ws.getCell(r, 1)
  totalLabel.value = 'TOTAL NEW GRANTS'
  totalLabel.font = whiteBold
  totalLabel.fill = sectionFill
  totalLabel.alignment = { horizontal: 'left', vertical: 'middle' }
  totalLabel.border = allBorders

  const totalQty = ws.getCell(r, 4)
  if (sec1Count > 0) totalQty.value = { formula: `SUM(${cellAddr(4, sec1First)}:${cellAddr(4, sec1Last)})`, result: proposedTotal }
  else totalQty.value = 0
  totalQty.numFmt = '#,##0'
  totalQty.font = whiteBold
  totalQty.fill = sectionFill
  totalQty.border = allBorders

  for (let c = 5; c <= 6; c++) {
    const cell = ws.getCell(r, c)
    cell.font = whiteBold
    cell.fill = sectionFill
    cell.border = allBorders
  }

  const sec1TotalRow = r
  ws.getCell(r, 7).numFmt = '0.000%'
  ws.getCell(r, 7).font = whiteBold
  ws.getCell(r, 7).fill = sectionFill
  ws.getCell(r, 7).border = allBorders
  setPct(sec1TotalRow, 7, cellAddr(4, sec1TotalRow), postFDS > 0 ? proposedTotal / postFDS : 0)
  r += 2

  // ---- Section 2: Total ownership summary for new grantees ----
  setSectionHeader(r, 'TOTAL OWNERSHIP SUMMARY FOR NEW GRANTEES')
  r++

  setColHeader(r, [
    'Last', 'First', 'New Grant', 'Outstanding Options',
    'Common Stock', 'Preferred Stock', 'Total Securities', pctPostHeader,
    'Vesting Begin', 'Vesting Schedule', 'Notes',
  ])
  r++

  // Build rows first so we can sort by Total Securities descending.
  const sec2Rows = proposedGrants.map(g => {
    const existing = g.stakeholder_id ? positionByStakeholder.get(g.stakeholder_id) : null
    const existingOptions = (g.stakeholder_id ? outstandingOptionsByStakeholder.get(g.stakeholder_id) : 0) || 0
    const common = existing?.common || 0
    const preferred = existing?.preferred || 0
    const total = g.quantity + existingOptions + common + preferred
    return { g, existingOptions, common, preferred, total }
  }).sort((a, b) => b.total - a.total)

  let sumNew = 0, sumOut = 0, sumCommon = 0, sumPref = 0, sumTotal = 0
  const sec2First = r
  for (const row of sec2Rows) {
    const { g, existingOptions, common, preferred, total } = row
    const { last, first } = splitName(g.recipient_name)
    ws.getCell(r, 1).value = last
    ws.getCell(r, 2).value = first
    ws.getCell(r, 3).value = g.quantity
    ws.getCell(r, 4).value = existingOptions
    ws.getCell(r, 5).value = common
    ws.getCell(r, 6).value = preferred
    // Total Securities = New + Outstanding + Common + Preferred
    setFormula(r, 7, `${cellAddr(3, r)}+${cellAddr(4, r)}+${cellAddr(5, r)}+${cellAddr(6, r)}`, total)
    for (let c = 3; c <= 7; c++) ws.getCell(r, c).numFmt = '#,##0'
    ws.getCell(r, 8).numFmt = '0.000%'
    setPct(r, 8, cellAddr(7, r), postFDS > 0 ? total / postFDS : 0)
    setDateCell(r, 9, g.vesting_start)
    ws.getCell(r, 10).value = scheduleLabel(g)
    ws.getCell(r, 11).value = g.notes || ''
    ws.getCell(r, 11).alignment = { wrapText: true, vertical: 'top' }
    applyBorders(r)

    sumNew += g.quantity
    sumOut += existingOptions
    sumCommon += common
    sumPref += preferred
    sumTotal += total
    r++
  }
  const sec2Last = r - 1
  const sec2Count = sec2Rows.length

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
    const col = 3 + i
    const c = ws.getCell(r, col)
    if (sec2Count > 0) c.value = { formula: `SUM(${cellAddr(col, sec2First)}:${cellAddr(col, sec2Last)})`, result: v }
    else c.value = 0
    c.numFmt = '#,##0'
    c.font = whiteBold
    c.fill = sectionFill
    c.border = allBorders
  })
  const sec2TotalRow = r
  ws.getCell(r, 8).numFmt = '0.000%'
  ws.getCell(r, 8).font = whiteBold
  ws.getCell(r, 8).fill = sectionFill
  ws.getCell(r, 8).border = allBorders
  setPct(sec2TotalRow, 8, cellAddr(7, sec2TotalRow), postFDS > 0 ? sumTotal / postFDS : 0)
  for (let c = 9; c <= LAST_COL; c++) {
    const cell = ws.getCell(r, c)
    cell.font = whiteBold
    cell.fill = sectionFill
    cell.border = allBorders
  }
  r += 2

  // ---- Section 3: Option pool summary by category ----
  setSectionHeader(r, 'OPTION POOL SUMMARY (INCLUDING NEW GRANTS)')
  r++

  setColHeader(r, [
    'Category', 'Prior Grants', 'New Grants', 'Forfeited Grants',
    'Outstanding Options', 'Exercised (→ Common)', 'Outstanding + New', pctPostHeader,
  ])
  r++

  // Map a grant's recipient_type to one of the three board buckets.
  const CATEGORIES = ['Employees', 'BoD / Advisors', 'Ex-Employees'] as const
  type Cat = typeof CATEGORIES[number]
  function catOf(type: string | null | undefined): Cat {
    const t = (type || '').toLowerCase().trim()
    if (t === 'employee' || t === 'employees') return 'Employees'
    if (t.startsWith('ex-') || t.startsWith('ex ') || t.startsWith('former')) return 'Ex-Employees'
    // advisor, board, board member, bod, sab, kol, consultant, etc.
    return 'BoD / Advisors'
  }

  // Per-category lifecycle aggregation.
  //   issued (Prior) = quantity_issued ?? quantity
  //   forfExp        = forfeited + expired (both return to the pool)
  //   outstanding    = issued − exercised − forfExp
  //   Total          = outstanding + new. Exercised converted to common (FDS,
  //                    not the pool) so it's netted out of Authorized above and
  //                    shown here only as an informational column — like
  //                    forfeited/expired, it is NOT pool-allocated.
  const agg: Record<Cat, { issued: number; exercised: number; forfExp: number; outstanding: number; newG: number }> = {
    'Employees':      { issued: 0, exercised: 0, forfExp: 0, outstanding: 0, newG: 0 },
    'BoD / Advisors': { issued: 0, exercised: 0, forfExp: 0, outstanding: 0, newG: 0 },
    'Ex-Employees':   { issued: 0, exercised: 0, forfExp: 0, outstanding: 0, newG: 0 },
  }
  for (const g of allGrants) {
    if (g.status !== 'outstanding') continue
    const a = agg[catOf(g.recipient_type)]
    const issued = grantIssued(g)
    const exercised = g.quantity_exercised || 0
    const forfExp = (g.quantity_forfeited || 0) + (g.quantity_expired || 0)
    a.issued += issued
    a.exercised += exercised
    a.forfExp += forfExp
    a.outstanding += (issued - exercised - forfExp)
  }
  for (const g of proposedGrants) agg[catOf(g.recipient_type)].newG += g.quantity

  let catPrior = 0, catNew = 0, catForf = 0, catOut = 0, catEx = 0, catTotal = 0
  const sec3First = r
  for (const label of CATEGORIES) {
    const a = agg[label]
    const prior = a.issued
    const forf = -a.forfExp
    // Total (allocated from pool) = Outstanding + New. Exercised converted to
    // common (FDS, not the pool) and forfeited/expired returned to the pool, so
    // neither is allocated — both are informational columns. Authorized is net
    // of exercised above, so Remaining = Authorized(net) − (Outstanding + New).
    const total = a.outstanding + a.newG

    ws.getCell(r, 1).value = label
    ws.getCell(r, 2).value = prior
    ws.getCell(r, 3).value = a.newG
    ws.getCell(r, 4).value = forf
    // Outstanding = Prior(issued) + Forfeited(stored negative) − Exercised.
    setFormula(r, 5, `${cellAddr(2, r)}+${cellAddr(4, r)}-${cellAddr(6, r)}`, a.outstanding)
    ws.getCell(r, 6).value = a.exercised
    // Total = Outstanding + New (exercised excluded — it's common now, not pool).
    setFormula(r, 7, `${cellAddr(5, r)}+${cellAddr(3, r)}`, total)
    for (let c = 2; c <= 7; c++) ws.getCell(r, c).numFmt = '#,##0;(#,##0)'
    ws.getCell(r, 8).numFmt = '0.000%'
    setPct(r, 8, cellAddr(7, r), postFDS > 0 ? total / postFDS : 0)
    applyBorders(r, 1, 8)

    catPrior += prior; catNew += a.newG; catForf += forf
    catOut += a.outstanding; catEx += a.exercised; catTotal += total
    r++
  }

  // Total allocated row
  const sec3Last = r - 1
  const totRowVals = [catPrior, catNew, catForf, catOut, catEx, catTotal]
  ws.getCell(r, 1).value = 'TOTAL ALLOCATED'
  ws.getCell(r, 1).font = whiteBold
  ws.getCell(r, 1).fill = sectionFill
  ws.getCell(r, 1).border = allBorders
  totRowVals.forEach((v, i) => {
    const col = 2 + i
    const c = ws.getCell(r, col)
    c.value = { formula: `SUM(${cellAddr(col, sec3First)}:${cellAddr(col, sec3Last)})`, result: v }
    c.numFmt = '#,##0;(#,##0)'
    c.font = whiteBold
    c.fill = sectionFill
    c.border = allBorders
  })
  const allocRow = r
  ws.getCell(r, 8).numFmt = '0.000%'
  ws.getCell(r, 8).font = whiteBold
  ws.getCell(r, 8).fill = sectionFill
  ws.getCell(r, 8).border = allBorders
  setPct(allocRow, 8, cellAddr(7, allocRow), postFDS > 0 ? catTotal / postFDS : 0)
  r += 2

  // Authorized + remaining + the two FDS basis cells.
  // Writes the label across cols 1-6 and returns the row so callers can
  // populate the value (col 7) and % (col 8) with formulas.
  function labelRow(label: string): number {
    ws.mergeCells(r, 1, r, 6)
    const lab = ws.getCell(r, 1)
    lab.value = label
    lab.font = blackBold
    lab.alignment = { horizontal: 'left', vertical: 'middle' }
    lab.border = allBorders
    return r++
  }

  // TOTAL OPTIONS AUTHORIZED — net of exercised (those converted to common —
  // FDS, not the pool), matching the live reserve shown on the Grants / Pool
  // Impact pages and the board slide.
  const authRow = labelRow('TOTAL OPTIONS AUTHORIZED (NET OF EXERCISED)')
  ws.getCell(authRow, 7).value = poolAuthorized
  ws.getCell(authRow, 7).numFmt = '#,##0'
  ws.getCell(authRow, 7).font = blackBold
  ws.getCell(authRow, 7).border = allBorders
  ws.getCell(authRow, 8).numFmt = '0.000%'
  ws.getCell(authRow, 8).border = allBorders
  setPct(authRow, 8, cellAddr(7, authRow), postFDS > 0 ? poolAuthorized / postFDS : 0)

  // TOTAL OPTIONS REMAINING = Authorized − Allocated
  const remRow = labelRow('TOTAL OPTIONS REMAINING AFTER ABOVE GRANTS')
  const remaining = Math.max(0, poolAuthorized - catTotal)
  setFormula(remRow, 7, `MAX(${cellAddr(7, authRow)}-${cellAddr(7, allocRow)},0)`, remaining)
  ws.getCell(remRow, 7).numFmt = '#,##0'
  ws.getCell(remRow, 7).font = blackBold
  ws.getCell(remRow, 7).border = allBorders
  ws.getCell(remRow, 8).numFmt = '0.000%'
  ws.getCell(remRow, 8).border = allBorders
  setPct(remRow, 8, cellAddr(7, remRow), postFDS > 0 ? remaining / postFDS : 0)

  // Pre-Round FDS — the board's "Total Fully Diluted Securities" reference.
  const preRow = labelRow('TOTAL FULLY DILUTED SECURITIES (PRE-ROUND)')
  ws.getCell(preRow, 7).value = preFDS
  ws.getCell(preRow, 7).numFmt = '#,##0'
  ws.getCell(preRow, 7).font = blackBold
  ws.getCell(preRow, 7).border = allBorders
  ws.getCell(preRow, 8).border = allBorders

  // Post-Round FDS — the basis every % column divides by.
  const postFDSRow = labelRow('POST-ROUND FULLY DILUTED SECURITIES')
  ws.getCell(postFDSRow, 7).value = postFDS
  ws.getCell(postFDSRow, 7).numFmt = '#,##0'
  ws.getCell(postFDSRow, 7).font = blackBold
  ws.getCell(postFDSRow, 7).border = allBorders
  ws.getCell(postFDSRow, 8).border = allBorders
  r++

  // Resolve every deferred % cell now that the Post-Round FDS cell exists.
  const postRef = postFDS > 0 ? absAddr(7, postFDSRow) : null
  for (const p of pctCells) {
    if (postRef) ws.getCell(p.row, p.col).value = { formula: `IFERROR(${p.numerator}/${postRef},0)`, result: p.result }
    else ws.getCell(p.row, p.col).value = p.result
  }

  // ---- Definitions ----
  setSectionHeader(r, 'DEFINITIONS')
  r++

  const definitions = [
    'Outstanding Securities = Common Shares + Preferred Shares + Warrants + Options Outstanding + other securities',
    'Fully Diluted Securities = Outstanding Securities + Options Authorized but Unissued*',
    'Options Authorized (net)* = Authorized Reserve − Exercised Options (which convert to Common and count in FDS, not the pool)',
    'Options Outstanding = Vested & Unvested Options that have been Granted and neither Exercised nor Forfeited',
    'Options Remaining = Options Authorized (net) − (Options Outstanding + New Grants); forfeited/expired return to the pool',
    '',
    '* under Equity Incentive Plan',
  ]
  for (const d of definitions) {
    ws.mergeCells(r, 1, r, LAST_COL)
    const c = ws.getCell(r, 1)
    c.value = d
    c.font = { size: 10, name: 'Calibri', color: { argb: 'FF1E293B' }, italic: d.startsWith('*') }
    c.alignment = { horizontal: 'left' }
    r++
  }

  // ---- Send ----
  const buffer = await wb.xlsx.writeBuffer() as Buffer
  const scopeTag = scope === 'approved' ? 'approved' : scope === 'ideas' ? 'with-ideas' : 'proposed'
  const filename = `${company.slug}-board-approval-${scopeTag}-${new Date().toISOString().slice(0, 10)}.xlsx`
  setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  setHeader(event, 'Content-Disposition', `attachment; filename="${filename}"`)
  setHeader(event, 'Content-Length', String(buffer.byteLength))
  return buffer
})
