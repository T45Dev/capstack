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

type Stage = 'Founders' | 'Seed' | 'Series'

// Map a round to one of the three board buckets. Formation is always Founders;
// a Seed/angel/pre-seed name lands in Seed; every other priced round (Series
// A/B/C, Carta codes like SA1/PB1, bridges, extensions) rolls into Series. The
// slide lists the round names under each bucket so the operator can eyeball the
// classification and re-name a round if it landed in the wrong place.
function stageOf(r: { kind: string; code: string; name: string | null }): Stage {
  if (r.kind === 'formation') return 'Founders'
  const t = `${r.code || ''} ${r.name || ''}`.toLowerCase()
  if (/found|formation|common\b|^cs\b/.test(t)) return 'Founders'
  if (/seed|angel|pre[-\s]?seed|friends|f&f/.test(t)) return 'Seed'
  return 'Series'
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

  // ---- Decompose the allocated pool by funding-stage era ----
  // A grant belongs to the latest round closed on/before its issue date (undated
  // / pre-first-round grants fall to the earliest round). Unlike the per-round
  // Rounds table we do NOT bump formation-era grants forward: an option granted
  // before the seed round is a genuine Founders-era allocation and should read as
  // such. Each grant's (outstanding + exercised) lands in exactly one stage, so
  // the three bars sum EXACTLY to the allocated figure above.
  const roundsByClose = [...rounds].sort((a, b) => {
    const ad = a.close_date || '', bd = b.close_date || ''
    if (ad && bd && ad !== bd) return ad < bd ? -1 : 1
    if (ad && !bd) return -1
    if (!ad && bd) return 1
    return (a.seniority || 0) - (b.seniority || 0)
  })
  function eraRound(when: string | null): RoundCol | null {
    let target: RoundCol | null = roundsByClose[0] || null
    for (const r of roundsByClose) {
      if (r.close_date && when && r.close_date <= when) target = r
      else if (r.close_date && when && r.close_date > when) break
    }
    return target
  }
  const stages: Record<Stage, { shares: number; roundNames: string[] }> = {
    Founders: { shares: 0, roundNames: [] },
    Seed: { shares: 0, roundNames: [] },
    Series: { shares: 0, roundNames: [] },
  }
  // List which rounds map to each bucket (even buckets with no grants yet) so
  // the operator can eyeball the classification and re-name a round if needed.
  for (const r of roundsByClose) {
    const label = (r.name || r.code || '').trim()
    if (!label) continue
    const s = stageOf(r)
    if (!stages[s].roundNames.includes(label)) stages[s].roundNames.push(label)
  }
  for (const g of outstanding) {
    const er = eraRound(g.issue_date)
    const s = er ? stageOf(er) : 'Founders'
    stages[s].shares += grantOutstanding(g) + (g.quantity_exercised || 0)
  }

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

  const C = {
    outstanding: '#4f46e5', exercised: '#0891b2', proposed: '#f59e0b',
    available: '#cbd5e1', over: '#dc2626',
    founders: '#7c3aed', seed: '#0d9488', series: '#4f46e5',
  }

  // Consistent value cell used everywhere a figure is shown: bold shares, then a
  // gap, then a non-bold % — both right-aligned in fixed columns so they line up
  // across every row (no dots, no misalignment).
  const shpc = (shares: number, pctFrac: number) =>
    `<span class="sh">${fmtShares(shares)}</span><span class="pc">${fmtPct(pctFrac)}</span>`

  function hbars(items: Array<{ label: string; value: number; shares: number; pctFrac: number; sub?: string; color: string }>): string {
    if (!items.length) return '<div class="empty">Nothing to show.</div>'
    const max = Math.max(1, ...items.map(i => i.value))
    return `<div class="bars">${items.map(i => `
      <div class="bar-row">
        <div class="bar-label" title="${esc(i.label)}">${esc(i.label)}${i.sub ? `<span class="bar-sub">${esc(i.sub)}</span>` : ''}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (i.value / max) * 100).toFixed(1)}%;background:${i.color}"></div></div>
        <div class="bar-value">${shpc(i.shares, i.pctFrac)}</div>
      </div>`).join('')}</div>`
  }

  function kpi(value: string, label: string, sub = '', sub2 = ''): string {
    return `<div class="kpi"><div class="kpi-value">${esc(value)}</div><div class="kpi-label">${esc(label)}</div>${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ''}${sub2 ? `<div class="kpi-sub2">${esc(sub2)}</div>` : ''}</div>`
  }

  const overBy = afterProposed < 0 ? Math.abs(afterProposed) : 0

  const stageBars = (['Founders', 'Seed', 'Series'] as Stage[]).map(s => ({
    label: s,
    value: stages[s].shares,
    shares: stages[s].shares,
    pctFrac: pctOfPool(stages[s].shares),
    sub: stages[s].roundNames.length
      ? stages[s].roundNames.slice(0, 4).join(', ') + (stages[s].roundNames.length > 4 ? ` +${stages[s].roundNames.length - 4}` : '')
      : '—',
    color: s === 'Founders' ? C.founders : s === 'Seed' ? C.seed : C.series,
  }))

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

  const today = new Date()
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
  .toolbar{max-width:1180px;margin:0 auto;padding:14px 20px 0;display:flex;justify-content:space-between;align-items:center;gap:16px}
  .toolbar .t{font-size:13px;color:var(--muted)}
  .print-btn{cursor:pointer;border:1px solid #cbd5e1;background:#fff;color:var(--ink);font-size:12.5px;font-weight:600;padding:9px 14px;border-radius:10px}
  .print-btn:hover{background:#f8fafc}
  /* The slide: one landscape page. */
  .slide{max-width:1360px;margin:18px auto 48px;background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:0 12px 34px rgba(15,23,42,.12);padding:24px 40px 18px;display:flex;flex-direction:column;gap:11px}
  .num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
  /* Header band */
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;border-bottom:2px solid #1e1b4b;padding-bottom:8px}
  .head h1{margin:3px 0 1px;font-size:21px;font-weight:800;letter-spacing:-.01em}
  .head .sub{margin:0;color:var(--muted);font-size:12px}
  .badge{display:inline-block;font-size:9.5px;letter-spacing:.14em;font-weight:800;color:#4f46e5;background:#eef2ff;padding:3px 8px;border-radius:999px}
  /* KPI strip */
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
  .kpi{background:#f8fafc;border:1px solid var(--line);border-radius:12px;padding:11px 15px}
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
  /* Horizontal bars */
  .bars{display:flex;flex-direction:column;gap:9px}
  .bar-row{display:grid;grid-template-columns:1fr 160px;grid-template-areas:"label value" "track track";column-gap:12px;row-gap:3px;align-items:center}
  .bar-label{grid-area:label;font-size:12px;color:var(--ink);font-weight:700;overflow:hidden}
  .bar-sub{display:block;font-size:10px;color:var(--faint);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bar-track{grid-area:track;background:#f1f5f9;border-radius:6px;height:13px;overflow:hidden}
  .bar-fill{height:100%;border-radius:6px;min-width:2px}
  .bar-value{grid-area:value;display:grid;grid-template-columns:1fr 50px;column-gap:8px;align-items:baseline;font-size:12px}
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
  .callout{font-size:12px;border-radius:10px;padding:9px 14px;line-height:1.35}
  .callout.ok{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}
  .callout.warn{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
  .callout.neutral{background:#f8fafc;color:var(--ink-2);border:1px solid var(--line)}
  .callout b{font-weight:800}
  .foot{display:flex;justify-content:space-between;color:var(--faint);font-size:10px;border-top:1px solid var(--line);padding-top:9px;margin-top:2px}
  @media (max-width:880px){ .kpis{grid-template-columns:repeat(2,1fr)} .body{grid-template-columns:1fr} }
  @page{ size:landscape; margin:7mm 6mm }
  @media print{
    body{background:#fff}
    .toolbar{display:none}
    .slide{max-width:none;margin:0;border:none;box-shadow:none;border-radius:0;padding:4px 14px;gap:9px}
  }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="t">Board slide · ready to print or drop into a deck</span>
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

    <section class="kpis">
      ${kpi(fmtShares(poolAuthorized), 'Total option pool', `${fmtPct(pctOfFds(poolAuthorized))} of FDS`, `FDS basis ${fmtShares(postFDS)}`)}
      ${kpi(fmtShares(allocated), 'Allocated', `${fmtPct(pctOfPool(allocated))} of pool`)}
      ${kpi(fmtShares(unallocated), 'Unallocated', `${fmtPct(pctOfPool(unallocated))} of pool`)}
      ${kpi(fmtShares(totalProposed), 'Proposed', `${fmtPct(pctOfFds(totalProposed))} of FDS · ${proposed.length} draft${proposed.length === 1 ? '' : 's'}`)}
    </section>

    <section class="body">
      <div class="panel">
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

      <div class="panel">
        <h2>Allocated by funding stage</h2>
        <p class="desc">Where the ${fmtShares(allocated)} allocated options were granted, by round era. % is of the total pool.</p>
        ${hbars(stageBars)}
      </div>
    </section>

    <section class="lower">
      <div class="panel">
        <h2>Proposed grants</h2>
        <p class="desc">All ${proposed.length} proposed grant${proposed.length === 1 ? '' : 's'} — recipient (title · role), award type, vesting start, with shares and % of post-round FDS.</p>
        ${proposedHtml}
        ${proposedSorted.length ? `<div class="proposed-total"><span class="tl">Total proposed</span>${shpc(totalProposed, pctOfFds(totalProposed))}</div>` : ''}
      </div>
      <div class="callout ${calloutClass}">${calloutText}</div>
    </section>

    <div class="foot">
      <span>Generated by Pariva, a tool by T45 Labs · ${esc(generatedOn)} · Confidential</span>
    </div>
  </div>
</body>
</html>`

  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setHeader(event, 'Content-Disposition', `inline; filename="${company.slug || 'company'}-board-slide-${today.toISOString().slice(0, 10)}.html"`)
  return html
})
