import { db } from '~~/server/utils/db'
import { buildFairness, type FairnessRound, type RawHolder } from '~~/server/utils/fairness'

// Employee Grant Fairness data. Per-round FDS is reused from the
// round-summary endpoint (single source of truth for the cumulative walk);
// per-optionholder options/holdings/proposed + comp metadata come from the DB.
// The math lives in buildFairness (pure/tested).
//
// Query:
//   ?round=<code>       selects the round driving the current pre/post columns
//   ?includeFuture=1    rolls proposed grants + pool ideas into the basis
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const company = db().prepare('SELECT id, name, slug FROM companies WHERE id = ?').get(id) as any
  if (!company) throw createError({ statusCode: 404, message: 'Company not found' })

  const q = getQuery(event)
  const includeFuture = q.includeFuture === '1' || q.includeFuture === 'true'
  const selectedRound = (q.round as string) || null

  // Per-round cumulative FDS + share price, chronological (open last).
  const summary = await $fetch<{ rounds: any[] }>(`/api/companies/${id}/round-summary`)
  const rcols = summary?.rounds ?? []
  const rounds: FairnessRound[] = rcols.map((rc, i) => ({
    code: rc.code,
    name: rc.name || rc.code,
    kind: rc.kind,
    closeDate: rc.close_date ?? null,
    sharePrice: Number(rc.share_price) || 0,
    preFDS: i > 0 ? (Number(rcols[i - 1].total_shares_fds) || 0) : (Number(rc.total_shares_fds) || 0),
    postFDS: Number(rc.total_shares_fds) || 0,
  }))

  // Stakeholder comp metadata (title / level / include).
  const sMeta = new Map<string, { name: string; title: string | null; level: string | null; include: boolean }>()
  for (const s of db().prepare(`SELECT id, name, title, job_level, fairness_include FROM stakeholders WHERE company_id = ?`).all(id) as any[]) {
    sMeta.set(s.id, {
      name: s.name,
      title: s.title || null,
      level: s.job_level || null,
      include: s.fairness_include == null ? true : !!s.fairness_include,
    })
  }

  // Held shares (common / preferred / warrants) per stakeholder.
  const heldBy = new Map<string, number>()
  for (const h of db().prepare(`SELECT stakeholder_id, shares FROM holdings WHERE company_id = ?`).all(id) as any[]) {
    if (!h.stakeholder_id) continue
    heldBy.set(h.stakeholder_id, (heldBy.get(h.stakeholder_id) || 0) + (h.shares || 0))
  }

  // Aggregate outstanding option grants per optionholder.
  type Agg = { stakeholderId: string | null; recipientName: string; awardTypes: Set<string>; optionShares: number; firstGrantDate: string | null }
  const map = new Map<string, Agg>()
  const keyOf = (sid: string | null, name: string) => sid || `name:${name}`
  for (const row of db().prepare(`
    SELECT stakeholder_id, recipient_name, award_type, issue_date, vesting_start,
           quantity, quantity_issued, quantity_exercised, quantity_forfeited, quantity_expired
    FROM grants WHERE company_id = ? AND status = 'outstanding'
  `).all(id) as any[]) {
    const issued = row.quantity_issued ?? row.quantity ?? 0
    const out = issued - (row.quantity_exercised || 0) - (row.quantity_forfeited || 0) - (row.quantity_expired || 0)
    if (out <= 0) continue
    const key = keyOf(row.stakeholder_id, row.recipient_name)
    const date: string | null = row.issue_date || row.vesting_start || null
    let a = map.get(key)
    if (!a) {
      a = { stakeholderId: row.stakeholder_id || null, recipientName: row.recipient_name || '(unknown)', awardTypes: new Set(), optionShares: 0, firstGrantDate: null }
      map.set(key, a)
    }
    a.optionShares += out
    if (row.award_type) a.awardTypes.add(String(row.award_type).toUpperCase())
    if (date && (!a.firstGrantDate || date < a.firstGrantDate)) a.firstGrantDate = date
  }

  // Proposed grants per optionholder (for the include-future basis). Track
  // the recipient + award type too, so proposed-only people (not already
  // holding an outstanding grant) can be surfaced as their own rows.
  const proposedBy = new Map<string, number>()
  const proposedDetail = new Map<string, { stakeholderId: string | null; name: string; kinds: Set<string> }>()
  for (const row of db().prepare(`SELECT stakeholder_id, recipient_name, award_type, quantity FROM grants WHERE company_id = ? AND status = 'proposed'`).all(id) as any[]) {
    const key = keyOf(row.stakeholder_id, row.recipient_name)
    proposedBy.set(key, (proposedBy.get(key) || 0) + (row.quantity || 0))
    let d = proposedDetail.get(key)
    if (!d) { d = { stakeholderId: row.stakeholder_id || null, name: row.recipient_name || 'Proposed grant', kinds: new Set() }; proposedDetail.set(key, d) }
    if (row.award_type) d.kinds.add(String(row.award_type).toUpperCase())
  }

  // Pool ideas (anonymous future grants/reserves) — kept individually so each
  // is its own row, plus an aggregate for the methodology note.
  let ideasShares = 0
  const ideaList: Array<{ name: string; shares: number; kind: string | null }> = []
  try {
    const ideas = await $fetch<any[]>(`/api/companies/${id}/pool-events`)
    for (const ie of (ideas || [])) {
      if (ie.type === 'grant' || ie.type === 'reserve') {
        ideasShares += ie.shares || 0
        ideaList.push({ name: ie.name || 'Idea', shares: ie.shares || 0, kind: ie.kind || null })
      }
    }
  } catch { /* pool-events optional */ }

  const holders: RawHolder[] = [...map.entries()].map(([key, a]) => {
    const meta = a.stakeholderId ? sMeta.get(a.stakeholderId) : null
    return {
      stakeholderId: a.stakeholderId,
      name: meta?.name || a.recipientName,
      title: meta?.title ?? null,
      level: meta?.level ?? null,
      include: meta ? meta.include : true,
      awardTypes: [...a.awardTypes].sort(),
      optionShares: a.optionShares,
      heldShares: a.stakeholderId ? (heldBy.get(a.stakeholderId) || 0) : 0,
      proposedShares: proposedBy.get(key) || 0,
      firstGrantDate: a.firstGrantDate,
      source: 'grant' as const,
    }
  })

  // With the toggle on, surface not-yet-issued equity as its own rows so the
  // roster/holdings reflect the full picture: proposed grants for people who
  // don't already hold options, and each anonymous pool idea.
  if (includeFuture) {
    for (const [key, d] of proposedDetail) {
      if (map.has(key)) continue // already an outstanding holder (augmented)
      const meta = d.stakeholderId ? sMeta.get(d.stakeholderId) : null
      holders.push({
        stakeholderId: d.stakeholderId,
        name: meta?.name || d.name,
        title: meta?.title ?? null,
        level: meta?.level ?? null,
        include: meta ? meta.include : true,
        awardTypes: [...d.kinds].sort(),
        optionShares: 0,
        heldShares: d.stakeholderId ? (heldBy.get(d.stakeholderId) || 0) : 0,
        proposedShares: proposedBy.get(key) || 0,
        firstGrantDate: null,
        source: 'proposed',
      })
    }
    for (const idea of ideaList) {
      holders.push({
        stakeholderId: null,
        name: idea.name,
        title: null,
        level: null,
        include: true,
        awardTypes: idea.kind ? [String(idea.kind).toUpperCase()] : [],
        optionShares: 0,
        heldShares: 0,
        proposedShares: idea.shares,
        firstGrantDate: null,
        source: 'idea',
      })
    }
  }

  const result = buildFairness(rounds, holders, { selectedRoundCode: selectedRound, includeFuture, ideasShares })
  return { company: { id: company.id, name: company.name, slug: company.slug }, ...result }
})
