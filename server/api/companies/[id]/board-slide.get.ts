import { db } from '~~/server/utils/db'
import { authorizedPool, newSharesIssued, grantOutstanding, poolEquation } from '~~/shared/capTableModel'

// Board slide — a one-page, print-ready visual on the OPTION POOL, sized to drop
// straight into a board deck (landscape, single page, "Print / Save as PDF").
// A sibling to the CEO report (ceo-report.get.ts) but tighter: high-level,
// highly visual, and actionable. It answers four board questions:
//
//   1. How big is the option pool, and what's that as a % of FDS?
//   2. How much is ALLOCATED vs UNALLOCATED (each as a % of the pool)?
//   3. How was the allocated pool spread across funding stages
//      (Founders / Seed / Series)?
//   4. What's PROPOSED right now (shares + % of FDS), and does it fit?
//
// Every pool/FDS figure is sourced from the SAME canonical places the Option
// Grants page reads — the shared capTableModel helper for the authorized pool,
// and the round-summary endpoint for the per-round allocation + exercised
// counts — so the slide can't drift from the app. The stage breakdown is, by
// construction, a decomposition of the allocated total: Σ over rounds of
// (option_pool_attributed + options_exercised) === outstanding + exercised.

interface Grant {
  recipient_name: string
  recipient_type: string | null
  quantity: number
  status: string
  approval_status: string | null
  job_title: string | null
  award_type: string | null
  vesting_start: string | null
  issue_date: string | null
  quantity_issued?: number | null
  quantity_exercised?: number | null
  quantity_forfeited?: number | null
  quantity_expired?: number | null
}

interface RoundCol {
  code: string
  name: string | null
  kind: 'formation' | 'closed' | 'open'
  close_date: string | null
  seniority: number
  new_money: number
  share_price: number | null
  option_pool_issued: number
  notes_converted: number
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  // $fetch / URLs cast to `any` to dodge the typed-route overloads that blow
  // TS's recursion limit on dynamic `${id}` paths — same pattern as ceo-report.
  // A failed fetch falls back to an empty value so the slide still renders.
  async function fetchJson<T>(url: string, fallback: T, opts?: Record<string, any>): Promise<T> {
    try { return (await (event.$fetch as any)(url, opts)) as T } catch { return fallback }
  }
  interface AggregateResp { total_shares_fds: number | null; option_pool_total: number | null; derived_from_history?: boolean }
  const [grantsResp, roundSummary, aggregate, capTable, poolEventsRaw] = await Promise.all([
    fetchJson<{ grants: Grant[]; pools: Array<{ authorized: number }> }>(`/api/companies/${id}/grants`, { grants: [], pools: [] }),
    fetchJson<{ rounds: RoundCol[] }>(`/api/companies/${id}/round-summary`, { rounds: [] }),
    fetchJson<AggregateResp>(`/api/companies/${id}/aggregate-round`, { total_shares_fds: null, option_pool_total: null }),
    fetchJson<any>(`/api/companies/${id}/cap-table`, null),
    fetchJson<any[]>(`/api/companies/${id}/pool-events`, []),
  ])

  const company = capTable?.company || db().prepare('SELECT * FROM companies WHERE id = ?').get(id) as any
  if (!company) throw createError({ statusCode: 404, message: 'Company not found' })

  const grants: Grant[] = grantsResp.grants || []
  const outstanding = grants.filter(g => g.status === 'outstanding')
  const proposed = grants.filter(g => g.status === 'proposed')
  const rounds: RoundCol[] = roundSummary.rounds || []

  // ---- Pool headline (canonical) ----
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

  // ---- Allocated vs unallocated (canonical pool equation) ----
  // "Allocated" = options granted out of the pool: outstanding (held) + exercised
  // (converted to common). We run the figures through the SHARED poolEquation()
  // so Available (= Authorized − Outstanding − Exercised) and Future-available
  // (= Available − Proposed) are computed by the same helper the CEO report and
  // Pool Impact page use — the slide can't drift. ideas are excluded from the
  // headline pool math (shown as a footnote in the callout), mirroring ceo-report.
  const allocatedOutstanding = outstanding.reduce((a, g) => a + grantOutstanding(g), 0)
  const allocatedExercised = outstanding.reduce((a, g) => a + (g.quantity_exercised || 0), 0)
  const totalForfeitedOrExpired = outstanding.reduce((a, g) => a + (g.quantity_forfeited || 0) + (g.quantity_expired || 0), 0)
  const totalProposed = proposed.reduce((a, g) => a + (g.quantity || 0), 0)
  const totalIdeas = (poolEventsRaw || [])
    .filter((e: any) => e.type === 'grant' || e.type === 'reserve')
    .reduce((a: number, e: any) => a + (e.shares || 0), 0)
  const pool = poolEquation({
    authorized: poolAuthorized,
    outstanding: allocatedOutstanding,
    exercised: allocatedExercised,
    forfeitedOrExpired: totalForfeitedOrExpired,
    proposed: totalProposed,
    ideas: totalIdeas,
    includeIdeas: false,
  })
  const allocated = allocatedOutstanding + allocatedExercised
  const available = pool.available                  // unallocated pool = Authorized − allocated
  const unallocated = Math.max(0, available)
  const afterProposed = pool.futureAvailable        // truly-free pool after proposals

  // ---- FDS basis (canonical; mirrors ceo-report / the Grants page) ----
  const heldShares = capTable ? (capTable.holdings || []).reduce((a: number, h: any) => a + (h.shares || 0), 0) : 0
  const fdsAnchor = heldShares + allocatedOutstanding + unallocated
  const preFDS = base > 0 ? base : fdsAnchor
  const issuedNew = currentRound ? newSharesIssued(currentRound.new_money, currentRound.share_price) : 0
  const postFDS = base > 0
    ? base + issuedNew + (currentRound?.option_pool_issued || 0) + (currentRound?.notes_converted || 0)
    : preFDS

  // =====================================================================
  //  Formatting + chart helpers (shared shape with ceo-report)
  // =====================================================================
  const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
  const fmtShares = (n: number | null | undefined) => (n == null || !isFinite(n)) ? '—' : nf0.format(Math.round(n))
  const fmtPct = (frac: number | null | undefined, d = 1) => (frac == null || !isFinite(frac)) ? '—' : `${(frac * 100).toFixed(d)}%`
  const fmtDate = (s: string | null | undefined) => {
    if (!s) return '—'
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s))
    return m ? `${m[1]}-${m[2]}-${m[3]}` : String(s)
  }
  const pctOfPool = (n: number) => poolAuthorized > 0 ? n / poolAuthorized : 0
  const pctOfFds = (n: number) => postFDS > 0 ? n / postFDS : 0
  const YEAR_MS = 365.25 * 86400000
  const parseISO = (s: string | null | undefined): number | null => {
    if (!s) return null
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s))
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
  }
  const fmtMY = (ms: number | null) => ms == null ? '—' : new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
  const today = new Date()

  // Consistent value cell used everywhere a figure is shown: bold shares, then a
  // gap, then a non-bold % — both right-aligned in fixed columns so they line up
  // across every row (no dots, no misalignment).
  const shpc = (shares: number, pctFrac: number) =>
    `<span class="sh">${fmtShares(shares)}</span><span class="pc">${fmtPct(pctFrac)}</span>`

  // Burn-down line chart: available pool at each year-end. The actual stretch is
  // a solid line over a light area; the projection (future years at the current
  // grant pace) is a dashed line running down toward the dry date. Strokes use
  // non-scaling-stroke so they stay crisp when the SVG stretches to fill width.
  function lineChart(pts: Array<{ year: number; val: number; projected: boolean }>, maxVal: number): string {
    if (pts.length < 2) return '<div class="empty">Not enough dated history to chart.</div>'
    const m = Math.max(1, maxVal)
    const n = pts.length, W = n - 1, H = 100
    const xy = (i: number) => `${i.toFixed(2)},${(H - (pts[i]!.val / m) * H).toFixed(2)}`
    let lastActual = 0
    pts.forEach((p, i) => { if (!p.projected) lastActual = i })
    const actualIdx = pts.map((_, i) => i).filter(i => i <= lastActual)
    const projIdx = pts.map((_, i) => i).filter(i => i >= lastActual)
    const area = `0,${H} ${actualIdx.map(xy).join(' ')} ${lastActual},${H}`
    const labels = pts.map(p => `<span class="lc-lbl${p.projected ? ' proj' : ''}">'${String(p.year).slice(2)}</span>`).join('')
    return `<div class="linechart">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="lc-svg" role="img" aria-label="Option pool available over time">
        <polygon points="${area}" class="lc-area"/>
        <line x1="0" y1="${H}" x2="${W}" y2="${H}" class="lc-base"/>
        <polyline points="${actualIdx.map(xy).join(' ')}" class="lc-line"/>
        <polyline points="${projIdx.map(xy).join(' ')}" class="lc-proj"/>
      </svg>
      <div class="lc-axis">${labels}</div>
    </div>`
  }

  function kpi(value: string, label: string, sub = '', sub2 = ''): string {
    return `<div class="kpi"><div class="kpi-value">${esc(value)}</div><div class="kpi-label">${esc(label)}</div>${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ''}${sub2 ? `<div class="kpi-sub2">${esc(sub2)}</div>` : ''}</div>`
  }

  const overBy = afterProposed < 0 ? Math.abs(afterProposed) : 0

  // ---- Pool burn-down + dry-date projection ----
  // Rebuild the available balance over time: it steps UP when a round adds pool
  // (option_pool_issued, at the round close) and DOWN as grants are issued, then
  // project forward at the historical grant pace to estimate when it runs dry.
  const todayMs = today.getTime()
  const topupEvents = rounds
    .filter(r => (r.option_pool_issued || 0) > 0 && parseISO(r.close_date) != null)
    .map(r => ({ t: parseISO(r.close_date) as number, delta: r.option_pool_issued }))
  const authorizedFromRounds = topupEvents.reduce((a, e) => a + e.delta, 0)
  const grantEvents = outstanding
    .filter(g => parseISO(g.issue_date) != null)
    .map(g => ({ t: parseISO(g.issue_date) as number, delta: -(grantOutstanding(g) + (g.quantity_exercised || 0)) }))
  const allocatedDated = -grantEvents.reduce((a, e) => a + e.delta, 0)
  const eventTimes = [...topupEvents, ...grantEvents].map(e => e.t)
  const startMs = eventTimes.length ? Math.min(...eventTimes) : todayMs
  // Use the per-round pool history as step-ups when it accounts for the whole
  // authorized pool; otherwise seed the full pool as one top-up at the start.
  // Either way the balance ends at the headline `available`, so any undated
  // allocation is applied up front.
  const useRoundTopups = authorizedFromRounds > 0 && Math.abs(authorizedFromRounds - poolAuthorized) <= poolAuthorized * 0.02
  const undatedAlloc = allocated - allocatedDated
  const events = [
    { t: startMs, delta: (useRoundTopups ? 0 : poolAuthorized) - undatedAlloc },
    ...(useRoundTopups ? topupEvents : []),
    ...grantEvents,
  ].sort((a, b) => a.t - b.t)
  let runningBal = 0
  const timeline = events.map(e => { runningBal += e.delta; return { t: e.t, bal: runningBal } })
  const availAt = (ms: number) => {
    let v = 0
    for (const p of timeline) { if (p.t <= ms) v = p.bal; else break }
    return v
  }
  // Grant pace = lifetime average over the granting span.
  const firstGrantMs = grantEvents.length ? Math.min(...grantEvents.map(e => e.t)) : startMs
  const spanYears = Math.max(0.75, (todayMs - firstGrantMs) / YEAR_MS)
  const burnPerYear = allocatedDated > 0 ? allocatedDated / spanYears : 0
  const burnRounded = burnPerYear > 0 ? Math.round(burnPerYear / 1000) * 1000 : 0
  const yearsToDry = (burnPerYear > 0 && available > 0) ? available / burnPerYear : null
  const dryMs = yearsToDry != null ? todayMs + yearsToDry * YEAR_MS : null
  const topUpByMs = dryMs != null ? dryMs - 0.5 * YEAR_MS : null
  // Yearly bars: recent actual + projected decline, capped to a readable window.
  const curYear = new Date(todayMs).getUTCFullYear()
  const dryYear = dryMs != null ? new Date(dryMs).getUTCFullYear() : null
  const lastYear = dryYear != null ? Math.min(dryYear, curYear + 6) : curYear
  const firstYear = Math.max(new Date(startMs).getUTCFullYear(), lastYear - 9)
  const burnBars: Array<{ year: number; val: number; projected: boolean }> = []
  for (let y = firstYear; y <= lastYear; y++) {
    const projected = y > curYear
    const val = projected
      ? Math.max(0, available - burnPerYear * (y - curYear))
      : availAt(Math.min(Date.UTC(y, 11, 31), todayMs))
    burnBars.push({ year: y, val, projected })
  }
  const maxBar = Math.max(poolAuthorized, ...burnBars.map(b => b.val))
  // Runway recommendation — actionable: when (if) to expand the pool.
  let runwayClass = 'ok'
  let runwayNote = ''
  if (available <= 0) {
    runwayClass = 'warn'
    runwayNote = 'The pool is fully allocated — a top-up is required before any new grants.'
  } else if (burnPerYear <= 0) {
    runwayClass = 'neutral'
    runwayNote = `No dated grant history yet, so no dry date is projected. ${fmtShares(available)} (${fmtPct(pctOfPool(available))}) remains available.`
  } else if ((yearsToDry as number) < 1) {
    runwayClass = 'warn'
    runwayNote = `At ~${fmtShares(burnRounded)}/yr the pool runs dry around ${fmtMY(dryMs)} — under a year out. Plan a top-up now.`
  } else if ((yearsToDry as number) < 2) {
    runwayClass = 'warn'
    runwayNote = `At ~${fmtShares(burnRounded)}/yr the pool runs dry around ${fmtMY(dryMs)}. Line up a top-up by ${fmtMY(topUpByMs)}.`
  } else {
    runwayClass = 'ok'
    runwayNote = `At ~${fmtShares(burnRounded)}/yr the pool lasts to ~${fmtMY(dryMs)} (${(yearsToDry as number).toFixed(1)} yrs); revisit a top-up by ${fmtMY(topUpByMs)}.`
  }

  // Proposed grants — list ALL of them, sorted largest first. The recipient cell
  // carries the name plus a "title · role" sub-line; award type and vesting start
  // are their own columns. With more than a handful we split the list into two
  // side-by-side tables so the whole roster still fits on one page.
  const proposedSorted = [...proposed].sort((a, b) => (b.quantity || 0) - (a.quantity || 0))
  function proposedRows(list: Grant[]): string {
    return list.map(g => {
      const name = g.recipient_name || g.job_title || 'Unnamed'
      const subBits = [g.recipient_name ? g.job_title : null, g.recipient_type].filter(Boolean)
      const sub = subBits.length ? `<span class="rsub">${esc(subBits.join(' · '))}</span>` : ''
      return `<tr><td class="name">${esc(name)}${sub}</td><td>${esc(g.award_type || '—')}</td><td>${fmtDate(g.vesting_start)}</td><td class="r sh">${fmtShares(g.quantity)}</td><td class="r pc">${fmtPct(pctOfFds(g.quantity || 0))}</td></tr>`
    }).join('')
  }
  const proposedTable = (list: Grant[]) =>
    `<table class="prop"><thead><tr><th>Recipient</th><th>Award</th><th>Vesting</th><th class="r">Shares</th><th class="r">% FDS</th></tr></thead><tbody>${proposedRows(list)}</tbody></table>`
  const proposedSplit = Math.ceil(proposedSorted.length / 2)
  const proposedHtml = proposedSorted.length === 0
    ? '<div class="empty">No grants are currently proposed.</div>'
    : proposedSorted.length <= 6
      ? proposedTable(proposedSorted)
      : `<div class="two-col">${proposedTable(proposedSorted.slice(0, proposedSplit))}${proposedTable(proposedSorted.slice(proposedSplit))}</div>`

  // ---- Actionable callout ----
  let calloutClass = 'ok'
  let calloutText = ''
  if (totalProposed <= 0) {
    calloutClass = 'neutral'
    calloutText = `No grants are currently proposed. ${fmtShares(unallocated)} options (${fmtPct(pctOfPool(unallocated))} of the pool) are available to grant.`
  } else if (afterProposed < 0) {
    calloutClass = 'warn'
    calloutText = `Action needed — the ${fmtShares(totalProposed)} options proposed exceed the unallocated pool by ${fmtShares(overBy)}. Approving them requires a pool top-up of at least that much.`
  } else if (afterProposed < poolAuthorized * 0.05) {
    calloutClass = 'warn'
    calloutText = `Running low — approving the ${fmtShares(totalProposed)} proposed options leaves only ${fmtShares(afterProposed)} (${fmtPct(pctOfPool(afterProposed))} of the pool). Plan a top-up for future hires.`
  } else {
    calloutText = `Healthy — approving the ${fmtShares(totalProposed)} proposed options (${fmtPct(pctOfFds(totalProposed))} of FDS) still leaves ${fmtShares(afterProposed)} (${fmtPct(pctOfPool(afterProposed))} of the pool) for future grants.`
  }
  if (totalIdeas > 0) calloutText += ` A further ${fmtShares(totalIdeas)} options sit in "ideas" on the pool-impact timeline.`

  const generatedOn = today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const roundName = currentRound ? (currentRound.name || currentRound.code || 'current round') : null

  // =====================================================================
  //  Assemble — a single landscape slide
  // =====================================================================
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Board Slide — Option Pool — ${esc(company.name)}</title>
<style>
  :root{
    --ink:#0f172a; --ink-2:#334155; --muted:#64748b; --faint:#94a3b8;
    --line:#e2e8f0; --bg:#e2e8f0; --card:#ffffff; --brand:#4f46e5;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.35;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .toolbar{max-width:1360px;margin:0 auto;padding:14px 20px 0;display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap}
  .opts{display:flex;align-items:center;gap:6px 13px;flex-wrap:wrap;font-size:12px;color:var(--ink-2)}
  .opts .opts-lbl{font-weight:700;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em}
  .opts label{display:inline-flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap}
  .opts input{cursor:pointer;margin:0}
  .print-btn{cursor:pointer;border:1px solid #cbd5e1;background:#fff;color:var(--ink);font-size:12.5px;font-weight:600;padding:9px 14px;border-radius:10px;white-space:nowrap}
  /* An excluded block is left blank but keeps its space, so the layout is stable. */
  .blank{visibility:hidden}
  .print-btn:hover{background:#f8fafc}
  /* The slide: one landscape page. */
  .slide{max-width:1360px;margin:18px auto 48px;background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:0 12px 34px rgba(15,23,42,.12);padding:20px 40px 12px;display:flex;flex-direction:column;gap:9px}
  .num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
  /* Header band */
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;border-bottom:2px solid #1e1b4b;padding-bottom:8px}
  .head h1{margin:3px 0 1px;font-size:21px;font-weight:800;letter-spacing:-.01em}
  .head .sub{margin:0;color:var(--muted);font-size:12px}
  .badge{display:inline-block;font-size:9.5px;letter-spacing:.14em;font-weight:800;color:#4f46e5;background:#eef2ff;padding:3px 8px;border-radius:999px}
  /* KPI strip */
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
  .kpi{background:#f8fafc;border:1px solid var(--line);border-radius:12px;padding:10px 14px}
  .kpi-value{font-size:22px;font-weight:800;letter-spacing:-.02em;color:var(--ink);font-variant-numeric:tabular-nums}
  .kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-top:2px;font-weight:700}
  .kpi-sub{font-size:11px;color:var(--brand);margin-top:2px;font-weight:600}
  .kpi-sub2{font-size:10px;color:var(--faint);margin-top:1px;font-weight:500;font-variant-numeric:tabular-nums}
  /* Body grid: two columns */
  .body{display:grid;grid-template-columns:1.05fr 1fr;gap:26px}
  .panel h2{margin:0 0 2px;font-size:13.5px;font-weight:800;letter-spacing:-.01em}
  .panel .desc{margin:0 0 8px;font-size:11px;color:var(--muted)}
  /* Shared value cell: bold shares, fixed gap, non-bold % — right-aligned so
     every figure lines up across rows. Used in the breakdown, bars, and tables. */
  .sh{font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums;text-align:right}
  .pc{font-weight:400;color:var(--muted);font-variant-numeric:tabular-nums;text-align:right}
  /* Pool composition breakdown — label | shares | % in fixed columns, no dots */
  .breakdown{display:flex;flex-direction:column;gap:6px}
  .brow{display:grid;grid-template-columns:1fr 92px 50px;column-gap:10px;align-items:baseline;font-size:12px}
  .brow .lbl{color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .brow.head .lbl{font-weight:700;color:var(--ink)}
  .brow.sub .lbl{padding-left:16px;color:var(--muted);font-size:11.5px}
  .brow.sub .sh{font-weight:600;color:var(--ink-2)}
  .brow.minor{margin-top:5px;padding-top:7px;border-top:1px dashed var(--line)}
  .brow.minor .lbl{color:var(--muted);font-size:11.5px}
  .brow .ret{color:var(--faint)}
  /* Burn-down line chart: available pool over time, actual (solid) + projected (dashed) */
  .linechart{margin-bottom:6px}
  .lc-svg{display:block;width:100%;height:48px}
  .lc-area{fill:#eef2ff;stroke:none}
  .lc-base{stroke:var(--line);stroke-width:1;vector-effect:non-scaling-stroke}
  .lc-line{fill:none;stroke:#4f46e5;stroke-width:2;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round}
  .lc-proj{fill:none;stroke:#94a3b8;stroke-width:2;stroke-dasharray:4 3;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round}
  .lc-axis{display:flex;justify-content:space-between;margin-top:3px}
  .lc-lbl{font-size:8.5px;color:var(--muted);font-variant-numeric:tabular-nums}
  .lc-lbl.proj{color:var(--faint)}
  /* Runway recommendation note */
  .pnote{margin:7px 0 0;font-size:11px;line-height:1.32;padding:6px 9px;border-radius:8px;border-left:3px solid}
  .pnote.ok{background:#ecfdf5;color:#065f46;border-color:#34d399}
  .pnote.warn{background:#fef2f2;color:#991b1b;border-color:#f87171}
  .pnote.neutral{background:#f8fafc;color:var(--ink-2);border-color:#cbd5e1}
  /* Proposed grants — single table, or two side-by-side when there are many */
  .lower{display:grid;grid-template-columns:1fr;gap:10px}
  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:6px 26px;align-items:start}
  table{width:100%;border-collapse:collapse;font-size:11.5px}
  .two-col table.prop{font-size:10px}
  .two-col td,.two-col th{padding:3px 8px}
  th{text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700;padding:4px 9px;border-bottom:1px solid var(--line)}
  td{padding:4px 9px;border-bottom:1px solid #f1f5f9;color:var(--ink-2);font-variant-numeric:tabular-nums}
  td.r,th.r{text-align:right}
  td.sh{font-weight:700;color:var(--ink)}
  td.pc{font-weight:400;color:var(--muted)}
  tr:last-child td{border-bottom:none}
  tbody .name{font-weight:600;color:var(--ink)}
  .rsub{display:block;font-size:9px;color:var(--faint);font-weight:400;margin-top:0}
  .proposed-total{display:flex;align-items:baseline;gap:10px;border-top:2px solid var(--line);padding-top:7px;font-size:12px}
  .proposed-total .tl{font-weight:800;color:var(--ink);margin-right:auto}
  .empty{font-size:12px;color:var(--faint);padding:8px 0;font-style:italic}
  /* Callout */
  .callout{font-size:12px;border-radius:10px;padding:8px 13px;line-height:1.3}
  .callout.ok{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}
  .callout.warn{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
  .callout.neutral{background:#f8fafc;color:var(--ink-2);border:1px solid var(--line)}
  .callout b{font-weight:800}
  .foot{display:flex;justify-content:space-between;color:var(--faint);font-size:10px;border-top:1px solid var(--line);padding-top:6px;margin-top:0}
  @media (max-width:880px){ .kpis{grid-template-columns:repeat(2,1fr)} .body{grid-template-columns:1fr} }
  @page{ size:landscape; margin:4mm 5mm }
  @media print{
    body{background:#fff}
    .toolbar{display:none}
    .slide{max-width:none;margin:0;border:none;box-shadow:none;border-radius:0;padding:4px 14px;gap:9px}
  }
</style>
</head>
<body>
  <div class="toolbar">
    <div class="opts">
      <span class="opts-lbl">Include</span>
      <label><input type="checkbox" data-block="kpis" checked> Headline KPIs</label>
      <label><input type="checkbox" data-block="composition" checked> Pool composition</label>
      <label><input type="checkbox" data-block="burndown" checked> Burn-down</label>
      <label><input type="checkbox" data-block="proposed" checked> Proposed grants</label>
      <label><input type="checkbox" data-block="callout" checked> Recommendation</label>
    </div>
    <button class="print-btn" onclick="window.print()">⎙ Print / Save as PDF</button>
  </div>

  <div class="slide">
    <header class="head">
      <div>
        <span class="badge">CONFIDENTIAL · BOARD</span>
        <h1>${esc(company.name)} — Option Pool</h1>
        <p class="sub">Board review${roundName ? ` · modelling ${esc(roundName)}` : ''}</p>
      </div>
    </header>

    <section class="kpis" data-block="kpis">
      ${kpi(fmtShares(poolAuthorized), 'Total option pool', `${fmtPct(pctOfFds(poolAuthorized))} of FDS`, `FDS basis ${fmtShares(postFDS)}`)}
      ${kpi(fmtShares(allocated), 'Allocated', `${fmtPct(pctOfPool(allocated))} of pool`)}
      ${kpi(fmtShares(unallocated), 'Unallocated', `${fmtPct(pctOfPool(unallocated))} of pool`)}
      ${kpi(fmtShares(totalProposed), 'Proposed', `${fmtPct(pctOfFds(totalProposed))} of FDS · ${proposed.length} draft${proposed.length === 1 ? '' : 's'}`)}
    </section>

    <section class="body">
      <div class="panel" data-block="composition">
        <h2>Pool composition</h2>
        <p class="desc">How the ${fmtShares(poolAuthorized)}-option pool breaks down. Allocated = outstanding + exercised; % is of the pool.</p>
        <div class="breakdown">
          <div class="brow head"><span class="lbl">Allocated</span>${shpc(allocated, pctOfPool(allocated))}</div>
          <div class="brow sub"><span class="lbl">Outstanding (held)</span>${shpc(allocatedOutstanding, pctOfPool(allocatedOutstanding))}</div>
          <div class="brow sub"><span class="lbl">Exercised</span>${shpc(allocatedExercised, pctOfPool(allocatedExercised))}</div>
          <div class="brow head"><span class="lbl">Available (unallocated)</span>${shpc(unallocated, pctOfPool(unallocated))}</div>
          <div class="brow sub"><span class="lbl">${afterProposed >= 0 ? 'After proposed' : 'Over-allocated by'}</span>${shpc(afterProposed >= 0 ? afterProposed : overBy, pctOfPool(afterProposed >= 0 ? afterProposed : overBy))}</div>
          <div class="brow minor"><span class="lbl">Forfeited / Expired<span class="ret"> · returned to pool</span></span>${shpc(totalForfeitedOrExpired, pctOfPool(totalForfeitedOrExpired))}</div>
        </div>
      </div>

      <div class="panel" data-block="burndown">
        <h2>Pool burn-down &amp; dry date</h2>
        <p class="desc">Available pool over time (year-end), projected at the ~${fmtShares(burnRounded)}/yr grant pace. Hatched bars = projection.</p>
        ${lineChart(burnBars, maxBar)}
        <div class="breakdown">
          <div class="brow"><span class="lbl">Grant pace (avg)</span><span class="sh">${fmtShares(burnRounded)}</span><span class="pc">/yr</span></div>
          <div class="brow head"><span class="lbl">Projected dry</span><span class="sh">${fmtMY(dryMs)}</span><span class="pc">${yearsToDry != null ? '~' + (yearsToDry as number).toFixed(1) + 'y' : ''}</span></div>
          <div class="brow sub"><span class="lbl">Top-up by</span><span class="sh">${fmtMY(topUpByMs)}</span><span class="pc"></span></div>
        </div>
        <p class="pnote ${runwayClass}">${runwayNote}</p>
      </div>
    </section>

    <section class="lower">
      <div class="panel" data-block="proposed">
        <h2>Proposed grants</h2>
        <p class="desc">All ${proposed.length} proposed grant${proposed.length === 1 ? '' : 's'} — recipient (title · role), award type, vesting start, with shares and % of post-round FDS.</p>
        ${proposedHtml}
        ${proposedSorted.length ? `<div class="proposed-total"><span class="tl">Total proposed</span>${shpc(totalProposed, pctOfFds(totalProposed))}</div>` : ''}
      </div>
      <div class="callout ${calloutClass}" data-block="callout">${calloutText}</div>
    </section>

    <div class="foot">
      <span>Generated by Pariva, a tool by T45 Labs · ${esc(generatedOn)} · Confidential</span>
    </div>
  </div>
  <script>
    (function () {
      var KEY = 'pariva-board-slide-blocks';
      var state = {};
      try { state = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
      function apply(name, on) {
        var els = document.querySelectorAll('.slide [data-block="' + name + '"]');
        for (var i = 0; i < els.length; i++) els[i].classList.toggle('blank', !on);
      }
      var boxes = document.querySelectorAll('.opts input[type=checkbox]');
      for (var i = 0; i < boxes.length; i++) (function (cb) {
        var name = cb.getAttribute('data-block');
        if (Object.prototype.hasOwnProperty.call(state, name)) cb.checked = !!state[name];
        apply(name, cb.checked);
        cb.addEventListener('change', function () {
          state[name] = cb.checked;
          try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
          apply(name, cb.checked);
        });
      })(boxes[i]);
    })();
  </script>
</body>
</html>`

  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setHeader(event, 'Content-Disposition', `inline; filename="${company.slug || 'company'}-board-slide-${today.toISOString().slice(0, 10)}.html"`)
  return html
})
