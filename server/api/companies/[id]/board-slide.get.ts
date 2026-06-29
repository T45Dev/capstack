import { db } from '~~/server/utils/db'
import { authorizedPool, grantOutstanding, poolEquation, poolTopUpForTarget, poolPctOfFds } from '~~/shared/capTableModel'

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
//   5. Should the pool be TOPPED UP — to clear a floor, or to hit a target
//      % of FDS? The Pool-recommendation block sizes that top-up and lets the
//      operator compare target sizes ad hoc on the preview (recomputed live).
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
  notes: string | null
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
  total_shares_fds: number   // canonical cumulative FDS from round-summary
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

  // ---- FDS basis (CANON — straight from the Rounds page) ----
  // Post-round FDS is the current round's own cumulative Total FDS as computed
  // by round-summary; we no longer re-derive it here (base + new + pool + notes)
  // because that path floored shares and skipped exercised-option netting, so
  // the slide read a different FDS than the Rounds table. One source of truth.
  // Falls back to a holdings-derived anchor only when there are no rounds yet.
  const heldShares = capTable ? (capTable.holdings || []).reduce((a: number, h: any) => a + (h.shares || 0), 0) : 0
  const fdsAnchor = heldShares + allocatedOutstanding + unallocated
  const postFDS = currentRound?.total_shares_fds && currentRound.total_shares_fds > 0
    ? currentRound.total_shares_fds
    : (base > 0 ? base : fdsAnchor)

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

  function kpi(value: string, label: string, sub = '', sub2 = ''): string {
    return `<div class="kpi"><div class="kpi-value">${esc(value)}</div><div class="kpi-label">${esc(label)}</div>${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ''}${sub2 ? `<div class="kpi-sub2">${esc(sub2)}</div>` : ''}</div>`
  }

  const overBy = afterProposed < 0 ? Math.abs(afterProposed) : 0

  // =====================================================================
  //  Pool recommendation — floor + target-% top-up
  // =====================================================================
  // Floor = the minimum the AVAILABLE pool should not fall below: a buffer the
  // operator sets as a "floor" idea on the Pool Impact page (highest one wins),
  // overridable ad hoc on this preview. Burn rate = lifetime average grant pace
  // over the dated granting span — used only to estimate WHEN the floor is hit.
  const todayMs = today.getTime()
  const floorShares = (poolEventsRaw || [])
    .filter((e: any) => e.type === 'floor')
    .reduce((a: number, e: any) => Math.max(a, e.shares || 0), 0)
  const grantEvents = outstanding
    .filter(g => parseISO(g.issue_date) != null)
    .map(g => ({ t: parseISO(g.issue_date) as number, allocated: grantOutstanding(g) + (g.quantity_exercised || 0) }))
  const allocatedDated = grantEvents.reduce((a, e) => a + e.allocated, 0)
  const firstGrantMs = grantEvents.length ? Math.min(...grantEvents.map(e => e.t)) : todayMs
  const spanYears = Math.max(0.75, (todayMs - firstGrantMs) / YEAR_MS)
  const burnPerYear = allocatedDated > 0 ? allocatedDated / spanYears : 0
  const burnRounded = burnPerYear > 0 ? Math.round(burnPerYear / 1000) * 1000 : 0

  // Seed the ad-hoc inputs. Target → a "nice" pool size at/above today's % (the
  // 15% industry default), so the comparison always shows a real spread. Floor
  // → the DB floor if set, else ~one year of grants as a starting buffer.
  const currentPoolPct = poolPctOfFds(poolAuthorized, postFDS)
  const niceCeil = (frac: number) => Math.ceil(Math.max(0, frac) / 0.025) * 0.025
  const defaultTargetPct = niceCeil(Math.max(currentPoolPct, 0.15))
  const defaultFloor = floorShares > 0 ? floorShares : burnRounded

  // The recommendation math, kept in lockstep with the client recompute() below
  // (the slide is a static page, so the live version is mirrored in JS); the
  // target sizing itself is the shared poolTopUpForTarget helper.
  const PRESETS = [0.10, 0.125, 0.15, 0.20]
  const topUpFor = (targetFrac: number) =>
    Math.round(poolTopUpForTarget({ poolAuthorized, fds: postFDS, targetPctOfFds: targetFrac }))
  function recRowHtml(targetFrac: number, floor: number, custom: boolean): string {
    const topUp = topUpFor(targetFrac)
    const availAfter = afterProposed + topUp
    const meets = floor > 0 ? availAfter >= floor : null
    const flag = meets == null ? '' : (meets ? '<span class="ok-dot">✓</span>' : '<span class="bad-dot">✗</span>')
    const cls = `${custom ? 'rec-custom' : ''}${topUp <= 0 ? ' rec-met' : ''}`.trim()
    return `<tr class="${cls}"><td>${fmtPct(targetFrac)}</td><td>${topUp > 0 ? fmtShares(topUp) : '—'}</td>`
      + `<td>${fmtShares(poolAuthorized + topUp)}</td><td>${fmtShares(availAfter)}</td><td class="floor-cell">${flag}</td></tr>`
  }
  const recRowFracs = Array.from(new Set([
    ...PRESETS.filter(p => Math.abs(p - defaultTargetPct) > 0.001),
    defaultTargetPct,
  ])).sort((a, b) => a - b)
  const recRowsHtml = recRowFracs.map(f => recRowHtml(f, defaultFloor, Math.abs(f - defaultTargetPct) < 1e-9)).join('')

  // Headline note: the recommended top-up is the LARGER of what the floor needs
  // and what the target asks — so it both clears the buffer and reaches the size.
  function recNote(targetFrac: number, floor: number): { cls: string; html: string } {
    const floorTopUp = floor > 0 ? Math.max(0, floor - afterProposed) : 0
    const recTopUp = Math.round(Math.max(floorTopUp, topUpFor(targetFrac)))
    const availAfter = afterProposed + recTopUp
    const status = (floor > 0 && afterProposed < floor) ? 'below'
      : (floor > 0 && afterProposed < floor * 1.2) ? 'near' : 'ok'
    const lead = status === 'below' ? 'Below floor — ' : status === 'near' ? 'Approaching floor — ' : 'Healthy — '
    let body: string
    if (recTopUp > 0) {
      body = `recommended top-up ≈ <b>${fmtShares(recTopUp)}</b> options → pool at <b>${fmtPct(poolPctOfFds(poolAuthorized, postFDS, recTopUp))}</b> of FDS, leaving ${fmtShares(availAfter)} available after committed`
        + (floor > 0 ? ` (floor ${fmtShares(floor)}).` : '.')
    } else {
      body = `no top-up needed — ${fmtShares(afterProposed)} available after committed`
        + (floor > 0 ? ` clears your ${fmtShares(floor)} floor` : '')
        + ` and meets the ${fmtPct(targetFrac)} target.`
    }
    let tail = ''
    if (floor > 0 && burnPerYear > 0) {
      const yearsToFloor = (afterProposed - floor) / burnPerYear
      if (yearsToFloor > 0) tail = ` At ~${fmtShares(burnRounded)}/yr the floor is reached ~${fmtMY(todayMs + yearsToFloor * YEAR_MS)}.`
    }
    return { cls: status === 'ok' ? 'ok' : 'warn', html: lead + body + tail }
  }
  const initialNote = recNote(defaultTargetPct, defaultFloor)

  // Canonical figures the client recompute() reuses (so the live math can't
  // drift from the headline — it only varies the target % and floor inputs).
  const recData = {
    poolAuthorized,
    afterProposed,          // future-available: available − proposed (ideas excluded)
    postFDS,
    burnPerYear,
    burnRounded,
    todayMs,
    presets: PRESETS,
  }

  // Proposed grants — list ALL of them, sorted largest first, ALWAYS in two
  // side-by-side tables. The recipient cell carries the name + a "title · role"
  // sub-line; award type, vesting start, shares, % FDS, and notes are columns.
  // Columns are narrow (fixed layout) so two of these fit per page; notes wrap.
  const proposedSorted = [...proposed].sort((a, b) => (b.quantity || 0) - (a.quantity || 0))
  function proposedRows(list: Grant[]): string {
    return list.map(g => {
      const name = g.recipient_name || g.job_title || 'Unnamed'
      const subBits = [g.recipient_name ? g.job_title : null, g.recipient_type].filter(Boolean)
      const sub = subBits.length ? `<span class="rsub">${esc(subBits.join(' · '))}</span>` : ''
      return `<tr><td class="name">${esc(name)}${sub}</td><td>${esc(g.award_type || '—')}</td><td>${fmtDate(g.vesting_start)}</td><td class="r sh">${fmtShares(g.quantity)}</td><td class="r pc">${fmtPct(pctOfFds(g.quantity || 0))}</td><td class="notes">${esc(g.notes || '—')}</td></tr>`
    }).join('')
  }
  const proposedTable = (list: Grant[]) =>
    `<table class="prop"><colgroup><col class="c-rec"/><col class="c-aw"/><col class="c-vest"/><col class="c-sh"/><col class="c-pc"/><col class="c-notes"/></colgroup>`
    + `<thead><tr><th>Recipient</th><th>Award</th><th>Vesting</th><th class="r">Shares</th><th class="r">% FDS</th><th>Notes</th></tr></thead>`
    + `<tbody>${proposedRows(list)}</tbody></table>`
  const proposedSplit = Math.ceil(proposedSorted.length / 2)
  const proposedHtml = proposedSorted.length === 0
    ? '<div class="empty">No grants are currently committed.</div>'
    : `<div class="two-col">${proposedTable(proposedSorted.slice(0, proposedSplit))}${proposedSorted.length > proposedSplit ? proposedTable(proposedSorted.slice(proposedSplit)) : ''}</div>`

  // ---- Actionable callout ----
  let calloutClass = 'ok'
  let calloutText = ''
  if (totalProposed <= 0) {
    calloutClass = 'neutral'
    calloutText = `No grants are currently committed. ${fmtShares(unallocated)} options (${fmtPct(pctOfPool(unallocated))} of the pool) are available to grant.`
  } else if (afterProposed < 0) {
    calloutClass = 'warn'
    calloutText = `Action needed — the ${fmtShares(totalProposed)} options committed exceed the unallocated pool by ${fmtShares(overBy)}. Approving them requires a pool top-up of at least that much.`
  } else if (afterProposed < poolAuthorized * 0.05) {
    calloutClass = 'warn'
    calloutText = `Running low — approving the ${fmtShares(totalProposed)} committed options leaves only ${fmtShares(afterProposed)} (${fmtPct(pctOfPool(afterProposed))} of the pool). Plan a top-up for future hires.`
  } else {
    calloutText = `Healthy — approving the ${fmtShares(totalProposed)} committed options (${fmtPct(pctOfFds(totalProposed))} of FDS) still leaves ${fmtShares(afterProposed)} (${fmtPct(pctOfPool(afterProposed))} of the pool) for future grants.`
  }
  if (totalIdeas > 0) calloutText += ` A further ${fmtShares(totalIdeas)} options sit in "proposed" on the pool-impact timeline.`

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
  .slide{max-width:1360px;margin:18px auto 48px;background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:0 12px 34px rgba(15,23,42,.12);padding:20px 40px 14px;display:flex;flex-direction:column;gap:14px}
  .num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
  /* Header band */
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;border-bottom:2px solid #1e1b4b;padding-bottom:8px}
  .head h1{margin:3px 0 1px;font-size:21px;font-weight:800;letter-spacing:-.01em}
  .head .sub{margin:0;color:var(--muted);font-size:12px}
  .badge{display:inline-block;font-size:9.5px;letter-spacing:.14em;font-weight:800;color:#4f46e5;background:#eef2ff;padding:3px 8px;border-radius:999px}
  /* KPI strip */
  .kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
  .kpi{background:#f8fafc;border:1px solid var(--line);border-radius:12px;padding:10px 14px}
  .kpi-value{font-size:22px;font-weight:800;letter-spacing:-.02em;color:var(--ink);font-variant-numeric:tabular-nums}
  .kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-top:2px;font-weight:700}
  .kpi-sub{font-size:11px;color:var(--brand);margin-top:2px;font-weight:600}
  .kpi-sub2{font-size:10px;color:var(--faint);margin-top:1px;font-weight:500;font-variant-numeric:tabular-nums}
  /* Body grid: two columns. Equal-height cards (stretch) so the two modules
     read as a tidy pair rather than two ragged blocks of text. */
  .body{display:grid;grid-template-columns:1.05fr 1fr;gap:16px;align-items:stretch}
  /* Content modules are bordered CARDS with a filled header band, so Pool
     composition / Pool recommendation / Committed grants read as three distinct
     blocks instead of running together on the white slide. */
  .panel{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:0 15px 14px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
  .panel > h2{margin:0 -15px;padding:8px 15px;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--ink);background:#f8fafc;border-bottom:1px solid var(--line);border-radius:11px 11px 0 0}
  .panel > .desc{margin:9px 0 9px;font-size:11px;color:var(--muted)}
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
  /* Pool recommendation: ad-hoc controls + a live target/top-up comparison table */
  .rec-controls{display:flex;flex-wrap:wrap;gap:8px 18px;margin:2px 0 8px}
  .rec-ctl{display:inline-flex;align-items:center;gap:7px;font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.04em}
  .rec-inwrap{display:inline-flex;align-items:baseline;gap:4px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;padding:3px 8px}
  .rec-inwrap input{border:none;outline:none;font-size:13px;font-weight:800;color:var(--brand);text-align:right;font-variant-numeric:tabular-nums;background:transparent;padding:0}
  .rec-inwrap input#rec-target{width:58px}
  .rec-inwrap input#rec-floor{width:104px}
  .rec-inwrap input::-webkit-outer-spin-button,.rec-inwrap input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
  .rec-inwrap input[type=number]{-moz-appearance:textfield;appearance:textfield}
  .rec-unit{font-size:10px;font-weight:600;color:var(--faint);text-transform:none;letter-spacing:0}
  .rec-table{width:100%;border-collapse:collapse;font-size:11.5px;margin-top:2px}
  .rec-table th{text-align:right;font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700;padding:4px 8px;border-bottom:1px solid var(--line)}
  .rec-table td{text-align:right;padding:4px 8px;border-bottom:1px solid #f1f5f9;color:var(--ink-2);font-variant-numeric:tabular-nums}
  .rec-table td:first-child{font-weight:700;color:var(--ink)}
  .rec-table tr:last-child td{border-bottom:none}
  .rec-table tr.rec-met td{color:var(--faint)}
  .rec-table tr.rec-met td:first-child{color:var(--muted)}
  .rec-table tr.rec-custom td{background:#eef2ff;font-weight:800;color:var(--brand)}
  .floor-cell{font-weight:800}
  .ok-dot{color:#059669}
  .bad-dot{color:#dc2626}
  .rec-foot{margin:6px 0 0;font-size:10px;color:var(--faint);font-variant-numeric:tabular-nums}
  /* Recommendation note (shared with the runway-style callout chrome) */
  .pnote{margin:7px 0 0;font-size:11px;line-height:1.32;padding:6px 9px;border-radius:8px;border-left:3px solid}
  .pnote.ok{background:#ecfdf5;color:#065f46;border-color:#34d399}
  .pnote.warn{background:#fef2f2;color:#991b1b;border-color:#f87171}
  .pnote.neutral{background:#f8fafc;color:var(--ink-2);border-color:#cbd5e1}
  /* Proposed grants — ALWAYS two narrow side-by-side tables; notes wrap. */
  .lower{display:grid;grid-template-columns:1fr;gap:14px}
  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:6px 22px;align-items:start}
  table{width:100%;border-collapse:collapse;font-size:11.5px}
  table.prop{table-layout:fixed;font-size:9px;line-height:1.25}
  .prop .c-rec{width:27%}
  .prop .c-aw{width:8%}
  .prop .c-vest{width:14%}
  .prop .c-sh{width:14%}
  .prop .c-pc{width:10%}
  .prop .c-notes{width:27%}
  .two-col td,.two-col th{padding:2px 5px;vertical-align:top}
  th{text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700;padding:4px 9px;border-bottom:1px solid var(--line)}
  td{padding:4px 9px;border-bottom:1px solid #f1f5f9;color:var(--ink-2);font-variant-numeric:tabular-nums}
  td.r,th.r{text-align:right}
  td.sh{font-weight:700;color:var(--ink)}
  td.pc{font-weight:400;color:var(--muted)}
  td.notes{white-space:normal;overflow-wrap:anywhere;color:var(--muted);font-weight:400;font-variant-numeric:normal}
  tr:last-child td{border-bottom:none}
  tbody .name{font-weight:600;color:var(--ink);overflow-wrap:anywhere}
  .rsub{display:block;font-size:8px;color:var(--faint);font-weight:400;margin-top:0}
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
    /* The ad-hoc inputs print as their chosen values, not editable chrome. */
    .rec-inwrap{border-color:transparent;padding:0}
    .rec-inwrap input{color:var(--ink)}
  }
</style>
</head>
<body>
  <div class="toolbar">
    <div class="opts">
      <span class="opts-lbl">Include</span>
      <label><input type="checkbox" data-block="kpis" checked> Headline KPIs</label>
      <label><input type="checkbox" data-block="composition" checked> Pool composition</label>
      <label><input type="checkbox" data-block="poolrec" checked> Pool recommendation</label>
      <label><input type="checkbox" data-block="proposed" checked> Committed grants</label>
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
      ${kpi(fmtShares(totalProposed), 'Committed', `${fmtPct(pctOfFds(totalProposed))} of FDS · ${proposed.length} draft${proposed.length === 1 ? '' : 's'}`)}
      ${kpi(fmtShares(afterProposed), 'Projected available', afterProposed >= 0 ? `${fmtPct(pctOfPool(afterProposed))} of pool · after committed` : `over-allocated by ${fmtShares(overBy)}`)}
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
          <div class="brow sub"><span class="lbl">${afterProposed >= 0 ? 'After committed' : 'Over-allocated by'}</span>${shpc(afterProposed >= 0 ? afterProposed : overBy, pctOfPool(afterProposed >= 0 ? afterProposed : overBy))}</div>
          <div class="brow minor"><span class="lbl">Forfeited / Expired<span class="ret"> · returned to pool</span></span>${shpc(totalForfeitedOrExpired, pctOfPool(totalForfeitedOrExpired))}</div>
        </div>
      </div>

      <div class="panel" data-block="poolrec">
        <h2>Pool recommendation</h2>
        <p class="desc">Top-up to keep the pool above its floor and to hit a target size — set both below and the figures recompute live. "Avail. after" is the unallocated pool after committed grants and the top-up; targets and pool % are measured against post-round FDS.</p>
        <div class="rec-controls">
          <label class="rec-ctl">Target pool
            <span class="rec-inwrap"><input id="rec-target" type="number" min="0" max="60" step="0.5" value="${(defaultTargetPct * 100).toFixed(1)}"><span class="rec-unit">% of FDS</span></span>
          </label>
          <label class="rec-ctl">Floor · keep avail ≥
            <span class="rec-inwrap"><input id="rec-floor" type="number" min="0" step="1000" value="${Math.round(defaultFloor)}"><span class="rec-unit">options</span></span>
          </label>
        </div>
        <p class="pnote ${initialNote.cls}" id="rec-note">${initialNote.html}</p>
        <table class="rec-table">
          <colgroup><col style="width:22%"/><col style="width:21%"/><col style="width:22%"/><col style="width:22%"/><col style="width:13%"/></colgroup>
          <thead><tr><th>Target % FDS</th><th>Top-up</th><th>New pool</th><th>Avail. after</th><th>Floor</th></tr></thead>
          <tbody id="rec-rows">${recRowsHtml}</tbody>
        </table>
        <p class="rec-foot">Current pool ${fmtShares(poolAuthorized)} · ${fmtPct(currentPoolPct)} of FDS${defaultFloor > 0 ? '' : ' · no floor set — enter one above or on the Pool Impact page'}</p>
      </div>
    </section>

    <section class="lower">
      <div class="panel" data-block="proposed">
        <h2>Committed grants</h2>
        <p class="desc">All ${proposed.length} committed grant${proposed.length === 1 ? '' : 's'} — recipient (title · role), award type, vesting start, shares, % of post-round FDS, and notes.</p>
        ${proposedHtml}
        ${proposedSorted.length ? `<div class="proposed-total"><span class="tl">Total committed</span>${shpc(totalProposed, pctOfFds(totalProposed))}</div>` : ''}
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

    // Pool recommendation — live recompute of the note + comparison table as the
    // operator edits the target % / floor (persisted ad hoc to localStorage).
    // The top-up formula mirrors poolTopUpForTarget() in shared/capTableModel.ts;
    // keep the two in lockstep. Every other figure comes pre-computed in REC.
    (function () {
      var elT = document.getElementById('rec-target');
      var elF = document.getElementById('rec-floor');
      var elNote = document.getElementById('rec-note');
      var elRows = document.getElementById('rec-rows');
      if (!elT || !elF || !elNote || !elRows) return;
      var REC = ${JSON.stringify(recData)};
      var YEAR_MS = 365.25 * 86400000;
      var KEY = 'pariva-board-slide-rec';
      try {
        var saved = JSON.parse(localStorage.getItem(KEY) || '{}');
        if (saved && typeof saved.target === 'number') elT.value = saved.target;
        if (saved && typeof saved.floor === 'number') elF.value = saved.floor;
      } catch (e) {}

      function fShares(n) { return (n == null || !isFinite(n)) ? '—' : Math.round(n).toLocaleString('en-US'); }
      function fPct(frac) { return (frac == null || !isFinite(frac)) ? '—' : (frac * 100).toFixed(1) + '%'; }
      function fMY(ms) { return new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }); }
      // T = t·fds − pool, floored at 0 (straight % of post-round FDS, NOT
      // grossed up) — see poolTopUpForTarget().
      function topUpFor(t) {
        if (!(t > 0) || t >= 1) return 0;
        var x = t * REC.postFDS - REC.poolAuthorized;
        return x > 0 ? Math.round(x) : 0;
      }
      function pctAfter(topUp) {
        // Fixed denominator: the top-up adds to the pool, FDS stays post-round.
        return REC.postFDS > 0 ? (REC.poolAuthorized + topUp) / REC.postFDS : 0;
      }
      function rowHtml(targetFrac, floor, custom) {
        var topUp = topUpFor(targetFrac);
        var availAfter = REC.afterProposed + topUp;
        var meets = floor > 0 ? (availAfter >= floor) : null;
        var flag = meets == null ? '' : (meets ? '<span class="ok-dot">✓</span>' : '<span class="bad-dot">✗</span>');
        var cls = ((custom ? 'rec-custom' : '') + (topUp <= 0 ? ' rec-met' : '')).trim();
        return '<tr class="' + cls + '"><td>' + fPct(targetFrac) + '</td><td>' + (topUp > 0 ? fShares(topUp) : '—')
          + '</td><td>' + fShares(REC.poolAuthorized + topUp) + '</td><td>' + fShares(availAfter)
          + '</td><td class="floor-cell">' + flag + '</td></tr>';
      }
      function recompute() {
        var targetFrac = (parseFloat(elT.value) || 0) / 100;
        var floor = parseFloat(elF.value) || 0;
        var fracs = [];
        for (var i = 0; i < REC.presets.length; i++) {
          if (Math.abs(REC.presets[i] - targetFrac) > 0.001) fracs.push(REC.presets[i]);
        }
        fracs.push(targetFrac);
        fracs.sort(function (a, b) { return a - b; });
        var rows = '';
        for (var j = 0; j < fracs.length; j++) rows += rowHtml(fracs[j], floor, Math.abs(fracs[j] - targetFrac) < 1e-9);
        elRows.innerHTML = rows;

        var floorTopUp = floor > 0 ? Math.max(0, floor - REC.afterProposed) : 0;
        var recTopUp = Math.round(Math.max(floorTopUp, topUpFor(targetFrac)));
        var availAfter = REC.afterProposed + recTopUp;
        var status = (floor > 0 && REC.afterProposed < floor) ? 'below'
          : (floor > 0 && REC.afterProposed < floor * 1.2) ? 'near' : 'ok';
        var lead = status === 'below' ? 'Below floor — ' : status === 'near' ? 'Approaching floor — ' : 'Healthy — ';
        var body;
        if (recTopUp > 0) {
          body = 'recommended top-up ≈ <b>' + fShares(recTopUp) + '</b> options → pool at <b>' + fPct(pctAfter(recTopUp))
            + '</b> of FDS, leaving ' + fShares(availAfter) + ' available after committed' + (floor > 0 ? ' (floor ' + fShares(floor) + ').' : '.');
        } else {
          body = 'no top-up needed — ' + fShares(REC.afterProposed) + ' available after committed'
            + (floor > 0 ? ' clears your ' + fShares(floor) + ' floor' : '') + ' and meets the ' + fPct(targetFrac) + ' target.';
        }
        var tail = '';
        if (floor > 0 && REC.burnPerYear > 0) {
          var ytf = (REC.afterProposed - floor) / REC.burnPerYear;
          if (ytf > 0) tail = ' At ~' + fShares(REC.burnRounded) + '/yr the floor is reached ~' + fMY(REC.todayMs + ytf * YEAR_MS) + '.';
        }
        elNote.className = 'pnote ' + (status === 'ok' ? 'ok' : 'warn');
        elNote.innerHTML = lead + body + tail;
        try { localStorage.setItem(KEY, JSON.stringify({ target: parseFloat(elT.value) || 0, floor: floor })); } catch (e) {}
      }
      elT.addEventListener('input', recompute);
      elF.addEventListener('input', recompute);
      recompute();
    })();
  </script>
</body>
</html>`

  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setHeader(event, 'Content-Disposition', `inline; filename="${company.slug || 'company'}-board-slide-${today.toISOString().slice(0, 10)}.html"`)
  return html
})
