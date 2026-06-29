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
//   5. Should the pool be TOPPED UP to hit a target % of FDS? The Pool-
//      recommendation block sizes that top-up and lets the operator compare
//      target sizes ad hoc on the preview (recomputed live).
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
  round: string | null          // batch name (Carta/import "Batch" → grants.round)
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
  // Draft grants (status='proposed') drive the pool's "committed" load. For the
  // middle-column DISPLAY they split by board approval status — the same split
  // the Option Grants page and the board-approval xlsx use:
  //   committed = Approved drafts; proposed = still-pending drafts (Rejected drops).
  const proposed = grants.filter(g => g.status === 'proposed')
  const committedList = proposed.filter(g => g.approval_status === 'Approved')
  const proposedList = proposed.filter(g => g.approval_status !== 'Approved' && g.approval_status !== 'Rejected')
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
  const pctOfPool = (n: number) => poolAuthorized > 0 ? n / poolAuthorized : 0
  const pctOfFds = (n: number) => postFDS > 0 ? n / postFDS : 0
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
  //  Pool recommendation — target option-pool size as a % of FDS
  // =====================================================================
  // One lever: the operator sets a target pool size (% of post-round FDS) and
  // the block shows the top-up to reach it, plus a comparison across preset
  // sizes. Sizing is the shared poolTopUpForTarget helper; the client
  // recompute() below mirrors the same formula (the slide is a static page).
  const currentPoolPct = poolPctOfFds(poolAuthorized, postFDS)
  const niceCeil = (frac: number) => Math.ceil(Math.max(0, frac) / 0.025) * 0.025
  const defaultTargetPct = niceCeil(Math.max(currentPoolPct, 0.15))
  // Floor lever: the minimum the available pool shouldn't fall below. Seeded
  // from a "floor" event on the Pool Impact timeline (highest wins) and editable
  // ad hoc here. The recommended top-up is the larger of what the target asks
  // and what the floor needs.
  const floorShares = (poolEventsRaw || [])
    .filter((e: any) => e.type === 'floor')
    .reduce((a: number, e: any) => Math.max(a, e.shares || 0), 0)
  const defaultFloor = floorShares > 0 ? floorShares : 0

  const PRESETS = [0.10, 0.125, 0.15, 0.20]
  const topUpFor = (targetFrac: number) =>
    Math.round(poolTopUpForTarget({ poolAuthorized, fds: postFDS, targetPctOfFds: targetFrac }))
  // The "Avail. after" cell carries a live ✓/✗ vs the floor, so the table
  // reacts to the floor input (and explains why the note may recommend more).
  function recRowHtml(targetFrac: number, floor: number, custom: boolean): string {
    const topUp = topUpFor(targetFrac)
    const availAfter = afterProposed + topUp
    const flag = floor > 0 ? (availAfter >= floor ? '<span class="ok-dot">✓</span>' : '<span class="bad-dot">✗</span>') : ''
    const cls = `${custom ? 'rec-custom' : ''}${topUp <= 0 ? ' rec-met' : ''}`.trim()
    return `<tr class="${cls}"><td>${fmtPct(targetFrac)}</td><td>${topUp > 0 ? fmtShares(topUp) : '—'}</td>`
      + `<td>${fmtShares(poolAuthorized + topUp)}</td><td>${fmtShares(availAfter)}${flag}</td></tr>`
  }
  const recRowFracs = Array.from(new Set([
    ...PRESETS.filter(p => Math.abs(p - defaultTargetPct) > 0.001),
    defaultTargetPct,
  ])).sort((a, b) => a - b)
  const recRowsHtml = recRowFracs.map(f => recRowHtml(f, defaultFloor, Math.abs(f - defaultTargetPct) < 1e-9)).join('')

  // Headline note: the recommended top-up — the LARGER of what the target asks
  // and what the floor needs — and what's left after proposed grants.
  function recNote(targetFrac: number, floor: number): { cls: string; html: string } {
    const targetTopUp = topUpFor(targetFrac)
    const floorTopUp = floor > 0 ? Math.max(0, Math.round(floor - afterProposed)) : 0
    const recTopUp = Math.max(targetTopUp, floorTopUp)
    const availAfter = afterProposed + recTopUp
    let html: string
    if (recTopUp > 0) {
      html = `Top up ≈ <b>${fmtShares(recTopUp)}</b> options → ${fmtShares(poolAuthorized + recTopUp)} (${fmtPct(poolPctOfFds(poolAuthorized, postFDS, recTopUp))} of FDS), leaving ${fmtShares(availAfter)} available`
        + (floor > 0 ? ` — clears the ${fmtShares(floor)} floor.` : ` to reach the ${fmtPct(targetFrac)} target.`)
    } else {
      html = `No top-up needed — the pool is <b>${fmtPct(currentPoolPct)}</b> of FDS, ${fmtShares(afterProposed)} available after proposed grants`
        + (floor > 0 ? `, clearing the ${fmtShares(floor)} floor.` : `, at or above the ${fmtPct(targetFrac)} target.`)
    }
    return { cls: availAfter >= 0 ? 'ok' : 'warn', html }
  }
  const initialNote = recNote(defaultTargetPct, defaultFloor)

  // Canonical figures the client recompute() reuses (so the live math can't
  // drift from the headline — it only varies the target % input).
  const recData = {
    poolAuthorized,
    afterProposed,          // future-available: available − proposed grants
    postFDS,
    floor: defaultFloor,
    presets: PRESETS,
  }

  // One shared grant-row renderer so Committed and Proposed look identical:
  // the grantee's name with their job title inline next to it (no award-type or
  // recipient-type tags), the note on its own full-width line beneath (free to
  // run under the share count), and the shares + % FDS on the right.
  function grantRow(g: Grant): string {
    const name = g.recipient_name || g.job_title || 'Unnamed'
    const title = (g.recipient_name && g.job_title) ? g.job_title : null
    return `<div class="pgrant">`
      + `<div class="pg-top"><div class="pg-id"><span class="pg-name">${esc(name)}</span>${title ? `<span class="pg-title">${esc(title)}</span>` : ''}</div>`
      + `<div class="pg-val"><span class="sh">${fmtShares(g.quantity)}</span><span class="pc">${fmtPct(pctOfFds(g.quantity || 0))}</span></div></div>`
      + `${g.notes ? `<div class="pg-note">${esc(g.notes)}</div>` : ''}</div>`
  }

  // Committed grants (board-Approved) — a flat list, largest first.
  const committedSorted = [...committedList].sort((a, b) => (b.quantity || 0) - (a.quantity || 0))
  const committedTotal = committedSorted.reduce((a, g) => a + (g.quantity || 0), 0)
  const committedHtml = committedSorted.map(grantRow).join('')

  // Proposed grants (still pending) — GROUPED BY BATCH (grants.round), same row
  // style as Committed. Batches and the grants in them sort largest-first;
  // un-batched grants fall under "No batch".
  const proposedTotal = proposedList.reduce((a, g) => a + (g.quantity || 0), 0)
  function proposedGroupsHtml(list: Grant[]): string {
    const groups = new Map<string, Grant[]>()
    for (const g of list) {
      const key = (g.round && g.round.trim()) || 'No batch'
      const arr = groups.get(key) || []
      arr.push(g)
      groups.set(key, arr)
    }
    const ordered = [...groups.entries()]
      .map(([batch, gs]) => ({ batch, gs: gs.sort((a, b) => (b.quantity || 0) - (a.quantity || 0)), sum: gs.reduce((a, g) => a + (g.quantity || 0), 0) }))
      .sort((a, b) => b.sum - a.sum)
    return ordered.map(({ batch, gs, sum }) =>
      `<div class="pgroup"><div class="pgroup-h"><span class="pgroup-name">${esc(batch)}</span><span class="pgroup-sum">${fmtShares(sum)} · ${fmtPct(pctOfFds(sum))}</span></div>${gs.map(grantRow).join('')}</div>`,
    ).join('')
  }
  const proposedHtml = proposedList.length === 0
    ? '<div class="empty">No proposed grants.</div>'
    : proposedGroupsHtml(proposedList)

  // ---- Actionable health verdict ----
  // calloutClass drives the colour; healthLabel is the big "look-at-me" word the
  // health card leads with.
  let calloutClass = 'ok'
  let healthLabel = 'Healthy'
  let calloutText = ''
  if (totalProposed <= 0) {
    calloutClass = 'neutral'; healthLabel = 'No commitments'
    calloutText = `No grants are currently committed. ${fmtShares(unallocated)} options (${fmtPct(pctOfPool(unallocated))} of the pool) are available to grant.`
  } else if (afterProposed < 0) {
    calloutClass = 'warn'; healthLabel = 'Action needed'
    calloutText = `The ${fmtShares(totalProposed)} options committed exceed the unallocated pool by ${fmtShares(overBy)}. Approving them requires a pool top-up of at least that much.`
  } else if (afterProposed < poolAuthorized * 0.05) {
    calloutClass = 'warn'; healthLabel = 'Running low'
    calloutText = `Approving the ${fmtShares(totalProposed)} committed options leaves only ${fmtShares(afterProposed)} (${fmtPct(pctOfPool(afterProposed))} of the pool). Plan a top-up for future hires.`
  } else {
    healthLabel = 'Healthy'
    calloutText = `Approving the ${fmtShares(totalProposed)} committed options (${fmtPct(pctOfFds(totalProposed))} of FDS) still leaves ${fmtShares(afterProposed)} (${fmtPct(pctOfPool(afterProposed))} of the pool) for future grants.`
  }
  const healthIcon = calloutClass === 'ok' ? '✓' : calloutClass === 'warn' ? '!' : '•'

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
  .kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
  .kpi{background:#f8fafc;border:1px solid var(--line);border-radius:12px;padding:10px 14px}
  .kpi-value{font-size:22px;font-weight:800;letter-spacing:-.02em;color:var(--ink);font-variant-numeric:tabular-nums}
  .kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-top:2px;font-weight:700}
  .kpi-sub{font-size:11px;color:var(--brand);margin-top:2px;font-weight:600}
  .kpi-sub2{font-size:10px;color:var(--faint);margin-top:1px;font-weight:500;font-variant-numeric:tabular-nums}
  /* Body: three EQUAL columns. Left stacks composition + health; the middle
     column stacks the grants lists (committed and/or proposed); the right column
     is the pool recommendation. */
  .body{display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px;align-items:start}
  .col-stack{display:flex;flex-direction:column;gap:18px;min-width:0}
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
  /* Pool recommendation: ad-hoc controls + a live target/top-up comparison table */
  .rec-controls{display:flex;flex-wrap:wrap;gap:8px 18px;margin:2px 0 8px}
  .rec-ctl{display:inline-flex;align-items:center;gap:7px;font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.04em}
  .rec-inwrap{display:inline-flex;align-items:baseline;gap:4px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;padding:3px 8px}
  .rec-inwrap input{border:none;outline:none;font-size:13px;font-weight:800;color:var(--brand);text-align:right;font-variant-numeric:tabular-nums;background:transparent;padding:0}
  .rec-inwrap input#rec-target{width:52px}
  .rec-inwrap input#rec-floor{width:74px}
  .rec-inwrap input::-webkit-outer-spin-button,.rec-inwrap input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
  .rec-inwrap input[type=number]{-moz-appearance:textfield;appearance:textfield}
  .rec-unit{font-size:10px;font-weight:600;color:var(--faint);text-transform:none;letter-spacing:0}
  /* Squished so the "Target % FDS" header sits on a single line. */
  .rec-table{width:100%;border-collapse:collapse;font-size:11px;margin-top:2px}
  .rec-table th{text-align:right;font-size:9px;text-transform:uppercase;letter-spacing:.01em;color:var(--muted);font-weight:700;padding:4px 4px;border-bottom:1px solid var(--line);white-space:nowrap}
  .rec-table td{text-align:right;padding:4px 4px;border-bottom:1px solid #f1f5f9;color:var(--ink-2);font-variant-numeric:tabular-nums}
  .rec-table td:first-child{font-weight:700;color:var(--ink)}
  .rec-table tr:last-child td{border-bottom:none}
  .rec-table tr.rec-met td{color:var(--faint)}
  .rec-table tr.rec-met td:first-child{color:var(--muted)}
  .rec-table tr.rec-custom td{background:#eef2ff;font-weight:800;color:var(--brand)}
  .ok-dot{color:#059669;font-weight:800;margin-left:5px}
  .bad-dot{color:#dc2626;font-weight:800;margin-left:5px}
  .rec-foot{margin:6px 0 0;font-size:10px;color:var(--faint);font-variant-numeric:tabular-nums}
  /* Recommendation note (shared with the runway-style callout chrome) */
  .pnote{margin:7px 0 0;font-size:11px;line-height:1.32;padding:6px 9px;border-radius:8px;border-left:3px solid}
  .pnote.ok{background:#ecfdf5;color:#065f46;border-color:#34d399}
  .pnote.warn{background:#fef2f2;color:#991b1b;border-color:#f87171}
  .pnote.neutral{background:#f8fafc;color:var(--ink-2);border-color:#cbd5e1}
  .empty{font-size:12px;color:var(--faint);padding:8px 0;font-style:italic}
  .proposed-total{display:flex;align-items:baseline;gap:10px;border-top:2px solid var(--line);padding-top:7px;margin-top:7px;font-size:12px}
  .proposed-total .tl{font-weight:800;color:var(--ink);margin-right:auto}
  /* Grant rows — ONE style shared by Committed and Proposed for consistency.
     Name, an "award · title · role" line, then the note on its own full-width
     line (free to run beneath the share count); shares + % FDS on the right. */
  .pgroup{margin-bottom:9px}
  .pgroup-h{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:2px 0 3px;padding-bottom:3px;border-bottom:1px solid var(--line)}
  .pgroup-name{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--brand)}
  .pgroup-sum{font-size:10px;font-weight:600;color:var(--muted);font-variant-numeric:tabular-nums}
  .pgrant{padding:4px 0;border-bottom:1px solid #f1f5f9}
  .pgrant:last-child{border-bottom:none}
  .pg-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
  .pg-id{min-width:0}
  .pg-name{font-size:11.5px;font-weight:600;color:var(--ink)}
  .pg-title{font-size:9.5px;color:var(--muted);margin-left:6px}
  .pg-note{font-size:9px;color:var(--faint);line-height:1.3;margin-top:3px}
  .pg-val{white-space:nowrap;text-align:right;flex:none}
  .pg-val .sh{font-size:11px}.pg-val .pc{margin-left:7px;font-size:10px}
  /* Health verdict — leads with a big status word so it reads at a glance. */
  .callout{font-size:11.5px;border-radius:10px;padding:9px 12px;line-height:1.32}
  .callout.ok{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}
  .callout.warn{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
  .callout.neutral{background:#f8fafc;color:var(--ink-2);border:1px solid var(--line)}
  .callout b{font-weight:800}
  .health-wrap{margin-top:11px}
  .health-banner{display:flex;align-items:center;gap:10px;border-radius:10px;padding:9px 13px;margin-bottom:8px}
  .health-banner.ok{background:#059669;color:#fff}
  .health-banner.warn{background:#dc2626;color:#fff}
  .health-banner.neutral{background:#475569;color:#fff}
  .health-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:999px;background:rgba(255,255,255,.22);font-size:14px;font-weight:800;flex:none}
  .health-word{font-size:17px;font-weight:800;letter-spacing:-.01em}
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
      <label><input type="checkbox" data-block="health" checked> Health check</label>
      ${committedSorted.length ? '<label><input type="checkbox" data-block="committed" checked> Committed grants</label>' : ''}
      <label><input type="checkbox" data-block="proposed" checked> Proposed grants</label>
      <label><input type="checkbox" data-block="poolrec" checked> Pool recommendation</label>
    </div>
    <button class="print-btn" onclick="window.print()">⎙ Print / Save as PDF</button>
  </div>

  <div class="slide">
    <header class="head">
      <div>
        <h1>${esc(company.name)} — Option Pool</h1>
        <p class="sub">Board review${roundName ? ` · modelling ${esc(roundName)}` : ''}</p>
      </div>
    </header>

    <section class="kpis" data-block="kpis">
      ${kpi(fmtShares(poolAuthorized), 'Total option pool', `${fmtPct(pctOfFds(poolAuthorized))} of FDS (${fmtShares(postFDS)})`)}
      ${kpi(fmtShares(allocated), 'Allocated', `${fmtPct(pctOfPool(allocated))} of pool`)}
      ${kpi(fmtShares(unallocated), 'Unallocated', `${fmtPct(pctOfPool(unallocated))} of pool`)}
      ${kpi(fmtShares(totalProposed), committedSorted.length ? 'Committed + proposed' : 'Proposed grants', `${fmtPct(pctOfFds(totalProposed))} of FDS · ${proposed.length} proposed grant${proposed.length === 1 ? '' : 's'}`)}
      ${kpi(fmtShares(afterProposed), 'Projected available', afterProposed >= 0 ? `${fmtPct(pctOfPool(afterProposed))} of pool after proposed` : `over-allocated by ${fmtShares(overBy)}`)}
    </section>

    <section class="body">
      <div class="col-stack">
        <div class="panel" data-block="composition">
          <h2>Pool composition</h2>
          <p class="desc">How the ${fmtShares(poolAuthorized)}-option pool breaks down. Allocated = outstanding + exercised; % is of the pool.</p>
          <div class="breakdown">
            <div class="brow head"><span class="lbl">Allocated</span>${shpc(allocated, pctOfPool(allocated))}</div>
            <div class="brow sub"><span class="lbl">Outstanding (held)</span>${shpc(allocatedOutstanding, pctOfPool(allocatedOutstanding))}</div>
            <div class="brow sub"><span class="lbl">Exercised</span>${shpc(allocatedExercised, pctOfPool(allocatedExercised))}</div>
            <div class="brow head"><span class="lbl">Available</span>${shpc(unallocated, pctOfPool(unallocated))}</div>
            <div class="brow sub"><span class="lbl">${afterProposed >= 0 ? 'After committed' : 'Over-allocated by'}</span>${shpc(afterProposed >= 0 ? afterProposed : overBy, pctOfPool(afterProposed >= 0 ? afterProposed : overBy))}</div>
            <div class="brow minor"><span class="lbl">Forfeited / Expired<span class="ret"> · returned to pool</span></span>${shpc(totalForfeitedOrExpired, pctOfPool(totalForfeitedOrExpired))}</div>
          </div>
          <div class="health-wrap" data-block="health">
            <div class="health-banner ${calloutClass}"><span class="health-icon">${healthIcon}</span><span class="health-word">${healthLabel}</span></div>
            <div class="callout ${calloutClass}">${calloutText}</div>
          </div>
        </div>
      </div>

      <div class="col-stack">
        ${committedSorted.length ? `<div class="panel" data-block="committed">
          <h2>Committed grants</h2>
          <p class="desc">${committedSorted.length} board-approved grant${committedSorted.length === 1 ? '' : 's'} — shares and % of post-round FDS.</p>
          ${committedHtml}
          <div class="proposed-total"><span class="tl">Total committed</span>${shpc(committedTotal, pctOfFds(committedTotal))}</div>
        </div>` : ''}

        <div class="panel" data-block="proposed">
          <h2>Proposed grants</h2>
          <p class="desc">${proposedList.length} proposed grant${proposedList.length === 1 ? '' : 's'}, grouped by batch — the note sits under each grantee.</p>
          ${proposedHtml}
          ${proposedList.length ? `<div class="proposed-total"><span class="tl">Total proposed</span>${shpc(proposedTotal, pctOfFds(proposedTotal))}</div>` : ''}
        </div>
      </div>

      <div class="panel" data-block="poolrec">
        <h2>Pool recommendation</h2>
        <p class="desc">Set a target option-pool size as a % of FDS and the top-up recomputes live. "Avail. after" is the unallocated pool after committed grants and the top-up; targets and pool % are measured against post-round FDS.</p>
        <div class="rec-controls">
          <label class="rec-ctl">Target pool
            <span class="rec-inwrap"><input id="rec-target" type="number" min="0" max="60" step="0.5" value="${(defaultTargetPct * 100).toFixed(1)}"><span class="rec-unit">% of FDS</span></span>
          </label>
          <label class="rec-ctl">Floor
            <span class="rec-inwrap"><input id="rec-floor" type="number" min="0" step="1000" value="${Math.round(defaultFloor)}"><span class="rec-unit">options</span></span>
          </label>
        </div>
        <p class="pnote ${initialNote.cls}" id="rec-note">${initialNote.html}</p>
        <table class="rec-table">
          <colgroup><col style="width:31%"/><col style="width:23%"/><col style="width:23%"/><col style="width:23%"/></colgroup>
          <thead><tr><th>Target % FDS</th><th>Top-up</th><th>New pool</th><th>Avail. after</th></tr></thead>
          <tbody id="rec-rows">${recRowsHtml}</tbody>
        </table>
        <p class="rec-foot">Current pool ${fmtShares(poolAuthorized)} · ${fmtPct(currentPoolPct)} of FDS</p>
      </div>
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
    // operator edits the target % (persisted ad hoc to localStorage). The top-up
    // formula mirrors poolTopUpForTarget() in shared/capTableModel.ts; keep the
    // two in lockstep. Every other figure comes pre-computed in REC.
    (function () {
      var elT = document.getElementById('rec-target');
      var elF = document.getElementById('rec-floor');
      var elNote = document.getElementById('rec-note');
      var elRows = document.getElementById('rec-rows');
      if (!elT || !elNote || !elRows) return;
      var REC = ${JSON.stringify(recData)};
      var KEY = 'pariva-board-slide-rec';
      try {
        var saved = JSON.parse(localStorage.getItem(KEY) || '{}');
        if (saved && typeof saved.target === 'number') elT.value = saved.target;
        if (elF && saved && typeof saved.floor === 'number') elF.value = saved.floor;
      } catch (e) {}

      function fShares(n) { return (n == null || !isFinite(n)) ? '—' : Math.round(n).toLocaleString('en-US'); }
      function fPct(frac) { return (frac == null || !isFinite(frac)) ? '—' : (frac * 100).toFixed(1) + '%'; }
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
        var flag = floor > 0 ? (availAfter >= floor ? '<span class="ok-dot">✓</span>' : '<span class="bad-dot">✗</span>') : '';
        var cls = ((custom ? 'rec-custom' : '') + (topUp <= 0 ? ' rec-met' : '')).trim();
        return '<tr class="' + cls + '"><td>' + fPct(targetFrac) + '</td><td>' + (topUp > 0 ? fShares(topUp) : '—')
          + '</td><td>' + fShares(REC.poolAuthorized + topUp) + '</td><td>' + fShares(availAfter) + flag + '</td></tr>';
      }
      function recompute() {
        var targetFrac = (parseFloat(elT.value) || 0) / 100;
        var floor = elF ? (parseFloat(elF.value) || 0) : 0;
        var fracs = [];
        for (var i = 0; i < REC.presets.length; i++) {
          if (Math.abs(REC.presets[i] - targetFrac) > 0.001) fracs.push(REC.presets[i]);
        }
        fracs.push(targetFrac);
        fracs.sort(function (a, b) { return a - b; });
        var rows = '';
        for (var j = 0; j < fracs.length; j++) rows += rowHtml(fracs[j], floor, Math.abs(fracs[j] - targetFrac) < 1e-9);
        elRows.innerHTML = rows;

        // Recommended top-up = larger of what the target asks and the floor needs.
        var targetTopUp = topUpFor(targetFrac);
        var floorTopUp = floor > 0 ? Math.max(0, Math.round(floor - REC.afterProposed)) : 0;
        var recTopUp = Math.max(targetTopUp, floorTopUp);
        var availAfter = REC.afterProposed + recTopUp;
        var body;
        if (recTopUp > 0) {
          body = 'Top up ≈ <b>' + fShares(recTopUp) + '</b> options → '
            + fShares(REC.poolAuthorized + recTopUp) + ' (' + fPct(pctAfter(recTopUp)) + ' of FDS), leaving '
            + fShares(availAfter) + ' available'
            + (floor > 0 ? ' — clears the ' + fShares(floor) + ' floor.' : ' to reach the ' + fPct(targetFrac) + ' target.');
        } else {
          body = 'No top-up needed — the pool is <b>' + fPct(pctAfter(0)) + '</b> of FDS, '
            + fShares(REC.afterProposed) + ' available after proposed grants'
            + (floor > 0 ? ', clearing the ' + fShares(floor) + ' floor.' : ', at or above the ' + fPct(targetFrac) + ' target.');
        }
        elNote.className = 'pnote ' + (availAfter >= 0 ? 'ok' : 'warn');
        elNote.innerHTML = body;
        try { localStorage.setItem(KEY, JSON.stringify({ target: parseFloat(elT.value) || 0, floor: floor })); } catch (e) {}
      }
      elT.addEventListener('input', recompute);
      if (elF) elF.addEventListener('input', recompute);
      recompute();
    })();
  </script>
</body>
</html>`

  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  setHeader(event, 'Content-Disposition', `inline; filename="${company.slug || 'company'}-board-slide-${today.toISOString().slice(0, 10)}.html"`)
  return html
})
