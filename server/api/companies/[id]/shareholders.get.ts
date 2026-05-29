import { db } from '~~/server/utils/db'

// Shareholders page payload: every stakeholder broken out by share-class
// ledger (CS, SS, SA1, ...) + options, with linked aliases nested under
// their primary. The page renders one column per share class so the
// operator can read each ledger's holdings without the preferred/common
// roll-up flattening detail.

interface StakeholderRaw {
  id: string
  name: string
  type: string | null
  linked_to: string | null
  options_self: number
}

interface AliasOut {
  id: string
  name: string
  type: string | null
  holdings: Record<string, number>   // keyed by share_class.code
  options_outstanding: number
  total_shares: number
}

interface PrimaryOut {
  id: string
  name: string
  type: string | null
  // Aggregated (this stakeholder + all linked aliases).
  holdings: Record<string, number>
  options_outstanding: number
  total_shares: number
  // Just this stakeholder's own counts — useful for the expansion view.
  self: { holdings: Record<string, number>; options_outstanding: number }
  aliases: AliasOut[]
}

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  // Share-class columns. Common first, then preferred ordered by
  // seniority + code so the columns line up with the cap-stack
  // chronology (CS → SS → SA1 → SA2 → PB1 ...).
  const shareClasses = db().prepare(`
    SELECT id, code, name, kind, seniority
    FROM share_classes WHERE company_id = ?
    ORDER BY CASE WHEN kind = 'common' THEN 0 ELSE 1 END,
             seniority,
             code
  `).all(id) as Array<{ id: string; code: string; name: string; kind: string; seniority: number }>

  // Per-stakeholder bare metadata + outstanding options. Holdings get
  // pulled separately so we can build a sparse share-class map without
  // joining three tables in one ungainly aggregate.
  const stakeholders = db().prepare(`
    SELECT s.id, s.name, s.type, s.linked_to,
      COALESCE((SELECT SUM(g.quantity) FROM grants g
                WHERE g.stakeholder_id = s.id AND g.status = 'outstanding'), 0) AS options_self
    FROM stakeholders s WHERE s.company_id = ?
  `).all(id) as StakeholderRaw[]

  // Per-stakeholder holdings keyed by share_class code.
  const holdingsRows = db().prepare(`
    SELECT h.stakeholder_id, sc.code, h.shares
    FROM holdings h
    JOIN share_classes sc ON sc.id = h.share_class_id
    WHERE h.company_id = ?
  `).all(id) as Array<{ stakeholder_id: string; code: string; shares: number }>
  const holdingsByStakeholder = new Map<string, Record<string, number>>()
  for (const h of holdingsRows) {
    const m = holdingsByStakeholder.get(h.stakeholder_id) || {}
    m[h.code] = (m[h.code] || 0) + h.shares
    holdingsByStakeholder.set(h.stakeholder_id, m)
  }

  const byId = new Map<string, StakeholderRaw>()
  for (const s of stakeholders) byId.set(s.id, s)
  // Resolve the primary by walking linked_to. Capped at 5 hops.
  function primaryIdFor(r: StakeholderRaw): string {
    let cur = r, depth = 0
    while (cur.linked_to && depth < 5) {
      const next = byId.get(cur.linked_to)
      if (!next) break
      cur = next; depth++
    }
    return cur.id
  }

  const aliasesByPrimary = new Map<string, StakeholderRaw[]>()
  for (const r of stakeholders) {
    if (!r.linked_to) continue
    const pid = primaryIdFor(r)
    if (pid === r.id) continue
    const list = aliasesByPrimary.get(pid) || []
    list.push(r); aliasesByPrimary.set(pid, list)
  }

  function holdingsFor(sid: string): Record<string, number> {
    return holdingsByStakeholder.get(sid) || {}
  }
  function totalShares(holdings: Record<string, number>, options: number): number {
    return Object.values(holdings).reduce((s, v) => s + v, 0) + options
  }

  const primaries: PrimaryOut[] = []
  for (const r of stakeholders) {
    if (r.linked_to) continue
    const selfHoldings = holdingsFor(r.id)
    const aliasRaw = aliasesByPrimary.get(r.id) || []
    const aliases: AliasOut[] = aliasRaw.map(a => {
      const h = holdingsFor(a.id)
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        holdings: h,
        options_outstanding: a.options_self,
        total_shares: totalShares(h, a.options_self),
      }
    })
    // Aggregate self + aliases into the primary's holdings map.
    const aggHoldings: Record<string, number> = { ...selfHoldings }
    for (const a of aliases) {
      for (const [code, n] of Object.entries(a.holdings)) {
        aggHoldings[code] = (aggHoldings[code] || 0) + n
      }
    }
    const aggOptions = r.options_self + aliases.reduce((s, a) => s + a.options_outstanding, 0)
    primaries.push({
      id: r.id,
      name: r.name,
      type: r.type,
      holdings: aggHoldings,
      options_outstanding: aggOptions,
      total_shares: totalShares(aggHoldings, aggOptions),
      self: { holdings: selfHoldings, options_outstanding: r.options_self },
      aliases,
    })
  }

  primaries.sort((a, b) => {
    if (b.total_shares !== a.total_shares) return b.total_shares - a.total_shares
    return a.name.localeCompare(b.name)
  })

  return {
    share_classes: shareClasses.map(sc => ({ code: sc.code, name: sc.name, kind: sc.kind })),
    stakeholders: primaries,
  }
})
