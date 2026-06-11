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

    -- Operator-defined vesting schedules (Option Grants settings). Each is a
    -- named template the engine can apply: total vesting months + cliff +
    -- cadence. Grants reference one via grants.vesting_schedule_id and snapshot
    -- its month values into vest_months/cliff_months when assigned.
    CREATE TABLE IF NOT EXISTS vesting_schedules (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      vest_months INTEGER NOT NULL DEFAULT 48,
      cliff_months INTEGER NOT NULL DEFAULT 12,
      cadence TEXT NOT NULL DEFAULT 'monthly',   -- 'monthly' | 'quarterly' | 'annual'
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vesting_schedules_company ON vesting_schedules(company_id);

    -- Per-company Option Grants settings. Currently holds the import
    -- header-mapping overrides as a JSON object keyed by canonical grant
    -- field → expected spreadsheet header text.
    CREATE TABLE IF NOT EXISTS grant_settings (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      import_mappings TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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

    -- Per-investor cash contributions to a round. Lets the operator model
    -- "VCT leads $5M, T45 follows $3M" before the round closes — the
    -- spreadsheet does this by giving each investor its own shareholder row
    -- ("Series B (VCT Investments)") with $ amounts spread across round
    -- columns. We keep stakeholders canonical and put the per-round amount
    -- in this side table. The sum of amounts on a round is the source of
    -- truth for new_money; per-investor share counts derive from amount /
    -- share_price (with the round's terms applied).
    CREATE TABLE IF NOT EXISTS round_investors (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      stakeholder_id TEXT NOT NULL REFERENCES stakeholders(id) ON DELETE CASCADE,
      amount REAL NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(round_id, stakeholder_id)
    );
    CREATE INDEX IF NOT EXISTS idx_round_investors_company ON round_investors(company_id);
    CREATE INDEX IF NOT EXISTS idx_round_investors_round ON round_investors(round_id);

    -- Cap-table FDS/PPS milestones — a dated timeline (one row per historical
    -- round) used as the hire-basis for Grant Fairness "% / $ at hire". Kept
    -- separate from the rounds model so it can't perturb dilution math.
    CREATE TABLE IF NOT EXISTS cap_table_milestones (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      as_of_date TEXT NOT NULL,           -- ISO yyyy-mm-dd
      label TEXT,                         -- e.g. "Series A"
      fds REAL,                           -- fully-diluted shares as of this date
      pps REAL,                           -- price per share as of this date
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_milestones_company ON cap_table_milestones(company_id, as_of_date);

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

    -- Parsed-but-unconfirmed setup data from the most recent import. The setup
    -- wizard reads this to suggest formation + funding rounds; on finish it
    -- writes the confirmed rounds to the rounds table. Kept separate so the
    -- rounds table only ever holds operator-confirmed rounds.
    CREATE TABLE IF NOT EXISTS setup_candidates (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      candidates_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- "Previous Round" aggregate. One row per company; holds typed
    -- summary numbers covering everything before the open round.
    -- Replaces the per-round Formation+closed rows on the simplified
    -- Rounds page. The open round still lives in rounds.
    CREATE TABLE IF NOT EXISTS aggregate_round (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      pre_money REAL,
      new_money REAL,
      share_price REAL,
      cumulated_financing REAL,
      total_shares_fds REAL,
      option_pool_total REAL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Archive of per-round rows from before the Rounds page
    -- collapsed to Previous-aggregate + Open Round. Same shape as
    -- rounds; populated by a one-time migration below so the typed
    -- data isn't lost.
    CREATE TABLE IF NOT EXISTS rounds_archive (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT,
      kind TEXT NOT NULL,
      close_date TEXT,
      share_class_code TEXT,
      share_price REAL,
      new_money REAL NOT NULL DEFAULT 0,
      debt_canceled REAL NOT NULL DEFAULT 0,
      seniority INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      option_pool_issued REAL,
      parent_round_code TEXT,
      pre_money REAL,
      preferred_issued REAL,
      common REAL,
      preferred_issued_override REAL,
      notes_converted_override REAL,
      total_shares_fds_override REAL,
      liq_pref_multiple REAL,
      participation TEXT,
      participation_cap REAL,
      pref_tier INTEGER,
      archived_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
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
  // Per-note attribution of the note's PRINCIPAL to the "Notes financing" row:
  // NULL = auto (the round-era it was issued in), a round code = that stage,
  // 'EQUITY' = fold into the round's equity raise (principal drops out of the
  // notes line; the note still converts to shares normally).
  ensureColumn('convertibles', 'financing_stage_code', 'TEXT')
  ensureColumn('companies', 'starting_round', 'TEXT')
  ensureColumn('companies', 'starting_round_date', 'TEXT')
  // Stakeholder linking: an alias row's linked_to points at the
  // canonical "primary" stakeholder. Same company. NULL = standalone.
  // The Shareholders page lets the operator merge duplicates that
  // Carta sometimes splits ("Ingenuity Medical LLC" vs. "Marwan
  // Berrada"); aggregations roll the alias's shares up under the
  // primary's row.
  ensureColumn('stakeholders', 'linked_to', 'TEXT')
  // Employee comp metadata, used by the Grant Fairness module. Operator-typed
  // on the Fairness page; not imported from Carta. job_level is free-form
  // (e.g. "L3", "Senior", "VP") and groups employees for range comparison.
  ensureColumn('stakeholders', 'title', 'TEXT')
  ensureColumn('stakeholders', 'job_level', 'TEXT')
  // Grant Fairness "include" toggle. NULL = use the default (included); 0/1
  // once the operator ticks. Scoped to the Fairness analysis only.
  ensureColumn('stakeholders', 'fairness_include', 'INTEGER')
  // Comp inputs for Grant Fairness calibration / new-hire sizing. Operator-
  // entered on the Fairness roster. salary = base cash; salary_midpoint = the
  // role's benchmark midpoint (compa-ratio = salary / midpoint).
  ensureColumn('stakeholders', 'salary', 'REAL')
  ensureColumn('stakeholders', 'salary_midpoint', 'REAL')
  // Thelander survey role this person maps to, for the market-equity overlay.
  ensureColumn('stakeholders', 'benchmark_role', 'TEXT')
  // Employment start date — the hire-basis for grants that have no date of
  // their own (proposed/idea), so an early hire's "% at hire" reflects the
  // (smaller) FDS back when they joined.
  ensureColumn('stakeholders', 'start_date', 'TEXT')
  // Option-pool increase (shares) at a cap-table milestone — lets pool top-ups
  // carry the round's close date into the Option Pool Impact timeline.
  ensureColumn('cap_table_milestones', 'option_pool', 'REAL')
  // Pool ideas (future-grant events) can carry a job title + level so the
  // Grant Fairness recommendation slots them into the right level section.
  ensureColumn('pool_events', 'job_title', 'TEXT')
  ensureColumn('pool_events', 'job_level', 'TEXT')
  // Stamped on the first successful Carta import. The import UI uses it
  // to decide between "Welcome" and "Re-import" framing; nothing else
  // gates on it now that the setup wizard is gone.
  ensureColumn('companies', 'setup_completed_at', 'TEXT')
  ensureColumn('grants', 'approval_status', 'TEXT')
  // Per-grant details the Carta "Stock Option and Incentive Plan" sheet
  // carries. quantity_issued is the original grant size; quantity_exercised /
  // quantity_forfeited summed = (issued − outstanding). acceleration captures
  // the change-of-control trigger (single / double / null).
  ensureColumn('grants', 'quantity_issued', 'INTEGER')
  ensureColumn('grants', 'quantity_exercised', 'INTEGER')
  ensureColumn('grants', 'quantity_forfeited', 'INTEGER')
  // Carta tracks Expired separately from Forfeited (vested-but-not-exercised
  // vs. unvested-at-termination). Both return shares to the pool, but the
  // operator wants to see them broken out for audit.
  ensureColumn('grants', 'quantity_expired', 'INTEGER')
  ensureColumn('grants', 'award_type', 'TEXT')
  // Grade/title on a grant itself — lets a PROPOSED grant for a future hire
  // (no stakeholder row yet) carry a level for Grant Fairness, same as ideas.
  ensureColumn('grants', 'job_title', 'TEXT')
  ensureColumn('grants', 'job_level', 'TEXT')
  ensureColumn('grants', 'acceleration', 'TEXT')
  // Per-event dates on the grant row. Carta's plan sheet aggregates
  // exercises/forfeits/expirations into per-grant counts but also
  // records a single date for each (the last exercise, the termination
  // date, etc.). We anchor pool-impact events on these dates: when a
  // grant has quantity_exercised > 0 + last_exercised_date set, the
  // Option Pool Impact timeline gets a dated "exercise" event.
  ensureColumn('grants', 'last_exercised_date', 'TEXT')
  ensureColumn('grants', 'forfeited_date', 'TEXT')
  ensureColumn('grants', 'expired_date', 'TEXT')
  // Reference to an operator-defined vesting schedule (vesting_schedules.id).
  // When set, the grant's vest_months/cliff_months are snapshotted from it.
  ensureColumn('grants', 'vesting_schedule_id', 'TEXT')
  // Ideas import header-mapping overrides (JSON), stored alongside the grants
  // import mappings on the same per-company settings row.
  ensureColumn('grant_settings', 'idea_import_mappings', 'TEXT')
  ensureColumn('rounds', 'option_pool_issued', 'REAL NOT NULL DEFAULT 0')
  ensureColumn('rounds', 'parent_round_code', 'TEXT')
  ensureColumn('rounds', 'pre_money', 'REAL')
  ensureColumn('rounds', 'preferred_issued', 'REAL NOT NULL DEFAULT 0')
  ensureColumn('rounds', 'common', 'REAL NOT NULL DEFAULT 0')
  // Optional override for Preferred issued — NULL means "use the formula
  // new_money / share_price". A numeric value (including 0) overrides for
  // rounds where the math doesn't apply, e.g. debt-only or bridge rounds.
  ensureColumn('rounds', 'preferred_issued_override', 'REAL')
  // Formation-snapshot overrides for the shares-side derived columns.
  // Formation is a snapshot, not a transaction — the operator may know
  // the starting Total FDS and any pre-existing converted-note shares
  // directly. NULL = derive normally (sum the breakdown / sum CN
  // attributions); a numeric value short-circuits the derivation.
  ensureColumn('rounds', 'notes_converted_override', 'REAL')
  ensureColumn('rounds', 'total_shares_fds_override', 'REAL')
  // Liquidation preference terms. Default to 0x — i.e. no preference,
  // tranche participates pro-rata only — so that the default exit math
  // matches the user's existing spreadsheet practice (pure pro-rata).
  // When the operator dials a round up to 1x non-participating (or
  // anything else), the waterfall engine kicks in and respects the terms.
  ensureColumn('rounds', 'liq_pref_multiple', 'REAL NOT NULL DEFAULT 0')
  ensureColumn('rounds', 'participation', "TEXT NOT NULL DEFAULT 'none'")  // 'none' | 'full' | 'capped'
  ensureColumn('rounds', 'participation_cap', 'REAL')                       // multiple, e.g. 3.0 = 3x invested cap
  ensureColumn('rounds', 'pref_tier', 'INTEGER NOT NULL DEFAULT 0')         // higher tier = paid first; pari passu within tier

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

  // Grandfather established workspaces: any company that already has rounds
  // shouldn't see "Welcome — let's load your option grants" on the import
  // page. Stamp setup_completed_at so they get the re-import framing.
  // Idempotent — only touches NULL rows.
  d.exec(`
    UPDATE companies SET setup_completed_at = datetime('now')
    WHERE setup_completed_at IS NULL
      AND id IN (SELECT DISTINCT company_id FROM rounds)
  `)

  // One-time: when the Rounds page collapsed to Previous-aggregate +
  // Open Round, all per-round rows from the old design got moved to
  // rounds_archive. Only fires when there's anything in rounds AND
  // archive is empty (the signal that this code's running for the first
  // time against a pre-redesign DB). Idempotent — once archived, never
  // re-runs.
  const liveRoundsCount = (d.prepare('SELECT COUNT(*) AS n FROM rounds').get() as { n: number }).n
  const archivedRoundsCount = (d.prepare('SELECT COUNT(*) AS n FROM rounds_archive').get() as { n: number }).n
  if (liveRoundsCount > 0 && archivedRoundsCount === 0) {
    d.exec(`
      INSERT INTO rounds_archive (
        id, company_id, code, name, kind, close_date, share_class_code,
        share_price, new_money, debt_canceled, seniority, notes,
        option_pool_issued, parent_round_code, pre_money,
        preferred_issued, common, preferred_issued_override,
        notes_converted_override, total_shares_fds_override,
        liq_pref_multiple, participation, participation_cap, pref_tier
      )
      SELECT
        id, company_id, code, name, kind, close_date, share_class_code,
        share_price, new_money, debt_canceled, seniority, notes,
        option_pool_issued, parent_round_code, pre_money,
        preferred_issued, common, preferred_issued_override,
        notes_converted_override, total_shares_fds_override,
        liq_pref_multiple, participation, participation_cap, pref_tier
      FROM rounds
    `)
    d.exec('DELETE FROM rounds')
  }
}

export function reset(): void {
  if (!_db) return
  _db.close()
  _db = null
}
