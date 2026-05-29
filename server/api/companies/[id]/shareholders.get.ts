import { db } from '~~/server/utils/db'

// Shareholders page payload: every stakeholder rolled up with their
// preferred / common / options share counts, with linked aliases nested
// under their primary. The Shareholders page renders one row per
// primary (aliases collapsed by default); the UI can expand to show
// individual alias breakdowns from the per-stakeholder self counts.
//
// Linking semantics: stakeholders.linked_to → another stakeholder's id
// (same company). NULL = standalone primary. Aliases never appear at
// the top level of the response — they're tucked into their primary's
// aliases array along with their own self counts so callers can
// attribute the deltas correctly.

interface StakeholderRaw {
  id: string
  name: string
  type: string | null
  linked_to: string | null
  preferred_self: number
  common_self: number
  options_self: number
}

interface AliasOut {
  id: string
  name: string
  type: string | null
  preferred_shares: number
  common_shares: number
  options_outstanding: number
  total_shares: number
}

interface PrimaryOut {
  id: string
  name: string
  type: string | null
  // Aggregated (this stakeholder + all linked aliases).
  preferred_shares: number
  common_shares: number
  options_outstanding: number
  total_shares: number
  // Just this stakeholder's own counts — useful for expansion views.
  self: {
    preferred_shares: number
    common_shares: number
    options_outstanding: number
  }
  aliases: AliasOut[]
}

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const rows = db().prepare(`
    SELECT
      s.id, s.name, s.type, s.linked_to,
      COALESCE(SUM(CASE WHEN sc.kind = 'preferred' THEN h.shares ELSE 0 END), 0) AS preferred_self,
      COALESCE(SUM(CASE WHEN sc.kind = 'common'    THEN h.shares ELSE 0 END), 0) AS common_self,
      COALESCE((
        SELECT SUM(g.quantity) FROM grants g
        WHERE g.stakeholder_id = s.id AND g.status = 'outstanding'
      ), 0) AS options_self
    FROM stakeholders s
    LEFT JOIN holdings h     ON h.stakeholder_id = s.id
    LEFT JOIN share_classes sc ON sc.id = h.share_class_id
    WHERE s.company_id = ?
    GROUP BY s.id, s.name, s.type, s.linked_to
  `).all(id) as StakeholderRaw[]

  const byId = new Map<string, StakeholderRaw>()
  for (const r of rows) byId.set(r.id, r)

  // Resolve the primary for a row by walking linked_to up to NULL.
  // Capped at 5 hops to be safe against cycles / orphans.
  function primaryIdFor(r: StakeholderRaw): string {
    let cur = r
    let depth = 0
    while (cur.linked_to && depth < 5) {
      const next = byId.get(cur.linked_to)
      if (!next) break
      cur = next
      depth++
    }
    return cur.id
  }

  // Bucket aliases by their resolved primary.
  const aliasesByPrimary = new Map<string, StakeholderRaw[]>()
  for (const r of rows) {
    if (!r.linked_to) continue
    const pid = primaryIdFor(r)
    if (pid === r.id) continue  // dangling self-link safeguard
    const list = aliasesByPrimary.get(pid) || []
    list.push(r)
    aliasesByPrimary.set(pid, list)
  }

  // Build the response: primaries only at the top, aliases nested.
  const primaries: PrimaryOut[] = []
  for (const r of rows) {
    if (r.linked_to) continue
    const aliasRaw = aliasesByPrimary.get(r.id) || []
    const aliases: AliasOut[] = aliasRaw.map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      preferred_shares:     a.preferred_self,
      common_shares:        a.common_self,
      options_outstanding:  a.options_self,
      total_shares:         a.preferred_self + a.common_self + a.options_self,
    }))
    const aggPref = r.preferred_self + aliases.reduce((s, a) => s + a.preferred_shares, 0)
    const aggCom  = r.common_self    + aliases.reduce((s, a) => s + a.common_shares, 0)
    const aggOpt  = r.options_self   + aliases.reduce((s, a) => s + a.options_outstanding, 0)
    primaries.push({
      id: r.id,
      name: r.name,
      type: r.type,
      preferred_shares:    aggPref,
      common_shares:       aggCom,
      options_outstanding: aggOpt,
      total_shares:        aggPref + aggCom + aggOpt,
      self: {
        preferred_shares:    r.preferred_self,
        common_shares:       r.common_self,
        options_outstanding: r.options_self,
      },
      aliases,
    })
  }

  // Stable sort: biggest holders first, ties broken by name.
  primaries.sort((a, b) => {
    if (b.total_shares !== a.total_shares) return b.total_shares - a.total_shares
    return a.name.localeCompare(b.name)
  })

  return { stakeholders: primaries }
})
