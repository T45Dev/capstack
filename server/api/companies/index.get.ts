import { db } from '~~/server/utils/db'

export default defineEventHandler(() => {
  return db().prepare(`
    SELECT
      c.id, c.name, c.slug, c.ticker, c.formation_date,
      c.starting_round, c.starting_round_date, c.created_at,
      (SELECT COUNT(*) FROM stakeholders s WHERE s.company_id = c.id) AS stakeholder_count,
      (SELECT COUNT(*) FROM grants g WHERE g.company_id = c.id AND g.status = 'outstanding') AS grant_count,
      (SELECT COALESCE(SUM(h.shares), 0) FROM holdings h WHERE h.company_id = c.id) AS total_issued
    FROM companies c
    ORDER BY c.created_at DESC
  `).all()
})
