import { db } from '~~/server/utils/db'
import {
  authorizedPool, poolEquation, grantIssued, grantOutstanding, newSharesIssued,
} from '~~/shared/capTableModel'

// CEO Report — a self-contained, print-ready visual briefing on the company's
// equity & option program. Returned as a standalone HTML document (inline SVG
// charts, no external assets) so it opens straight in a browser tab and the CEO
// can hit "Print / Save as PDF". One file, no dependencies.
//
// The headline figures (post-round FDS, authorized/available pool) are pulled
// from the SAME endpoints the Option Grants page reads — round-summary,
// aggregate-round, cap-table — so the report can't drift from the app. The rest
// (top/bottom holders, vesting status, tenure watch, activity) is computed here
// from the grant ledger + stakeholder roster.

interface Grant {
  id: string
  stakeholder_id: string | null
  recipient_name: string
  recipient_type: string | null
  quantity: number
  strike: number | null
  issue_date: string | null
  vesting_start: string | null
  vest_months: number | null
  cliff_months: number | null
  status: string
  approval_status: string | null
  notes: string | null
  award_type: string | null
  created_at: string | null
  quantity_issued?: number | null
  quantity_exercised?: number | null
  quantity_forfeited?: number | null
  quantity_expired?: number | null
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  // ---- Gather data (mirrors what the Grants page loads) ----
  // URLs are cast to `any` so the typed-route inference doesn't collapse the
  // dynamic `${id}` paths to `never`; each result is given a concrete shape via
  // the fallback + cast. A failed fetch falls back to an empty value so the
  // report still renders (e.g. a fresh company with no rounds yet).
  // $fetch is cast to `any` to bypass the typed-route overloads (their literal
  // route union blows TS's recursion limit on dynamic `${id}` URLs — the same
  // pre-existing issue the Grants page hits on every $fetch).
  async function fetchJson<T>(url: string, fallback: T, opts?: Record<string, any>): Promise<T> {
    try { return (await (event.$fetch as any)(url, opts)) as T } catch { return fallback }
  }
  interface AggregateResp { total_shares_fds: number | null; option_pool_total: number | null; derived_from_history?: boolean }
  const [grantsResp, roundSummary, aggregate, capTable, poolEventsRaw, compute] = await Promise.all([
    fetchJson<{ grants: Grant[]; pools: Array<{ authorized: number }> }>(`/api/companies/${id}/grants`, { grants: [], pools: [] }),
    fetchJson<{ rounds: any[] }>(`/api/companies/${id}/round-summary`, { rounds: [] }),
    fetchJson<AggregateResp>(`/api/companies/${id}/aggregate-round`, { total_shares_fds: null, option_pool_total: null }),
    fetchJson<any>(`/api/companies/${id}/cap-table`, null),
    fetchJson<any[]>(`/api/companies/${id}/pool-events`, []),
    fetchJson<any>(`/api/companies/${id}/compute`, null, { method: 'POST' }),
  ])

  const company = capTable?.company || db().prepare('SELECT * FROM companies WHERE id = ?').get(id) as any
  if (!company) throw createError({ statusCode: 404, message: 'Company not found' })

  // Stakeholder roster with employment start dates — only available in the DB
  // (the cap-table endpoint doesn't surface start_date). Powers the tenure
  // watch ("longest-tenured people without an option grant").
  const roster = db().prepare(
    'SELECT id, name, type, start_date, linked_to FROM stakeholders WHERE company_id = ?',
  ).all(id) as Array<{ id: string; name: string; type: string | null; start_date: string | null; linked_to: string | null }>

  const grants: Grant[] = grantsResp.grants || []
  const outstanding = grants.filter(g => g.status === 'outstanding')
  const proposed = grants.filter(g => g.status === 'proposed')

  // ---- FDS / pool headline figures (canonical, via the shared model) ----
  const rounds: any[] = roundSummary.rounds || []
  const openRound = rounds.find(r => r.kind === 'open')
  const currentRound = openRound || rounds.filter(r => r.kind !== 'formation').slice(-1)[0] || null
  const base = aggregate?.total_shares_fds && aggregate.total_shares_fds > 0 ? aggregate.total_shares_fds : 0

  const poolAuthorized = authorizedPool({
    hasTimeline: !!aggregate?.derived_from_history,
    timelinePoolTotal: aggregate?.option_pool_total || 0,
    openRoundPoolIssued: openRound?.option_pool_issued || 0,
    allRoundsPoolIssued: rounds.reduce((a, r) => a + (r.option_pool_issued || 0), 0),
    poolsLump: (grantsResp.pools || []).reduce((a, p) => a + (p.authorized || 0), 0),
  })

  const totalIssued = outstanding.reduce((a, g) => a + grantIssued(g), 0)
  const totalOutstanding = outstanding.reduce((a, g) => a + grantOutstanding(g), 0)
  const totalExercised = outstanding.reduce((a, g) => a + (g.quantity_exercised || 0), 0)
  const totalForfeitedOrExpired = outstanding.reduce((a, g) => a + (g.quantity_forfeited || 0) + (g.quantity_expired || 0), 0)
  const totalProposed = proposed.reduce((a, g) => a + g.quantity, 0)
  const totalIdeas = (poolEventsRaw || [])
    .filter((e: any) => e.type === 'grant' || e.type === 'reserve')
    .reduce((a: number, e: any) => a + (e.shares || 0), 0)

  const pool = poolEquation({
    authorized: poolAuthorized,
    outstanding: totalOutstanding,
    exercised: totalExercised,
    forfeitedOrExpired: totalForfeitedOrExpired,
    proposed: totalProposed,
    ideas: totalIdeas,
    includeIdeas: false,
  })
  // Authorized NET of exercised — exercised options moved to common (FDS), so
  // they're no longer in the option pool. This is what the headline + donut show.
  const poolAuthorizedNet = pool.authorized

  const heldShares = capTable ? (capTable.holdings || []).reduce((a: number, h: any) => a + (h.shares || 0), 0) : 0
  const fdsAnchor = heldShares + totalOutstanding + Math.max(0, pool.available)
  const preFDS = base > 0 ? base : fdsAnchor
  const issuedNew = currentRound ? newSharesIssued(currentRound.new_money, currentRound.share_price) : 0
  const postFDS = base > 0
    ? base + issuedNew + (currentRound?.option_pool_issued || 0) + (currentRound?.notes_converted || 0)
    : preFDS
  const ppsAnchor = capTable?.current_pps || 0
  const postPPS = currentRound?.share_price || compute?.round?.pricePerShare || ppsAnchor

  // ---- Holder rollup (alias-aware) ----
  // Group outstanding options per person. Carta splits one human across several
  // stakeholder rows; resolve each to its canonical "primary" via linked_to so a
  // person's grants don't show up as separate small holders.
  const linkedTo = new Map<string, string | null>()
  for (const s of (capTable?.stakeholders || [])) linkedTo.set(s.id, s.linked_to || null)
  function primaryOf(sid: string): string {
    let cur = sid, depth = 0
    while (linkedTo.get(cur) && depth < 5) { cur = linkedTo.get(cur)!; depth++ }
    return cur
  }
  const holderMap = new Map<string, { name: string; shares: number; grants: number; role: string | null }>()
  for (const g of outstanding) {
    const key = g.stakeholder_id ? primaryOf(g.stakeholder_id) : `name:${(g.recipient_name || '').trim().toLowerCase()}`
    const row = holderMap.get(key) || { name: g.recipient_name || 'Unknown', shares: 0, grants: 0, role: g.recipient_type }
    row.shares += grantOutstanding(g)
    row.grants += 1
    if (!row.role && g.recipient_type) row.role = g.recipient_type
    holderMap.set(key, row)
  }
  const holders = [...holderMap.values()].filter(h => h.shares > 0).sort((a, b) => b.shares - a.shares)
  const numHolders = holders.length
  const top5 = holders.slice(0, 5)
  const bottom5 = holders.length > 5 ? holders.slice(-5).reverse() : []
  const top5Shares = top5.reduce((a, h) => a + h.shares, 0)
  const top5Concentration = totalOutstanding > 0 ? top5Shares / totalOutstanding : 0
  const avgGrant = numHolders > 0 ? totalOutstanding / numHolders : 0
  const sortedShares = holders.map(h => h.shares).sort((a, b) => a - b)
  const mid = Math.floor(sortedShares.length / 2)
  const medianHolder = sortedShares.length === 0
    ? 0
    : sortedShares.length % 2
      ? (sortedShares[mid] ?? 0)
      : ((sortedShares[mid - 1] ?? 0) + (sortedShares[mid] ?? 0)) / 2

  // ---- Distribution by board category ----
  function catOf(type: string | null | undefined): 'Employees' | 'BoD / Advisors' | 'Ex-Employees' {
    const t = (type || '').toLowerCase().trim()
    if (t === 'employee' || t === 'employees') return 'Employees'
    if (t.startsWith('ex-') || t.startsWith('ex ') || t.startsWith('former')) return 'Ex-Employees'
    return 'BoD / Advisors'
  }
  const catEmp = { shares: 0, count: 0 }
  const catBod = { shares: 0, count: 0 }
  const catEx = { shares: 0, count: 0 }
  for (const h of holders) {
    const c = catOf(h.role)
    const b = c === 'Employees' ? catEmp : c === 'Ex-Employees' ? catEx : catBod
    b.shares += h.shares
    b.count += 1
  }

  // ---- Vesting status (as of today) ----
  const today = new Date()
  const MS_DAY = 86400000
  function parseISO(s: string | null | undefined): Date | null {
    if (!s) return null
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s))
    if (!m) return null
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  }
  function monthsBetween(fromISO: string | null | undefined, to: Date): number | null {
    const f = parseISO(fromISO)
    if (!f) return null
    return (to.getTime() - f.getTime()) / MS_DAY / 30.4375
  }
  function addMonths(d: Date, n: number): Date {
    const x = new Date(d.getTime()); x.setUTCMonth(x.getUTCMonth() + n); return x
  }
  function vestedFraction(g: Grant): number {
    const vm = g.vest_months || 0
    if (vm <= 0) return 1
    const elapsed = monthsBetween(g.vesting_start, today)
    if (elapsed == null) return 0
    if (elapsed < (g.cliff_months || 0)) return 0
    return Math.max(0, Math.min(1, elapsed / vm))
  }
  let vestedTotal = 0, unvestedTotal = 0, fullyVestedShares = 0
  const fullyVested: Array<{ name: string; shares: number }> = []
  const upcomingCliffs: Array<{ name: string; shares: number; date: string; days: number }> = []
  for (const g of outstanding) {
    const out = grantOutstanding(g)
    const f = vestedFraction(g)
    const v = Math.round(out * f)
    vestedTotal += v
    unvestedTotal += out - v
    if (f >= 1 && out > 0) { fullyVestedShares += out; fullyVested.push({ name: g.recipient_name, shares: out }) }
    // Cliff still ahead and landing within 120 days = an upcoming retention/vesting event.
    const start = parseISO(g.vesting_start)
    const cliff = g.cliff_months || 0
    if (start && cliff > 0 && out > 0) {
      const cliffDate = addMonths(start, cliff)
      const days = Math.round((cliffDate.getTime() - today.getTime()) / MS_DAY)
      if (days > 0 && days <= 120) upcomingCliffs.push({ name: g.recipient_name, shares: out, date: cliffDate.toISOString().slice(0, 10), days })
    }
  }
  fullyVested.sort((a, b) => b.shares - a.shares)
  upcomingCliffs.sort((a, b) => a.days - b.days)
  const vestedPct = (vestedTotal + unvestedTotal) > 0 ? vestedTotal / (vestedTotal + unvestedTotal) : 0

  // ---- Recently approved / pending / recently issued ----
  const byCreatedDesc = (a: Grant, b: Grant) => String(b.created_at || '').localeCompare(String(a.created_at || ''))
  const recentlyApproved = proposed.filter(g => g.approval_status === 'Approved').sort(byCreatedDesc).slice(0, 6)
  const pendingApproval = proposed.filter(g => g.approval_status !== 'Approved' && g.approval_status !== 'Rejected')
    .sort((a, b) => b.quantity - a.quantity).slice(0, 6)
  const recentlyIssued = [...outstanding]
    .filter(g => g.issue_date)
    .sort((a, b) => String(b.issue_date).localeCompare(String(a.issue_date)))
    .slice(0, 8)

  // ---- Tenure watch: longest-tenured people without an option grant ----
  const grantedPrimaries = new Set<string>()
  const grantedNames = new Set<string>()
  for (const g of outstanding) {
    if (g.stakeholder_id) grantedPrimaries.add(primaryOf(g.stakeholder_id))
    grantedNames.add((g.recipient_name || '').trim().toLowerCase())
  }
  const tenureWatch = roster
    .filter(s => s.start_date && !grantedPrimaries.has(primaryOf(s.id)) && !grantedNames.has((s.name || '').trim().toLowerCase()))
    .map(s => ({ name: s.name, start: s.start_date as string, years: (today.getTime() - (parseISO(s.start_date)?.getTime() || today.getTime())) / MS_DAY / 365.25 }))
    .filter(s => s.years >= 0)
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 6)

  // ---- Grant activity by year (options issued) ----
  const byYear = new Map<string, number>()
  for (const g of outstanding) {
    const y = (g.issue_date || '').slice(0, 4)
    if (!y) continue
    byYear.set(y, (byYear.get(y) || 0) + grantIssued(g))
  }
  const activity = [...byYear.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([year, shares]) => ({ year, shares }))

  // =====================================================================
  //  Rendering helpers
  // =====================================================================
  const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
  const fmtShares = (n: number | null | undefined) => (n == null || !isFinite(n)) ? '—' : nf0.format(Math.floor(n))
  const fmtNum = (n: number | null | undefined) => (n == null || !isFinite(n)) ? '—' : nf0.format(Math.round(n))
  const fmtPct = (frac: number | null | undefined, d = 1) => (frac == null || !isFinite(frac)) ? '—' : `${(frac * 100).toFixed(d)}%`
  const fmtUSD = (n: number | null | undefined) => (n == null || !isFinite(n)) ? '—' : `$${nf0.format(Math.round(n))}`
  const fmtDate = (s: string | null | undefined) => {
    if (!s) return '—'
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s))
    return m ? `${m[1]}-${m[2]}-${m[3]}` : String(s)
  }

  const C = {
    outstanding: '#4f46e5', exercised: '#0891b2', proposed: '#f59e0b',
    available: '#cbd5e1', over: '#dc2626', ideas: '#a78bfa',
    vested: '#10b981', unvested: '#e2e8f0',
    emp: '#4f46e5', bod: '#0d9488', ex: '#94a3b8',
  }

  function donut(segments: Array<{ label: string; value: number; color: string }>, centerTop: string, centerBottom: string): string {
    const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0)
    const r = 70, cx = 92, cy = 92, sw = 26, circ = 2 * Math.PI * r
    if (total <= 0) return '<div class="empty">No pool data yet.</div>'
    let acc = 0
    const arcs = segments.filter(s => s.value > 0).map(s => {
      const frac = s.value / total
      const len = frac * circ
      const off = -acc * circ
      acc += frac
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`
    }).join('')
    return `<svg viewBox="0 0 184 184" width="184" height="184" role="img" aria-label="Pool allocation">
      ${arcs}
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="donut-top">${esc(centerTop)}</text>
      <text x="${cx}" y="${cy + 16}" text-anchor="middle" class="donut-bot">${esc(centerBottom)}</text>
    </svg>`
  }

  function hbars(items: Array<{ label: string; value: number; valueLabel: string; sub?: string; color: string }>): string {
    if (!items.length) return '<div class="empty">Nothing to show.</div>'
    const max = Math.max(1, ...items.map(i => i.value))
    return `<div class="bars">${items.map(i => `
      <div class="bar-row">
        <div class="bar-label" title="${esc(i.label)}">${esc(i.label)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (i.value / max) * 100).toFixed(1)}%;background:${i.color}"></div></div>
        <div class="bar-value">${esc(i.valueLabel)}${i.sub ? `<span class="bar-sub">${esc(i.sub)}</span>` : ''}</div>
      </div>`).join('')}</div>`
  }

  function vbars(items: Array<{ label: string; value: number; valueLabel: string }>): string {
    if (!items.length) return '<div class="empty">No dated grants.</div>'
    const max = Math.max(1, ...items.map(i => i.value))
    return `<div class="vbars">${items.map(i => `
      <div class="vbar">
        <div class="vbar-val">${esc(i.valueLabel)}</div>
        <div class="vbar-col" style="height:${Math.max(3, (i.value / max) * 130).toFixed(0)}px"></div>
        <div class="vbar-label">${esc(i.label)}</div>
      </div>`).join('')}</div>`
  }

  function legend(items: Array<{ label: string; value: string; color: string }>): string {
    return `<div class="legend">${items.map(i => `
      <div class="legend-row">
        <span class="dot" style="background:${i.color}"></span>
        <span class="legend-label">${esc(i.label)}</span>
        <span class="legend-value">${esc(i.value)}</span>
      </div>`).join('')}</div>`
  }

  function kpi(value: string, label: string, sub = ''): string {
    return `<div class="kpi"><div class="kpi-value">${esc(value)}</div><div class="kpi-label">${esc(label)}</div>${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ''}</div>`
  }

  // Donut segments — Outstanding + Committed + Future Available = Authorized(net).
  // Exercised is NOT a slice: it moved to common (FDS), out of the option pool.
  const futAvail = pool.futureAvailable
  const donutSegments = [
    { label: 'Outstanding', value: totalOutstanding, color: C.outstanding },
    { label: 'Committed', value: totalProposed, color: C.proposed },
    ...(futAvail >= 0
      ? [{ label: 'Available', value: futAvail, color: C.available }]
      : [{ label: 'Over-allocated', value: Math.abs(futAvail), color: C.over }]),
  ]

  const generatedOn = today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const roundName = currentRound ? (currentRound.name || currentRound.code || 'current round') : null

  // =====================================================================
  //  Assemble document
  // =====================================================================
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CEO Equity Report — ${esc(company.name)}</title>
<style>
  :root{
    --ink:#0f172a; --ink-2:#334155; --muted:#64748b; --faint:#94a3b8;
    --line:#e2e8f0; --bg:#f1f5f9; --card:#ffffff; --brand:#4f46e5; --brand-soft:#eef2ff;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
  .page{max-width:1080px;margin:0 auto;padding:28px 28px 60px}
  /* Hero */
  .hero{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;background:linear-gradient(135deg,#1e1b4b 0%,#4f46e5 100%);color:#fff;border-radius:16px;padding:28px 32px;margin-bottom:22px;box-shadow:0 10px 30px rgba(79,70,229,.25)}
  .hero h1{margin:6px 0 2px;font-size:26px;font-weight:800;letter-spacing:-.01em}
  .hero .sub{margin:0;color:#c7d2fe;font-size:13px}
  .badge{display:inline-block;font-size:10px;letter-spacing:.14em;font-weight:700;background:rgba(255,255,255,.16);padding:3px 8px;border-radius:999px}
  .print-btn{flex:none;cursor:pointer;border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.1);color:#fff;font-size:12.5px;font-weight:600;padding:9px 14px;border-radius:10px}
  .print-btn:hover{background:rgba(255,255,255,.2)}
  /* KPI band */
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .kpi-value{font-size:24px;font-weight:800;letter-spacing:-.02em;color:var(--ink)}
  .kpi-label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-top:2px;font-weight:600}
  .kpi-sub{font-size:11.5px;color:var(--faint);margin-top:3px}
  /* Cards */
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:18px;break-inside:avoid}
  .card h2{margin:0 0 2px;font-size:16px;font-weight:700;letter-spacing:-.01em}
  .card h3{margin:18px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  .card .desc{margin:0 0 14px;font-size:12.5px;color:var(--muted)}
  .grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}
  .grid-2.tight{grid-template-columns:200px 1fr;align-items:center}
  .note{font-size:12px;color:var(--muted);margin:12px 0 0;padding-top:10px;border-top:1px dashed var(--line)}
  .pill{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:999px}
  .pill.warn{background:#fef2f2;color:#b91c1c}
  .pill.ok{background:#ecfdf5;color:#047857}
  .empty{font-size:12.5px;color:var(--faint);padding:14px 0;font-style:italic}
  /* Donut */
  .donut-top{font-size:22px;font-weight:800;fill:var(--ink)}
  .donut-bot{font-size:10px;letter-spacing:.08em;fill:var(--muted);text-transform:uppercase}
  .legend{display:flex;flex-direction:column;gap:7px}
  .legend-row{display:flex;align-items:center;gap:9px;font-size:13px}
  .dot{width:11px;height:11px;border-radius:3px;flex:none}
  .legend-label{color:var(--ink-2)}
  .legend-value{margin-left:auto;font-weight:700;font-variant-numeric:tabular-nums}
  /* Horizontal bars */
  .bars{display:flex;flex-direction:column;gap:9px}
  .bar-row{display:grid;grid-template-columns:150px 1fr 132px;align-items:center;gap:12px}
  .bar-label{font-size:12.5px;color:var(--ink-2);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bar-track{background:#f1f5f9;border-radius:6px;height:18px;overflow:hidden}
  .bar-fill{height:100%;border-radius:6px;min-width:2px}
  .bar-value{font-size:12.5px;text-align:right;font-variant-numeric:tabular-nums;font-weight:700;color:var(--ink)}
  .bar-sub{display:block;font-size:10.5px;color:var(--faint);font-weight:500}
  /* Vertical bars */
  .vbars{display:flex;align-items:flex-end;gap:14px;height:180px;padding-top:8px}
  .vbar{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;flex:1;gap:6px;height:100%}
  .vbar-col{width:100%;max-width:46px;background:linear-gradient(180deg,#6366f1,#4f46e5);border-radius:6px 6px 0 0}
  .vbar-val{font-size:11px;font-weight:700;color:var(--ink-2);font-variant-numeric:tabular-nums}
  .vbar-label{font-size:11px;color:var(--muted)}
  /* Stacked vesting bar */
  .stack{display:flex;height:26px;border-radius:8px;overflow:hidden;border:1px solid var(--line)}
  .stack>div{height:100%}
  /* Tables */
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700;padding:6px 10px;border-bottom:1px solid var(--line)}
  td{padding:7px 10px;border-bottom:1px solid #f1f5f9;color:var(--ink-2);font-variant-numeric:tabular-nums}
  td.r,th.r{text-align:right}
  tr:last-child td{border-bottom:none}
  .name{font-weight:600;color:var(--ink)}
  .foot{text-align:center;color:var(--faint);font-size:11px;margin-top:26px}
  @media (max-width:760px){ .kpis{grid-template-columns:repeat(2,1fr)} .grid-2,.grid-2.tight{grid-template-columns:1fr} }
  @media print{
    body{background:#fff}
    .print-btn{display:none}
    .page{max-width:none;padding:0}
    .hero{box-shadow:none}
    .card,.kpi{border-color:#d8dee9}
  }
</style>
</head>
<body>
<div class="page">

  <header class="hero">
    <div>
      <span class="badge">CONFIDENTIAL · BOARD &amp; CEO</span>
      <h1>${esc(company.name)} — Equity &amp; Option Program</h1>
      <p class="sub">CEO briefing${roundName ? ` · modelling ${esc(roundName)}` : ''} · ${esc(generatedOn)}</p>
    </div>
    <button class="print-btn" onclick="window.print()">⎙ Print / Save as PDF</button>
  </header>

  <section class="kpis">
    ${kpi(fmtShares(postFDS), 'Post-round FDS', 'Fully-diluted shares')}
    ${kpi(fmtShares(poolAuthorizedNet), 'Options authorized', `${fmtPct(postFDS > 0 ? poolAuthorizedNet / postFDS : 0)} of FDS`)}
    ${kpi(fmtShares(totalOutstanding), 'Options outstanding', `${numHolders} holder${numHolders === 1 ? '' : 's'}`)}
    ${kpi(fmtShares(pool.available), 'Available now', futAvail < 0 ? 'Over-allocated after committed' : `${fmtShares(futAvail)} after committed`)}
    ${kpi(fmtPct(postFDS > 0 ? totalOutstanding / postFDS : 0), 'Option overhang', 'Outstanding ÷ FDS')}
    ${kpi(fmtShares(totalProposed), 'Committed', `${proposed.length} draft${proposed.length === 1 ? '' : 's'} · ${recentlyApproved.length} approved`)}
    ${kpi(fmtShares(avgGrant), 'Avg per holder', `median ${fmtShares(medianHolder)}`)}
    ${kpi(ppsAnchor > 0 ? fmtUSD(totalOutstanding * ppsAnchor) : '—', 'Outstanding value', ppsAnchor > 0 ? `at ${fmtUSD(ppsAnchor)}/sh` : 'no PPS set')}
  </section>

  <section class="card">
    <h2>Option pool health</h2>
    <p class="desc">How the authorized pool of ${fmtShares(poolAuthorizedNet)} options (net of exercised, which moved to common) is allocated today, including draft proposals.</p>
    <div class="grid-2 tight">
      <div style="display:flex;justify-content:center">${donut(donutSegments, fmtShares(poolAuthorizedNet), 'authorized')}</div>
      <div>
        ${legend([
          { label: 'Outstanding (held)', value: `${fmtShares(totalOutstanding)} · ${fmtPct(poolAuthorizedNet > 0 ? totalOutstanding / poolAuthorizedNet : 0)}`, color: C.outstanding },
          { label: 'Committed (draft)', value: `${fmtShares(totalProposed)} · ${fmtPct(poolAuthorizedNet > 0 ? totalProposed / poolAuthorizedNet : 0)}`, color: C.proposed },
          futAvail >= 0
            ? { label: 'Available after committed', value: `${fmtShares(futAvail)} · ${fmtPct(poolAuthorizedNet > 0 ? futAvail / poolAuthorizedNet : 0)}`, color: C.available }
            : { label: 'Over-allocated', value: `(${fmtShares(Math.abs(futAvail))})`, color: C.over },
          { label: 'Exercised → common (FDS, not pool)', value: `${fmtShares(totalExercised)} · ${fmtPct(postFDS > 0 ? totalExercised / postFDS : 0)} of FDS`, color: C.exercised },
        ])}
        <p class="note">
          ${futAvail < 0
            ? `<span class="pill warn">Action needed</span> Committed grants exceed the available pool by ${fmtShares(Math.abs(futAvail))} options — a pool top-up is required before approval.`
            : futAvail < poolAuthorizedNet * 0.05
              ? `<span class="pill warn">Running low</span> Only ${fmtPct(poolAuthorizedNet > 0 ? futAvail / poolAuthorizedNet : 0)} of the pool remains after the current proposals.`
              : `<span class="pill ok">Healthy</span> ${fmtShares(futAvail)} options (${fmtPct(poolAuthorizedNet > 0 ? futAvail / poolAuthorizedNet : 0)} of the pool) remain after the current proposals.`}
          ${totalIdeas > 0 ? ` A further ${fmtShares(totalIdeas)} options sit in "proposed" on the pool-impact timeline.` : ''}
        </p>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Largest option holders</h2>
    <p class="desc">Outstanding options by person (alias rows rolled up). % is of post-round FDS.</p>
    ${hbars(top5.map(h => ({ label: h.name, value: h.shares, valueLabel: fmtShares(h.shares), sub: `${fmtPct(postFDS > 0 ? h.shares / postFDS : 0)} · ${h.role || '—'}`, color: C.outstanding })))}
    ${bottom5.length ? `<h3>Smallest active grants</h3>${hbars(bottom5.map(h => ({ label: h.name, value: h.shares, valueLabel: fmtShares(h.shares), sub: fmtPct(postFDS > 0 ? h.shares / postFDS : 0), color: C.exercised })))}` : ''}
    <p class="note">The top 5 holders control <b>${fmtPct(top5Concentration)}</b> of all outstanding options${numHolders > 5 ? ` across ${numHolders} total holders` : ''}.</p>
  </section>

  <section class="card">
    <h2>Where the equity sits</h2>
    <div class="grid-2">
      <div>
        <h3 style="margin-top:0">By population</h3>
        ${hbars([
          { label: 'Employees', value: catEmp.shares, valueLabel: fmtShares(catEmp.shares), sub: `${catEmp.count} people`, color: C.emp },
          { label: 'Board / Advisors', value: catBod.shares, valueLabel: fmtShares(catBod.shares), sub: `${catBod.count} people`, color: C.bod },
          { label: 'Ex-Employees', value: catEx.shares, valueLabel: fmtShares(catEx.shares), sub: `${catEx.count} people`, color: C.ex },
        ])}
      </div>
      <div>
        <h3 style="margin-top:0">Vesting status of outstanding options</h3>
        <div class="stack" title="Vested vs unvested">
          <div style="width:${(vestedPct * 100).toFixed(1)}%;background:${C.vested}"></div>
          <div style="width:${((1 - vestedPct) * 100).toFixed(1)}%;background:${C.unvested}"></div>
        </div>
        ${legend([
          { label: 'Vested', value: `${fmtShares(vestedTotal)} · ${fmtPct(vestedPct)}`, color: C.vested },
          { label: 'Unvested', value: `${fmtShares(unvestedTotal)} · ${fmtPct(1 - vestedPct)}`, color: C.unvested },
        ])}
        <p class="note" style="margin-top:14px">${fmtShares(fullyVestedShares)} options across ${fullyVested.length} holder${fullyVested.length === 1 ? '' : 's'} are <b>fully vested</b> (retention watch).</p>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Grant activity by year</h2>
    <p class="desc">Options issued per calendar year (by issue date) across outstanding grants.</p>
    ${vbars(activity.map(a => ({ label: a.year, value: a.shares, valueLabel: fmtShares(a.shares) })))}
  </section>

  <section class="card">
    <div class="grid-2">
      <div>
        <h2>Pending board approval</h2>
        <p class="desc">Committed grants awaiting sign-off — the upcoming decisions.</p>
        ${pendingApproval.length ? `<table><thead><tr><th>Recipient</th><th>Role</th><th class="r">Options</th><th class="r">% FDS</th></tr></thead><tbody>
          ${pendingApproval.map(g => `<tr><td class="name">${esc(g.recipient_name)}</td><td>${esc(g.recipient_type || '—')}</td><td class="r">${fmtShares(g.quantity)}</td><td class="r">${fmtPct(postFDS > 0 ? g.quantity / postFDS : 0)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">No grants pending approval.</div>'}
      </div>
      <div>
        <h2>Recently approved</h2>
        <p class="desc">Grants the board has marked approved, latest first.</p>
        ${recentlyApproved.length ? `<table><thead><tr><th>Recipient</th><th>Role</th><th class="r">Options</th></tr></thead><tbody>
          ${recentlyApproved.map(g => `<tr><td class="name">${esc(g.recipient_name)}</td><td>${esc(g.recipient_type || '—')}</td><td class="r">${fmtShares(g.quantity)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">No approved grants yet.</div>'}
      </div>
    </div>
  </section>

  <section class="card">
    <div class="grid-2">
      <div>
        <h2>Most recently issued</h2>
        <p class="desc">The latest live grants on the cap table.</p>
        ${recentlyIssued.length ? `<table><thead><tr><th>Recipient</th><th>Issued</th><th class="r">Options</th></tr></thead><tbody>
          ${recentlyIssued.map(g => `<tr><td class="name">${esc(g.recipient_name)}</td><td>${fmtDate(g.issue_date)}</td><td class="r">${fmtShares(grantOutstanding(g))}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">No issued grants.</div>'}
      </div>
      <div>
        <h2>Upcoming cliffs (next 120 days)</h2>
        <p class="desc">Grantees crossing their cliff soon — vesting milestones to anticipate.</p>
        ${upcomingCliffs.length ? `<table><thead><tr><th>Recipient</th><th>Cliff date</th><th class="r">Options</th><th class="r">In</th></tr></thead><tbody>
          ${upcomingCliffs.slice(0, 8).map(c => `<tr><td class="name">${esc(c.name)}</td><td>${fmtDate(c.date)}</td><td class="r">${fmtShares(c.shares)}</td><td class="r">${c.days}d</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">No cliffs in the next 120 days.</div>'}
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Tenure watch — longest-serving people without an option grant</h2>
    <p class="desc">Based on employment start dates from the roster. A prompt to consider equity for long-tenured contributors who hold no options.</p>
    ${tenureWatch.length ? `<table><thead><tr><th>Name</th><th>Start date</th><th class="r">Tenure</th></tr></thead><tbody>
      ${tenureWatch.map(t => `<tr><td class="name">${esc(t.name)}</td><td>${fmtDate(t.start)}</td><td class="r">${t.years.toFixed(1)} yrs</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">No un-granted people with a recorded start date. Add start dates on the Grant Fairness roster to surface this.</div>'}
  </section>

  <div class="foot">Generated by CapStack · ${esc(generatedOn)} · Figures mirror the Option Grants page. Confidential.</div>

</div>
</body>
</html>`

  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setHeader(event, 'Content-Disposition', `inline; filename="${company.slug || 'company'}-ceo-report-${today.toISOString().slice(0, 10)}.html"`)
  return html
})
