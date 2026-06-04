import ExcelJS from 'exceljs'
import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'
import { classifyAwardType } from '~~/server/utils/awardType'
import { MASTER_TABS, type MasterTab } from '~~/server/utils/masterTemplate'

// Master import: one relational workbook (see master-template) populates a
// company. Stakeholders are the hub; Holdings / grants / convertibles / ideas
// reference a person by Name. Designed for a fresh/empty company — entities
// are added; stakeholders + share classes + holdings upsert by their natural
// key so re-running doesn't duplicate them.

const norm = (s: any) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().replace(/\s+/g, ' ')
function cellStr(v: any): string {
  if (v == null) return ''
  if (typeof v === 'object') { if ('result' in v) return cellStr((v as any).result); if ('text' in v) return String((v as any).text); if ('richText' in v) return (v as any).richText.map((t: any) => t.text).join(''); return '' }
  return String(v)
}
function num(v: any): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'object' && 'result' in v) return num((v as any).result)
  const n = Number(String(v).replace(/[$,%\s]/g, ''))
  return Number.isFinite(n) ? n : null
}
function asDate(v: any): string | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object' && 'result' in v) return asDate((v as any).result)
  const s = cellStr(v).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

// Read a tab into row objects keyed by the spec keys. Finds the header row
// within the first 6 rows (tolerates the instruction note in row 1) and maps
// columns by header (a cell header that's a prefix of a spec header counts, so
// operators can trim parentheticals).
function readTab(ws: ExcelJS.Worksheet | undefined, tab: MasterTab): Record<string, any>[] {
  if (!ws) return []
  let headerRow = -1
  let colByKey: Record<string, number> = {}
  for (let r = 1; r <= Math.min(6, ws.rowCount); r++) {
    const map: Record<string, number> = {}
    ws.getRow(r).eachCell((cell, c) => {
      const h = norm(cellStr(cell.value))
      if (!h) return
      const col = tab.columns.find(cc => { const n = norm(cc.header); return n === h || n.startsWith(h) || h.startsWith(n) })
      if (col && !(col.key in map)) map[col.key] = c
    })
    if (Object.keys(map).length >= 2) { headerRow = r; colByKey = map; break }
  }
  if (headerRow < 0) return []
  const out: Record<string, any>[] = []
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const obj: Record<string, any> = {}
    let any = false
    for (const [key, c] of Object.entries(colByKey)) {
      const v = row.getCell(c).value
      obj[key] = v
      if (v != null && v !== '') any = true
    }
    if (any) out.push(obj)
  }
  return out
}
const tabSpec = (sheet: string) => MASTER_TABS.find(t => t.sheet === sheet)!

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })
  if (!db().prepare('SELECT id FROM companies WHERE id = ?').get(id)) throw createError({ statusCode: 404, message: 'Company not found' })

  const parts = await readMultipartFormData(event)
  const file = parts?.find(p => p.name === 'file' || p.filename)
  if (!file?.data) throw createError({ statusCode: 400, message: 'No file uploaded' })

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(file.data as any)
  const sheet = (name: string) => wb.worksheets.find(w => norm(w.name) === norm(name))

  const counts: Record<string, number> = { stakeholders: 0, holdings: 0, grants: 0, proposed: 0, convertibles: 0, rounds: 0, ideas: 0 }
  const warnings: string[] = []
  const today = new Date().toISOString().slice(0, 10)

  const insertSh = db().prepare('INSERT INTO stakeholders (id, company_id, name, type) VALUES (?, ?, ?, ?)')
  const insertClass = db().prepare('INSERT INTO share_classes (id, company_id, code, name, kind, seniority, authorized, issue_price) VALUES (?, ?, ?, ?, ?, 0, NULL, ?)')

  const tx = db().transaction(() => {
    // Stakeholder name → id (preload existing so we upsert, not duplicate).
    const nameToId = new Map<string, string>()
    for (const s of db().prepare('SELECT id, name FROM stakeholders WHERE company_id = ?').all(id) as any[]) nameToId.set(norm(s.name), s.id)
    const resolve = (raw: string): string | null => {
      const name = (raw || '').trim()
      const n = norm(name)
      if (!n) return null
      let sid = nameToId.get(n)
      if (!sid) { sid = newId('sh'); insertSh.run(sid, id, name, null); nameToId.set(n, sid) }
      return sid
    }

    // 1) Stakeholders (hub) — set comp metadata once.
    for (const row of readTab(sheet('Stakeholders'), tabSpec('Stakeholders'))) {
      const name = cellStr(row.name).trim()
      if (!name) continue
      const sid = resolve(name)!
      db().prepare(`UPDATE stakeholders SET type = COALESCE(?, type), title = ?, job_level = ?, start_date = ?, salary = ?, salary_midpoint = ?, benchmark_role = ? WHERE id = ?`)
        .run(cellStr(row.type).trim() || null, cellStr(row.title).trim() || null, cellStr(row.level).trim() || null, asDate(row.start_date), num(row.salary), num(row.salary_midpoint), cellStr(row.benchmark_role).trim() || null, sid)
      counts.stakeholders++
    }

    // 2) Holdings — upsert share classes by code, holdings by (stakeholder, class).
    const classByCode = new Map<string, string>()
    for (const sc of db().prepare('SELECT id, code FROM share_classes WHERE company_id = ?').all(id) as any[]) classByCode.set(norm(sc.code), sc.id)
    for (const row of readTab(sheet('Holdings'), tabSpec('Holdings'))) {
      const code = cellStr(row.class_code).trim()
      const sid = resolve(cellStr(row.stakeholder))
      if (!sid || !code) { warnings.push(`Holdings: skipped a row missing stakeholder or class code`); continue }
      let cid = classByCode.get(norm(code))
      if (!cid) {
        cid = newId('sc')
        const kind = norm(cellStr(row.kind)).includes('pref') ? 'preferred' : 'common'
        insertClass.run(cid, id, code, cellStr(row.class_name).trim() || code, kind, num(row.issue_price))
        classByCode.set(norm(code), cid)
      }
      const shares = Math.round(num(row.shares) || 0)
      db().prepare(`INSERT INTO holdings (company_id, stakeholder_id, share_class_id, shares) VALUES (?, ?, ?, ?)
        ON CONFLICT(stakeholder_id, share_class_id) DO UPDATE SET shares = excluded.shares`).run(id, sid, cid, shares)
      counts.holdings++
    }

    // 3) Option grants — one tab, three statuses. Issued → outstanding grant,
    //    Proposed → draft grant (Pending approval), Idea → a pool_events row
    //    (hypothetical future grant, not tied to a real stakeholder).
    const insertGr = db().prepare(`INSERT INTO grants
      (id, company_id, stakeholder_id, recipient_name, quantity, quantity_issued, strike, issue_date, vesting_start, vest_months, cliff_months, award_type, job_title, job_level, status, approval_status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const insertPe = db().prepare(`INSERT INTO pool_events
      (id, company_id, event_date, type, name, kind, shares, vest_months, cliff_months, notes, job_title, job_level)
      VALUES (?, ?, ?, 'grant', ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const row of readTab(sheet('Option grants'), tabSpec('Option grants'))) {
      const name = cellStr(row.stakeholder).trim()
      const qty = Math.round(num(row.quantity) || 0)
      if (!name || qty <= 0) continue
      const status = norm(cellStr(row.status))
      const vest = num(row.vest_months) != null ? Math.round(num(row.vest_months)!) : 48
      const cliff = num(row.cliff_months) != null ? Math.round(num(row.cliff_months)!) : 12
      const title = cellStr(row.job_title).trim() || null
      const level = cellStr(row.job_level).trim() || null
      const notes = cellStr(row.notes).trim() || null
      if (status.includes('idea')) {
        const k = classifyAwardType(row.award_type)
        insertPe.run(newId('pe'), id, asDate(row.issue_date) || today, name, k === 'ISO' ? 'ISO' : 'NSO', qty, vest, cliff, notes, title, level)
        counts.ideas++
        continue
      }
      const proposed = status.includes('propos')
      insertGr.run(newId('gr'), id, resolve(name), name, qty, qty, num(row.strike), asDate(row.issue_date), asDate(row.vesting_start),
        vest, cliff, classifyAwardType(row.award_type), title, level,
        proposed ? 'proposed' : 'outstanding', proposed ? 'Pending' : null, notes)
      if (proposed) counts.proposed++; else counts.grants++
    }

    // 4) Convertibles.
    const insertCn = db().prepare(`INSERT INTO convertibles
      (id, company_id, stakeholder_id, stakeholder_name, principal, interest_accrued, interest_rate, issue_date, maturity_date, valuation_cap, conversion_discount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const row of readTab(sheet('Convertibles'), tabSpec('Convertibles'))) {
      const name = cellStr(row.stakeholder).trim()
      const principal = num(row.principal)
      if (!name || !principal) continue
      insertCn.run(newId('cn'), id, resolve(name), name, principal, num(row.interest_accrued) || 0, num(row.interest_rate) || 0, asDate(row.issue_date), asDate(row.maturity_date), num(row.valuation_cap), num(row.discount) || 0)
      counts.convertibles++
    }

    // 5) Round history (FDS timeline).
    const insertMs = db().prepare('INSERT INTO cap_table_milestones (id, company_id, as_of_date, label, fds, pps, option_pool) VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const row of readTab(sheet('Round history'), tabSpec('Round history'))) {
      const d = asDate(row.as_of_date)
      if (!d) continue
      insertMs.run(newId('ms'), id, d, cellStr(row.label).trim() || null, num(row.fds), num(row.pps), num(row.option_pool))
      counts.rounds++
    }
  })
  tx()

  return { ok: true, counts, warnings }
})
