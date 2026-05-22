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
  ensureColumn('companies', 'starting_round', 'TEXT')
  ensureColumn('companies', 'starting_round_date', 'TEXT')
  ensureColumn('grants', 'approval_status', 'TEXT')
}

export function reset(): void {
  if (!_db) return
  _db.close()
  _db = null
}
