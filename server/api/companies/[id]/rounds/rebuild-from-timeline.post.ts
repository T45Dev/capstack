import { db } from '~~/server/utils/db'
import { newId } from '~~/server/utils/ids'

// Stage 1 of the single-source rounds model: rebuild the `rounds` table from
// the operator's Round history timeline (cap_table_milestones), retiring the
// Carta-seeded share-class rounds.
//
// For each timeline row we create one round and PIN its cumulative FDS to the
// row's trusted `fds` via total_shares_fds_override (round-summary honours the
// override for any round kind), so Pre/Post denominators come out at the
// numbers the operator entered. Convertible notes are re-pointed to the round
// whose close date covers their conversion date (best-effort) so they keep
// converting. The open round (kind='open'), if any, is left untouched.
//
// Reversible: leaves the importer's seeding in place, so a Carta re-import
// restores the share-class rounds.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'id required' })

  const co = db().prepare('SELECT id FROM companies WHERE id = ?').get(id)
  if (!co) throw createError({ statusCode: 404, message: 'Company not found' })

  const milestones = db().prepare(
    `SELECT as_of_date, label, fds, pps, option_pool
       FROM cap_table_milestones
      WHERE company_id = ?
      ORDER BY as_of_date ASC, created_at ASC`,
  ).all(id) as Array<{ as_of_date: string | null; label: string | null; fds: number | null; pps: number | null; option_pool: number | null }>

  if (!milestones.length) {
    throw createError({ statusCode: 400, message: 'No Round history timeline to migrate from. Add rows to the Round history first.' })
  }

  const run = db().transaction(() => {
    // Retire the seeded (non-open) rounds. The open round survives.
    db().prepare(`DELETE FROM rounds WHERE company_id = ? AND kind != 'open'`).run(id)

    // Codes already in use (e.g. the surviving open round) so we don't collide.
    const used = new Set(
      (db().prepare('SELECT code FROM rounds WHERE company_id = ?').all(id) as Array<{ code: string }>).map(r => r.code),
    )
    const nextCode = (i: number) => {
      let n = i + 1
      while (used.has(`R${n}`)) n++
      used.add(`R${n}`)
      return `R${n}`
    }

    const ins = db().prepare(`
      INSERT INTO rounds (
        id, company_id, code, name, kind, close_date, share_class_code,
        share_price, new_money, debt_canceled, option_pool_issued, pre_money,
        preferred_issued, common, seniority, total_shares_fds_override
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, 0, ?, NULL, 0, 0, ?, ?)
    `)
    // New rounds, chronological. First row = formation, rest = closed history.
    const created: Array<{ code: string; close_date: string | null }> = []
    milestones.forEach((m, i) => {
      const code = nextCode(i)
      ins.run(
        newId('rd'), id, code,
        m.label || code,
        i === 0 ? 'formation' : 'closed',
        m.as_of_date,
        m.pps ?? null,
        Math.floor(Number(m.option_pool) || 0),
        i,
        m.fds != null ? Math.floor(Number(m.fds)) : null,
      )
      created.push({ code, close_date: m.as_of_date })
    })

    // Re-point convertible notes to the round whose close date is the latest
    // on/before the note's conversion (or issue) date. Notes that predate every
    // round attach to the first round. Best-effort: the operator should still
    // review CN attribution afterward.
    const datedRounds = created.filter(r => r.close_date).sort((a, b) => a.close_date!.localeCompare(b.close_date!))
    const cns = db().prepare(
      `SELECT id, conversion_date, issue_date FROM convertibles WHERE company_id = ? AND status = 'outstanding'`,
    ).all(id) as Array<{ id: string; conversion_date: string | null; issue_date: string | null }>
    const upd = db().prepare('UPDATE convertibles SET destination_class_code = ? WHERE id = ?')
    let repointed = 0
    for (const cn of cns) {
      const basis = (cn.conversion_date || cn.issue_date || '').slice(0, 10)
      let target = datedRounds[0] || created[0]
      if (basis) {
        for (const r of datedRounds) {
          if (r.close_date! <= basis) target = r
          else break
        }
      }
      if (target) { upd.run(target.code, cn.id); repointed++ }
    }

    return { rounds_created: created.length, cn_repointed: repointed }
  })

  const result = run()
  return { ...result, codes: undefined, ok: true }
})
