import { db } from '~~/server/utils/db'
import { buildFairness, type FairnessRound, type RawEmployee } from '~~/server/utils/fairness'

// Employee Grant Fairness data for a company. Per-round fully-diluted shares
// are reused from the round-summary endpoint (single source of truth for the
// cumulative FDS walk); per-employee outstanding options + comp metadata come
// straight from the DB. The heavy lifting is in buildFairness (pure/tested).
//
// Query: ?round=<code> selects which round drives the current pre/post columns
// (defaults to the open round, else the latest).

function isEmployee(type: string | null | undefined): boolean {
  const t = (type || '').toLowerCase()
  if (!t.includes('employee')) return false
  return !t.includes('ex-') && !t.includes('ex ') && !t.includes('former')
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const company = db().prepare('SELECT id, name, slug FROM companies WHERE id = ?').get(id) as any
  if (!company) throw createError({ statusCode: 404, message: 'Company not found' })

  // Per-round cumulative FDS + share price, in chronological order (open last).
  const summary = await $fetch<{ rounds: any[] }>(`/api/companies/${id}/round-summary`)
  const rcols = summary?.rounds ?? []
  const rounds: FairnessRound[] = rcols.map((rc, i) => ({
    code: rc.code,
    name: rc.name || rc.code,
    kind: rc.kind,
    closeDate: rc.close_date ?? null,
    sharePrice: Number(rc.share_price) || 0,
    // pre-money FDS for round X = cumulative FDS through round X-1
    preFDS: i > 0 ? (Number(rcols[i - 1].total_shares_fds) || 0) : (Number(rc.total_shares_fds) || 0),
    postFDS: Number(rc.total_shares_fds) || 0,
  }))

  // Outstanding option grants joined to their stakeholder (for title/level).
  const rows = db().prepare(`
    SELECT g.stakeholder_id, g.recipient_name, g.recipient_type,
           g.issue_date, g.vesting_start, g.quantity,
           g.quantity_issued, g.quantity_exercised, g.quantity_forfeited, g.quantity_expired,
           s.name AS s_name, s.title AS s_title, s.job_level AS s_level
    FROM grants g
    LEFT JOIN stakeholders s ON s.id = g.stakeholder_id
    WHERE g.company_id = ? AND g.status = 'outstanding'
  `).all(id) as any[]

  // Aggregate per employee (by stakeholder when linked, else by name).
  const map = new Map<string, RawEmployee>()
  for (const row of rows) {
    if (!isEmployee(row.recipient_type)) continue
    const issued = row.quantity_issued ?? row.quantity ?? 0
    const out = issued - (row.quantity_exercised || 0) - (row.quantity_forfeited || 0) - (row.quantity_expired || 0)
    if (out <= 0) continue
    const key = row.stakeholder_id || `name:${row.recipient_name}`
    const date: string | null = row.issue_date || row.vesting_start || null
    const cur = map.get(key)
    if (cur) {
      cur.shares += out
      if (date && (!cur.firstGrantDate || date < cur.firstGrantDate)) cur.firstGrantDate = date
    } else {
      map.set(key, {
        stakeholderId: row.stakeholder_id || null,
        name: row.s_name || row.recipient_name || '(unknown)',
        title: row.s_title || null,
        level: row.s_level || null,
        shares: out,
        firstGrantDate: date,
      })
    }
  }

  const selectedRound = (getQuery(event).round as string) || null
  const result = buildFairness(rounds, [...map.values()], selectedRound)
  return { company: { id: company.id, name: company.name, slug: company.slug }, ...result }
})
