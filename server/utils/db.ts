import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

let _db: Database.Database | null = null

const DB_PATH = process.env.CAPSTACK_DB || resolve(process.cwd(), 'data/capstack.db')

export function db(): Database.Database {
  if (_db) return _db
  if (!existsSync(dirname(DB_PATH))) mkdirSync(dirname(DB_PATH), { recursive: true })
  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  migrate(_db)
  return _db
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      ticker TEXT,
      formation_date TEXT,
      starting_round TEXT,
      starting_round_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS share_classes (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      seniority INTEGER NOT NULL DEFAULT 0,
      authorized INTEGER,
      issue_price REAL,
      UNIQUE(company_id, code)
    );

    CREATE TABLE IF NOT EXISTS stakeholders (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT,
      type TEXT,
      external_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_stakeholders_company ON stakeholders(company_id);

    CREATE TABLE IF NOT EXISTS holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL,
      stakeholder_id TEXT NOT NULL REFERENCES stakeholders(id) ON DELETE CASCADE,
      share_class_id TEXT NOT NULL REFERENCES share_classes(id) ON DELETE CASCADE,
      shares INTEGER NOT NULL DEFAULT 0,
      UNIQUE(stakeholder_id, share_class_id)
    );
    CREATE INDEX IF NOT EXISTS idx_holdings_company ON holdings(company_id);

    CREATE TABLE IF NOT EXISTS grants (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      stakeholder_id TEXT REFERENCES stakeholders(id) ON DELETE SET NULL,
      recipient_name TEXT NOT NULL,
      recipient_type TEXT,
      round TEXT,
      quantity INTEGER NOT NULL,
      strike REAL,
      issue_date TEXT,
      vesting_start TEXT,
      vest_months INTEGER DEFAULT 48,
      cliff_months INTEGER DEFAULT 12,
      status TEXT NOT NULL DEFAULT 'outstanding',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_grants_company ON grants(company_id);

    CREATE TABLE IF NOT EXISTS option_pools (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      authorized INTEGER NOT NULL DEFAULT 0,
      adopted_date TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS convertibles (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      stakeholder_id TEXT REFERENCES stakeholders(id),
      external_id TEXT,
      stakeholder_name TEXT NOT NULL,
      principal REAL NOT NULL,
      interest_accrued REAL DEFAULT 0,
      interest_rate REAL NOT NULL DEFAULT 0,
      issue_date TEXT,
      maturity_date TEXT,
      valuation_cap REAL,
      conversion_discount REAL DEFAULT 0,
      converts_at_round INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'outstanding'
    );
    CREATE INDEX IF NOT EXISTS idx_convertibles_company ON convertibles(company_id);

    CREATE TABLE IF NOT EXISTS assumptions (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      round_name TEXT NOT NULL DEFAULT 'Series B',
      new_money REAL NOT NULL DEFAULT 0,
      pre_money REAL NOT NULL DEFAULT 0,
      pre_round_fds INTEGER,
      target_pool_pct REAL,
      pool_top_up_shares INTEGER DEFAULT 0,
      cn_conversion_basis TEXT DEFAULT 'best',
      notes TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS assumption_versions (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      label TEXT,
      is_auto INTEGER NOT NULL DEFAULT 0,
      round_name TEXT NOT NULL,
      new_money REAL NOT NULL,
      pre_money REAL NOT NULL,
      pre_round_fds INTEGER,
      target_pool_pct REAL,
      pool_top_up_shares INTEGER DEFAULT 0,
      cn_conversion_basis TEXT DEFAULT 'best',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_assumption_versions_company ON assumption_versions(company_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS scenarios (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      round_name TEXT NOT NULL DEFAULT 'Series B',
      new_money REAL NOT NULL DEFAULT 0,
      pre_money REAL NOT NULL DEFAULT 0,
      pool_top_up_shares INTEGER DEFAULT 0,
      exit_values TEXT,
      grant_overrides TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_scenarios_company ON scenarios(company_id);

    CREATE TABLE IF NOT EXISTS imports (
      id TEXT PRIMARY KEY,
      company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
      filename TEXT,
      source TEXT NOT NULL,
      raw_meta TEXT,
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Future / hypothetical option-pool events for the Option Pool Impact
    -- timeline. Real grants and pool top-ups live in the grants / option_pools
    -- tables and are merged into the timeline at query time. This table holds
    -- only "ideas" -- planned events the user wants to model.
    -- One row per closed funding round on the company's timeline (Formation,
    -- Seed, Series A-1, ..., Series B-2). The Open Round is NOT stored here —
    -- it's synthesized at query time from the assumptions row so the user can
    -- iterate on its inputs without committing them as a round close. Share
    -- counts (preferred_issued / notes_converted / option_pool_issued /
    -- common) are NOT stored — they're derived at query time from holdings,
    -- convertibles, and option_pools.
    CREATE TABLE IF NOT EXISTS rounds (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      code TEXT NOT NULL,                 -- "Formation" | "CS" | "SS" | "SA1" | "PB1" ...
      name TEXT,                          -- display name; e.g. "Series A-1"
      kind TEXT NOT NULL,                 -- 'formation' | 'closed'
      close_date TEXT,                    -- ISO yyyy-mm-dd (max Board Approval Date from the round's ledger)
      share_class_code TEXT,              -- soft link to share_classes.code (preferred class for this round)
      share_price REAL,                   -- Original Issue Price from the round's ledger
      new_money REAL NOT NULL DEFAULT 0,  -- sum of Cash Contributed from the round's ledger
      debt_canceled REAL NOT NULL DEFAULT 0, -- sum of Debt Canceled (informational; CN $ comes from the Convertible Ledger)
      seniority INTEGER NOT NULL DEFAULT 0, -- chronological order (lower = earlier)
      notes TEXT,
      UNIQUE(company_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_rounds_company ON rounds(company_id, seniority);

    CREATE TABLE IF NOT EXISTS pool_events (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      event_date TEXT NOT NULL,           -- ISO yyyy-mm-dd
      type TEXT NOT NULL,                 -- 'grant' | 'pool_topup'
      name TEXT NOT NULL,                 -- e.g. "Future CEO" or "Q3 pool top-up"
      kind TEXT,                          -- 'ISO' | 'NSO' | NULL (for top-ups)
      shares INTEGER NOT NULL,            -- positive; type determines direction
      vest_months INTEGER DEFAULT 48,
      cliff_months INTEGER DEFAULT 12,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pool_events_company ON pool_events(company_id, event_date);
  `)

  // ----- Idempotent column additions for upgrades on existing DBs -----
  const colsOf = (table: string) =>
    (d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name)
  const ensureColumn = (table: string, col: string, decl: string) => {
    if (!colsOf(table).includes(col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`)
  }

  ensureColumn('assumptions', 'pre_round_fds', 'INTEGER')
  ensureColumn('assumptions', 'round_close_date', 'TEXT')
  ensureColumn('convertibles', 'conversion_date', 'TEXT')
  ensureColumn('convertibles', 'destination_class_code', 'TEXT')
  ensureColumn('convertibles', 'converts_at_round', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('convertibles', 'conversion_price', 'REAL')
  ensureColumn('convertibles', 'include_in_summary', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn('companies', 'starting_round', 'TEXT')
  ensureColumn('companies', 'starting_round_date', 'TEXT')
  ensureColumn('grants', 'approval_status', 'TEXT')
  ensureColumn('rounds', 'option_pool_issued', 'REAL NOT NULL DEFAULT 0')
  ensureColumn('rounds', 'parent_round_code', 'TEXT')
  ensureColumn('rounds', 'pre_money', 'REAL')
  ensureColumn('rounds', 'preferred_issued', 'REAL NOT NULL DEFAULT 0')
  ensureColumn('rounds', 'common', 'REAL NOT NULL DEFAULT 0')
  // Optional override for Preferred issued — NULL means "use the formula
  // new_money / share_price". A numeric value (including 0) overrides for
  // rounds where the math doesn't apply, e.g. debt-only or bridge rounds.
  ensureColumn('rounds', 'preferred_issued_override', 'REAL')

  // Backfill: for any company whose Formation round has option_pool_issued = 0
  // but whose option_pools table is non-empty, seed Formation with the
  // imported pool total. New imports run the same path explicitly below; this
  // covers companies imported before the column existed.
  const formationsToBackfill = d.prepare(`
    SELECT r.id,
      (SELECT COALESCE(SUM(authorized), 0) FROM option_pools WHERE company_id = r.company_id) AS pool_total
    FROM rounds r
    WHERE r.kind = 'formation' AND r.option_pool_issued = 0
  `).all() as Array<{ id: string; pool_total: number }>
  if (formationsToBackfill.length) {
    const upd = d.prepare('UPDATE rounds SET option_pool_issued = ? WHERE id = ?')
    const tx = d.transaction((rows: typeof formationsToBackfill) => {
      for (const r of rows) {
        if (r.pool_total > 0) upd.run(r.pool_total, r.id)
      }
    })
    tx(formationsToBackfill)
  }

  // Backfill: classify CN-conversion-only subrounds (cash = 0, debt > 0) and
  // attach them to the nearest preceding cash-driven round as their parent.
  // Idempotent — only touches CN-only rounds where parent_round_code is still
  // NULL.
  const companiesNeedingParentBackfill = d.prepare(`
    SELECT DISTINCT company_id FROM rounds
    WHERE parent_round_code IS NULL AND new_money = 0 AND debt_canceled > 0
  `).all() as Array<{ company_id: string }>
  if (companiesNeedingParentBackfill.length) {
    const fetchRounds = d.prepare(`
      SELECT id, code, new_money, debt_canceled, parent_round_code, seniority
      FROM rounds WHERE company_id = ? ORDER BY seniority ASC
    `)
    const upd = d.prepare('UPDATE rounds SET parent_round_code = ? WHERE id = ?')
    const tx = d.transaction((companies: typeof companiesNeedingParentBackfill) => {
      for (const c of companies) {
        const rs = fetchRounds.all(c.company_id) as Array<{
          id: string; code: string; new_money: number; debt_canceled: number;
          parent_round_code: string | null; seniority: number
        }>
        let lastCashCode: string | null = null
        for (const r of rs) {
          const isCNOnly = (r.new_money || 0) === 0 && (r.debt_canceled || 0) > 0
          if (isCNOnly && lastCashCode && !r.parent_round_code) {
            upd.run(lastCashCode, r.id)
          } else if ((r.new_money || 0) > 0) {
            lastCashCode = r.code
          }
        }
      }
    })
    tx(companiesNeedingParentBackfill)
  }

  // One-shot: strip the "-N" tranche suffix off any historical CN
  // destination_class_code values so they match share_classes.code. Idempotent
  // — once cleaned, the WHERE clause matches zero rows.
  const dirty = d.prepare(
    `SELECT id, destination_class_code AS code FROM convertibles
     WHERE destination_class_code IS NOT NULL
       AND destination_class_code GLOB '*-[0-9]*'`,
  ).all() as Array<{ id: string; code: string }>
  if (dirty.length) {
    const upd = d.prepare('UPDATE convertibles SET destination_class_code = ? WHERE id = ?')
    const tx = d.transaction((rows: typeof dirty) => {
      for (const r of rows) {
        const cleaned = r.code.replace(/-\d+$/, '')
        if (cleaned !== r.code) upd.run(cleaned || null, r.id)
      }
    })
    tx(dirty)
  }
}

export function reset(): void {
  if (!_db) return
  _db.close()
  _db = null
}
