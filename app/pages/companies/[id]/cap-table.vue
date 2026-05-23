<script setup lang="ts">
import { Upload, Filter, ChevronUp, ChevronDown } from 'lucide-vue-next'
import { fmtShares, fmtPct, fmtPricePerShare } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

interface ShareClassRow { id: string; code: string; name: string; kind: string; authorized: number | null; issue_price: number | null }
interface Stakeholder { id: string; name: string; type: string | null }
interface Holding { stakeholder_id: string; share_class_id: string; shares: number }
interface Grant { id: string; stakeholder_id: string | null; recipient_name: string; quantity: number; status: string }

const { data } = await useFetch<{ share_classes: ShareClassRow[]; stakeholders: Stakeholder[]; holdings: Holding[]; grants: Grant[]; pools: any[]; current_pps: number }>(() => `/api/companies/${id.value}/cap-table`, { watch: [id], default: () => ({ share_classes: [], stakeholders: [], holdings: [], grants: [], pools: [], current_pps: 0 } as any) })

// Per-round Summary Cap Table — spec §5.1 top card. Each Carta share class
// is a subround; subrounds with the same Series prefix (SA1/SA2/SA3/SA4 ->
// Series A) share a parent funding round. The Summary card displays ONE
// column per parent by default; clicking the chevron expands the parent to
// show its subrounds inline. Pre-money lives on the parent — every subround
// in the group inherits it. CNs are tracked on the Convertible Notes page
// with a per-CN destination subround; their dollars roll into that
// subround's notes-financing column here.
interface RoundColumn {
  round_id: string
  code: string
  name: string | null
  kind: 'formation' | 'closed' | 'open'
  group_code: string
  group_name: string
  is_group_primary: boolean
  group_pre_money: number | null
  close_date: string | null
  seniority: number
  share_class_code: string | null
  share_price: number | null
  new_money: number
  notes_financing: number
  pre_money: number | null
  post_money: number
  common: number
  preferred_issued: number
  notes_converted: number
  option_pool_issued: number
  total_shares_fds: number
  cumulated_financing: number
}

const { data: roundSummary, refresh: refreshRoundSummary } = await useFetch<{ rounds: RoundColumn[] }>(() => `/api/companies/${id.value}/round-summary`, { watch: [id], default: () => ({ rounds: [] }) })
const roundCols = computed<RoundColumn[]>(() => roundSummary.value?.rounds || [])

// Group subrounds by parent funding round. The endpoint stamps each round
// with its group_code; we keep the relative order (parents appear in the
// order their earliest subround does on the close-date sort).
interface RoundGroup {
  code: string
  name: string
  subrounds: RoundColumn[]    // sorted by close_date / seniority via endpoint order
  hasOpen: boolean
}
const roundGroups = computed<RoundGroup[]>(() => {
  const groups: RoundGroup[] = []
  const byCode = new Map<string, RoundGroup>()
  for (const r of roundCols.value) {
    let g = byCode.get(r.group_code)
    if (!g) {
      g = { code: r.group_code, name: r.group_name, subrounds: [], hasOpen: false }
      groups.push(g)
      byCode.set(r.group_code, g)
    }
    g.subrounds.push(r)
    if (r.kind === 'open') g.hasOpen = true
  }
  return groups
})

// Roll-up of a parent column's cell values from its subrounds. The collapsed
// view of a group shows: latest close_date, sum of cash + notes + pool +
// preferred + notes-converted across subrounds, and the cumulative FDS /
// financing at the END of the last subround in the group.
function rollupGroup(g: RoundGroup): RoundColumn {
  const primary = g.subrounds.find(s => s.is_group_primary) ?? g.subrounds[0]!
  const last = g.subrounds[g.subrounds.length - 1]!
  const sum = (key: keyof RoundColumn): number => g.subrounds.reduce((a, s) => a + (Number(s[key]) || 0), 0)
  const latestDate = g.subrounds
    .map(s => s.close_date).filter((d): d is string => !!d).sort().pop() ?? null
  const hasOpen = g.hasOpen
  return {
    ...primary,
    // The collapsed column inherits the group's identity but rolls up the
    // subround data. round_id stays as the primary so cell edits go to the
    // right DB row.
    code: g.code,
    name: g.name,
    kind: hasOpen ? 'open' : primary.kind,
    close_date: hasOpen ? null : latestDate,
    new_money: sum('new_money'),
    notes_financing: sum('notes_financing'),
    common: sum('common'),
    preferred_issued: sum('preferred_issued'),
    notes_converted: sum('notes_converted'),
    option_pool_issued: sum('option_pool_issued'),
    total_shares_fds: last.total_shares_fds,
    cumulated_financing: last.cumulated_financing,
    // Post-money uses the group's pre-money; new money + notes are summed.
    post_money: (primary.group_pre_money || 0) + sum('new_money') + sum('notes_financing'),
    // Share price: when there's only one subround, show its price; else null
    // (different subrounds have different prices — expand to see them).
    share_price: g.subrounds.length === 1 ? primary.share_price : null,
    pre_money: primary.group_pre_money,
    group_pre_money: primary.group_pre_money,
    is_group_primary: true,
  }
}

// Expand/collapse state per group code. Default: collapsed everywhere.
const expandedGroups = ref<Set<string>>(new Set())
function toggleGroup(code: string) {
  const next = new Set(expandedGroups.value)
  if (next.has(code)) next.delete(code)
  else next.add(code)
  expandedGroups.value = next
}

// Flattened render list. Each entry is either a 'parent' (collapsed group
// rollup) or a 'subround' (expanded subround within a group).
type RenderRole = 'parent' | 'subround'
interface RenderCol { col: RoundColumn; role: RenderRole; groupCode: string }
const renderCols = computed<RenderCol[]>(() => {
  const out: RenderCol[] = []
  for (const g of roundGroups.value) {
    if (expandedGroups.value.has(g.code) && g.subrounds.length > 1) {
      // Expanded: render each subround as its own column.
      for (const s of g.subrounds) out.push({ col: s, role: 'subround', groupCode: g.code })
    } else {
      // Collapsed: render the rollup as a single column. When the group has
      // only one subround there's nothing to roll up — just show it directly.
      out.push({
        col: g.subrounds.length === 1 ? g.subrounds[0]! : rollupGroup(g),
        role: 'parent',
        groupCode: g.code,
      })
    }
  }
  return out
})

function groupHasMultipleSubrounds(code: string): boolean {
  return (roundGroups.value.find(g => g.code === code)?.subrounds.length || 0) > 1
}

// Friendly column label. Strip Carta's "Preferred (CODE)" tail so headers
// stay clean. Parent rollups already carry the cleaned group name from the
// endpoint; subround rows still need the strip.
function friendlyRoundLabel(r: RoundColumn): string {
  if (r.kind === 'formation' || r.code === 'CS') return 'Formation'
  if (r.round_id === 'open') return r.name || 'Open round'
  const raw = (r.name || r.code).trim()
  return raw
    .replace(/\s+Preferred\s*\([A-Z][A-Z0-9-]+\)\s*$/i, '')
    .replace(/\s*\([A-Z][A-Z0-9-]+\)\s*$/i, '') || r.code
}

// Soft amber tint marks every cell that's a user-input field, so the operator
// can tell at a glance which numbers they own vs which are derived from the
// ledger import. Focus state clears the tint and switches to the accent ring.
const inputCellClass = 'w-full bg-amber-50 border border-amber-300 hover:border-amber-500 focus:border-accent-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-accent-500 rounded px-1 py-0.5 text-right text-[12px] text-ink-900 num'

// Inline edit of a round's close date (Closing date row, Summary card).
// Open rounds don't get an input; the synthesized 'open' row_id has no DB
// backing and is skipped. Re-import from Carta resets to the ledger-derived
// default.
async function updateRoundCloseDate(roundId: string, value: string) {
  if (!roundId || roundId === 'open') return
  try {
    await $fetch(`/api/rounds/${roundId}`, { method: 'PATCH', body: { close_date: value || null } })
    await refreshRoundSummary()
  } catch (e) {
    console.error('Failed to update round close date', e)
  }
}

// Pool top-ups are per-round numbers stored on rounds.option_pool_issued
// (importer seeds Formation with the imported total; user moves tranches
// elsewhere inline). Empty input clears the cell to 0.
async function updateRoundPoolIssued(roundId: string, value: string) {
  if (!roundId || roundId === 'open') return
  const n = value === '' ? 0 : Number(value)
  if (!isFinite(n) || n < 0) return
  try {
    await $fetch(`/api/rounds/${roundId}`, { method: 'PATCH', body: { option_pool_issued: n } })
    await refreshRoundSummary()
  } catch (e) {
    console.error('Failed to update round pool issuance', e)
  }
}

// Pre-money is a user input on each "real" round (cash-driven parent or
// synthesized open). CN-conversion children inherit their parent's value;
// their cells are read-only. Open synthesized column writes to Assumptions
// via /api/companies/:id/assumptions because there's no rounds row to PATCH.
async function updateRoundPreMoney(roundId: string, value: string) {
  if (!roundId) return
  const n = value === '' ? null : Number(value)
  if (n != null && (!isFinite(n) || n < 0)) return
  try {
    if (roundId === 'open') {
      await $fetch(`/api/companies/${id.value}/assumptions`, {
        method: 'POST',
        body: { pre_money: n ?? 0 },
      })
    } else {
      await $fetch(`/api/rounds/${roundId}`, { method: 'PATCH', body: { pre_money: n } })
    }
    await refreshRoundSummary()
  } catch (e) {
    console.error('Failed to update round pre_money', e)
  }
}

// New money — cash raised at this round. Closed rounds carry the parsed
// ledger value; user can edit to correct. Open round writes to Assumptions.
async function updateRoundNewMoney(roundId: string, value: string) {
  if (!roundId) return
  const n = value === '' ? 0 : Number(value)
  if (!isFinite(n) || n < 0) return
  try {
    if (roundId === 'open') {
      await $fetch(`/api/companies/${id.value}/assumptions`, {
        method: 'POST',
        body: { new_money: n },
      })
    } else {
      await $fetch(`/api/rounds/${roundId}`, { method: 'PATCH', body: { new_money: n } })
    }
    await refreshRoundSummary()
  } catch (e) {
    console.error('Failed to update round new_money', e)
  }
}

const query = ref('')
const currentPPS = computed(() => data.value?.current_pps || 0)

// Per-table unit visibility.
const holdUnits = useTableUnits('capstack:cap-table:holdings:units')

// Build pivoted rows: stakeholder × share class + outstanding options.
// Convertible notes are NOT counted here — they're either already represented
// in holdings via their destination share class (historical conversions) or
// they live in the Convertible-notes ledger below + are modeled dynamically
// on the Assumptions page. Showing them again here would double-count.
interface PivotRow {
  id: string
  stakeholderId: string
  name: string
  totalShares: number
  optionShares: number
  fds: number
  byClass: Record<string, number>
}

const pivot = computed<PivotRow[]>(() => {
  const map = new Map<string, PivotRow>()
  for (const s of data.value!.stakeholders) {
    map.set(s.id, { id: s.id, stakeholderId: s.id, name: s.name, totalShares: 0, optionShares: 0, fds: 0, byClass: {} })
  }
  for (const h of data.value!.holdings) {
    const row = map.get(h.stakeholder_id)
    if (!row) continue
    row.byClass[h.share_class_id] = (row.byClass[h.share_class_id] || 0) + h.shares
    row.totalShares += h.shares
  }
  for (const g of data.value!.grants) {
    if (g.status !== 'outstanding') continue
    if (!g.stakeholder_id) continue
    const row = map.get(g.stakeholder_id)
    if (!row) continue
    row.optionShares += g.quantity
  }
  for (const row of map.values()) row.fds = row.totalShares + row.optionShares
  const arr = Array.from(map.values()).filter(r => r.fds > 0)
  if (query.value.trim()) {
    const q = query.value.toLowerCase()
    return arr.filter(r => r.name.toLowerCase().includes(q))
  }
  return arr
})

const totals = computed(() => {
  const byClass: Record<string, number> = {}
  let totalShares = 0
  let totalOptions = 0
  for (const r of pivot.value) {
    for (const [k, v] of Object.entries(r.byClass)) byClass[k] = (byClass[k] || 0) + v
    totalShares += r.totalShares
    totalOptions += r.optionShares
  }
  return { byClass, totalShares, totalOptions, fds: totalShares + totalOptions }
})

const poolAuthorized = computed(() => data.value!.pools.reduce((a: number, p: any) => a + (p.authorized || 0), 0))
const poolAvailable = computed(() => Math.max(0, poolAuthorized.value - totals.value.totalOptions - data.value!.grants.filter((g: any) => g.status === 'proposed').reduce((a: number, g: any) => a + g.quantity, 0)))
const fdsIncludingPool = computed(() => totals.value.fds + poolAvailable.value)

// ----- Summary cap table (top card, spec §5.1) -----
// Recreates Carta's Summary Cap Table tab — one line per security plus
// subtotals for Common / Preferred and a row for the Stock Plan. Each
// security contributes to FDS = outstanding shares (or pool authorized).
// `kind` drives row styling. The `*-gap` rows render as small spacer rows
// between Common / Preferred / Pool sections so the visual breathing room
// holds up even when subtotals are absent (single-class group).
interface SummaryRow {
  code: string | null
  label: string
  authorized: number | null
  outstanding: number | null
  available: number | null
  fds: number
  kind: 'common' | 'preferred' | 'pool' | 'common-subtotal' | 'preferred-subtotal' | 'total' | 'gap'
}

function gapRow(): SummaryRow {
  return { code: null, label: '', authorized: null, outstanding: null, available: null, fds: 0, kind: 'gap' }
}

const summaryRows = computed<SummaryRow[]>(() => {
  const rows: SummaryRow[] = []
  const classes = (data.value?.share_classes || []) as any[]
  const issued = totals.value.byClass

  const common = classes.filter(c => (c.kind || '').toLowerCase() === 'common')
  const preferred = classes.filter(c => (c.kind || '').toLowerCase() === 'preferred')
  const other = classes.filter(c => {
    const k = (c.kind || '').toLowerCase()
    return k !== 'common' && k !== 'preferred'
  })

  for (const c of common) {
    rows.push({
      code: c.code || null,
      label: c.name || c.code,
      authorized: c.authorized ?? null,
      outstanding: issued[c.id] || 0,
      available: null,
      fds: issued[c.id] || 0,
      kind: 'common',
    })
  }
  if (common.length > 1) {
    const sumAuth = common.reduce((a, c) => a + (c.authorized || 0), 0)
    const sumOut  = common.reduce((a, c) => a + (issued[c.id] || 0), 0)
    rows.push({ code: null, label: 'Common — subtotal', authorized: sumAuth, outstanding: sumOut, available: null, fds: sumOut, kind: 'common-subtotal' })
  }

  if (common.length && preferred.length) rows.push(gapRow())

  for (const c of preferred) {
    rows.push({
      code: c.code || null,
      label: c.name || c.code,
      authorized: c.authorized ?? null,
      outstanding: issued[c.id] || 0,
      available: null,
      fds: issued[c.id] || 0,
      kind: 'preferred',
    })
  }
  if (preferred.length > 1) {
    const sumAuth = preferred.reduce((a, c) => a + (c.authorized || 0), 0)
    const sumOut  = preferred.reduce((a, c) => a + (issued[c.id] || 0), 0)
    rows.push({ code: null, label: 'Preferred — subtotal', authorized: sumAuth, outstanding: sumOut, available: null, fds: sumOut, kind: 'preferred-subtotal' })
  }

  if ((common.length || preferred.length) && other.length) rows.push(gapRow())

  for (const c of other) {
    rows.push({
      code: c.code || null,
      label: c.name || c.code,
      authorized: c.authorized ?? null,
      outstanding: issued[c.id] || 0,
      available: null,
      fds: issued[c.id] || 0,
      kind: 'common',
    })
  }

  if (common.length || preferred.length || other.length) rows.push(gapRow())

  const pools = data.value?.pools || []
  const poolName = pools.length === 1 ? (pools[0] as any).name : 'Equity incentive plans'
  rows.push({
    code: null,
    label: poolName,
    authorized: poolAuthorized.value,
    outstanding: totals.value.totalOptions,
    available: poolAvailable.value,
    fds: poolAuthorized.value,
    kind: 'pool',
  })

  rows.push({
    code: null,
    label: 'Total fully diluted',
    authorized: null,
    outstanding: totals.value.totalShares,
    available: poolAvailable.value,
    fds: fdsIncludingPool.value,
    kind: 'total',
  })
  return rows
})

// ----- Holdings pivot table (sortable + resizable) -----
// Each "share-quantity" metric (per share-class, Options, FDS) unfolds into
// 1-3 sub-columns based on which units the user has selected. Sub-columns
// of the same metric share a `group` label that's used to render a two-row
// header that visually distinguishes "CS / CS % / CS $" as one group.
// Convertible notes don't appear here — see the Convertible notes card
// below and the Assumptions page for CN math.
interface HoldCol {
  key: string
  label: string             // full e.g. "CS %" (still used for accessibility / sorted-by-key)
  group?: string            // metric group label, e.g. "CS"
  width: number
  sortable: boolean
  align: 'left' | 'right'
  baseKey?: string
  unit?: 'shares' | 'pct' | 'value'
}

function unitColLabel(u: 'shares' | 'pct' | 'value'): string {
  return u === 'shares' ? 'Shares' : u === 'pct' ? '%' : '$'
}

const holdingsCols = computed<HoldCol[]>(() => {
  const cols: HoldCol[] = [
    { key: 'name', label: 'Stakeholder', width: 220, sortable: true, align: 'left' },
  ]
  for (const sc of (data.value?.share_classes || [])) {
    for (const u of holdUnits.selected.value) {
      cols.push({
        key: `class_${sc.id}_${u}`, baseKey: `class_${sc.id}`, unit: u, group: sc.code,
        label: `${sc.code}${unitSuffix(u)}`,
        width: u === 'shares' ? 110 : 90, sortable: true, align: 'right',
      })
    }
  }
  for (const u of holdUnits.selected.value) {
    cols.push({
      key: `optionShares_${u}`, baseKey: 'optionShares', unit: u, group: 'Options',
      label: `Options${unitSuffix(u)}`,
      width: u === 'shares' ? 110 : 90, sortable: true, align: 'right',
    })
  }
  for (const u of holdUnits.selected.value) {
    cols.push({
      key: `fds_${u}`, baseKey: 'fds', unit: u, group: 'FDS',
      label: `FDS${unitSuffix(u)}`,
      width: u === 'shares' ? 130 : 100, sortable: true, align: 'right',
    })
  }
  return cols
})

// Collapse consecutive columns with the same `group` into a single spanning
// header. The first column (Stakeholder, no group) is excluded; it gets a
// rowspan=2 header so it occupies both header rows.
const holdingsGroups = computed(() => {
  const groups: Array<{ group: string; colspan: number; firstKey: string }> = []
  for (const col of holdingsTable.cols) {
    if (!col.group) continue
    const last = groups[groups.length - 1]
    if (last && last.group === col.group) last.colspan++
    else groups.push({ group: col.group, colspan: 1, firstKey: col.key })
  }
  return groups
})

const holdingsTable = useSortableTable({
  key: 'capstack:cap-table:holdings',
  defaultSort: { key: 'fds_shares', dir: 'desc' },
  columns: holdingsCols.value as any,
})

// Rebuild on share-class or toggle change, preserving widths where possible.
watch(holdingsCols, (cols) => {
  const widthMap: Record<string, number> = {}
  for (const c of holdingsTable.cols) widthMap[c.key] = c.width
  const next = cols.map(c => ({ ...c, width: widthMap[c.key] ?? c.width }))
  holdingsTable.cols.splice(0, holdingsTable.cols.length, ...(next as any))
  // If the sorted column was removed by a toggle change, fall back to FDS shares.
  if (!holdingsTable.cols.find(c => c.key === holdingsTable.sort.key)) {
    holdingsTable.sort.key = 'fds_shares'
  }
}, { immediate: true })

function holdingBase(row: any, baseKey: string): number {
  if (baseKey === 'optionShares') return row.optionShares
  if (baseKey === 'fds') return row.fds
  if (baseKey.startsWith('class_')) return row.byClass[baseKey.slice(6)] || 0
  return 0
}

const sortedPivot = computed(() => {
  const k = holdingsTable.sort.key
  const sign = holdingsTable.sort.dir === 'asc' ? 1 : -1
  const baseKey = k === 'name' ? 'name' : k.replace(/_(shares|pct|value)$/, '')

  return [...pivot.value].sort((a, b) => {
    let av: number | string, bv: number | string
    if (baseKey === 'name') { av = a.name; bv = b.name }
    else { av = holdingBase(a, baseKey); bv = holdingBase(b, baseKey) }
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign
    return String(av).localeCompare(String(bv), 'en', { numeric: true }) * sign
  })
})

const holdingsWidth = computed(() => holdingsTable.cols.reduce((s, c) => s + c.width, 0))

function sortIconFor(table: ReturnType<typeof useSortableTable>, key: string) {
  if (table.sort.key !== key) return null
  return table.sort.dir
}
</script>

<template>
  <div v-if="data">
    <div class="flex items-end justify-between mb-4 gap-3 flex-wrap">
      <div>
        <h1 class="text-xl font-semibold tracking-tight text-ink-900">Cap table</h1>
        <p class="text-sm text-ink-600 mt-1">
          Stakeholders × share classes. Toggle Shares / % FDS / $ per table — % uses FDS (incl. pool); $ uses the latest PPS ({{ fmtPricePerShare(currentPPS) }}).
        </p>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <div class="relative">
          <Filter :size="12" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500" />
          <input v-model="query" placeholder="Filter stakeholders…" class="rounded-md border border-ink-300 bg-white pl-7 pr-3 py-1.5 text-sm w-64 shadow-sm focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500" />
        </div>
        <NuxtLink :to="`/companies/${id}/import`">
          <UiButton><Upload :size="14" /> Re-import</UiButton>
        </NuxtLink>
      </div>
    </div>

    <UiEmpty
      v-if="!data.stakeholders.length"
      title="No cap table loaded"
      description="Import a Carta export to populate stakeholders, share classes, and convertibles."
    >
      <NuxtLink :to="`/companies/${id}/import`"><UiButton variant="primary"><Upload :size="14" /> Import Carta export</UiButton></NuxtLink>
    </UiEmpty>

    <div v-else class="space-y-6">
      <!-- Per-round Summary Cap Table (spec §5.1) — chronological columns
           recreated from each share-class ledger plus the Open Round from
           Assumptions. Rows are the line items the user expects to see at a
           glance: close date, money / share-price math at the top, then the
           per-round share contributions, with cumulative FDS + financing at
           the bottom. The Open Round column is highlighted; closed rounds are
           plain. -->
      <UiCard
        v-if="roundCols.length"
        title="Summary cap table"
        subtitle="One column per round — chronological by close date. Open round highlighted."
        :padded="false"
      >
        <div class="overflow-x-auto">
          <table class="text-[12px] border-separate whitespace-nowrap" style="border-spacing: 0; min-width: 100%;">
            <colgroup>
              <col style="width: 220px" />
              <col v-for="rc in renderCols" :key="rc.col.round_id + rc.role" :style="{ minWidth: rc.role === 'subround' ? '120px' : '140px' }" />
            </colgroup>
            <thead class="text-ink-700 bg-ink-100">
              <tr>
                <th class="px-3 py-2 border-b border-ink-300 text-left text-[11px] font-semibold uppercase tracking-wide">Capitalization table</th>
                <th
                  v-for="rc in renderCols"
                  :key="rc.col.round_id + rc.role"
                  class="px-3 py-2 border-b border-ink-300 text-right text-[11px] font-semibold"
                  :class="[
                    rc.col.kind === 'open' ? 'bg-accent-50 text-accent-700' : 'text-ink-700',
                    rc.role === 'subround' ? 'bg-ink-50/60 text-ink-600 pl-6' : '',
                  ]"
                >
                  <div class="flex items-center justify-end gap-1.5">
                    <button
                      v-if="(rc.role === 'parent' && groupHasMultipleSubrounds(rc.groupCode)) || rc.role === 'subround'"
                      type="button"
                      class="text-ink-500 hover:text-ink-900 inline-flex items-center"
                      @click="toggleGroup(rc.groupCode)"
                      :title="expandedGroups.has(rc.groupCode) ? 'Collapse subrounds' : 'Expand subrounds'"
                    >
                      <span v-if="expandedGroups.has(rc.groupCode)" class="text-[10px]">▼</span>
                      <span v-else class="text-[10px]">▶</span>
                    </button>
                    <span v-if="rc.role === 'subround'" class="text-ink-400 mr-0.5" aria-hidden="true">↳</span>
                    <span>{{ friendlyRoundLabel(rc.col) }}</span>
                  </div>
                  <div v-if="rc.col.kind === 'open'" class="text-[9px] font-medium uppercase tracking-wider text-accent-600">open</div>
                </th>
              </tr>
            </thead>
            <tbody class="num">
              <!-- Round-level money math (top group). Closing date is an
                   inline date input on every persisted round; the synthesized
                   open column (round_id === 'open') has no DB row to PATCH so
                   it falls through to a dash. -->
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-700">Closing date of funding</td>
                <td v-for="rc in renderCols" :key="rc.col.round_id + rc.role" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="[rc.col.kind === 'open' ? 'bg-accent-50/40' : '', rc.role === 'subround' ? 'bg-ink-50/60' : '']" >
                  <template v-if="rc.col.kind === 'open'">
                    <span class="text-ink-400">—</span>
                  </template>
                  <template v-else>
                    <input
                      type="date"
                      :value="rc.col.close_date || ''"
                      :class="inputCellClass + ' cursor-pointer'"
                      @change="updateRoundCloseDate(rc.col.round_id, ($event.target as HTMLInputElement).value)"
                    />
                  </template>
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-700">Pre-money valuation ($)</td>
                <td v-for="rc in renderCols" :key="rc.col.round_id + rc.role" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="[rc.col.kind === 'open' ? 'bg-accent-50/40' : '', rc.role === 'subround' ? 'bg-ink-50/60' : '']" >
                  <template v-if="rc.role === 'subround'">
                    <span class="text-ink-400 italic text-[11px]">inherited</span>
                  </template>
                  <NumberInput
                    v-else
                    variant="bare"
                    prefix="$"
                    :model-value="rc.col.pre_money"
                    placeholder="—"
                    :input-class="inputCellClass"
                    title="Pre-money valuation — user input on the parent round; inherited by all subrounds"
                    @update:model-value="(v) => updateRoundPreMoney(rc.col.round_id, v == null ? '' : String(v))"
                  />
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-700">New money ($)</td>
                <td v-for="rc in renderCols" :key="rc.col.round_id + rc.role" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="[rc.col.kind === 'open' ? 'bg-accent-50/40' : '', rc.role === 'subround' ? 'bg-ink-50/60' : '']" >
                  <NumberInput
                    variant="bare"
                    prefix="$"
                    :model-value="rc.col.new_money || null"
                    placeholder="—"
                    :input-class="inputCellClass"
                    title="New money — user input"
                    @update:model-value="(v) => updateRoundNewMoney(rc.col.round_id, v == null ? '' : String(v))"
                  />
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-700">Notes financing ($)</td>
                <td v-for="rc in renderCols" :key="rc.col.round_id + rc.role" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="[rc.col.kind === 'open' ? 'bg-accent-50/40' : '', rc.role === 'subround' ? 'bg-ink-50/60' : '']" >
                  {{ rc.col.notes_financing ? fmtUSD(rc.col.notes_financing) : '—' }}
                </td>
              </tr>
              <tr class="font-medium">
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-800">Post-money valuation ($)</td>
                <td v-for="rc in renderCols" :key="rc.col.round_id + rc.role" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-900" :class="[rc.col.kind === 'open' ? 'bg-accent-50/40 text-accent-700' : '', rc.role === 'subround' ? 'bg-ink-50/60' : '']" >
                  {{ rc.col.post_money ? fmtUSD(rc.col.post_money) : '—' }}
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-700">Share price ($)</td>
                <td v-for="rc in renderCols" :key="rc.col.round_id + rc.role" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="[rc.col.kind === 'open' ? 'bg-accent-50/40' : '', rc.role === 'subround' ? 'bg-ink-50/60' : '']" >
                  {{ rc.col.share_price ? fmtPricePerShare(rc.col.share_price) : '—' }}
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-700">Cumulated financing</td>
                <td v-for="rc in renderCols" :key="rc.col.round_id + rc.role" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="[rc.col.kind === 'open' ? 'bg-accent-50/40' : '', rc.role === 'subround' ? 'bg-ink-50/60' : '']" >
                  {{ fmtUSD(rc.col.cumulated_financing) }}
                </td>
              </tr>

              <!-- Spacer -->
              <tr aria-hidden="true"><td colspan="99" class="h-3 p-0 bg-transparent" /></tr>

              <!-- Per-round share contributions -->
              <tr class="font-medium">
                <td class="px-3 py-1.5 border-b border-ink-300 border-t-2 text-ink-900">Total shares issued (#) — fully diluted</td>
                <td v-for="rc in renderCols" :key="rc.col.round_id + rc.role" class="px-3 py-1.5 border-b border-ink-300 border-t-2 text-right text-ink-900" :class="[rc.col.kind === 'open' ? 'bg-accent-50/40 text-accent-700' : '', rc.role === 'subround' ? 'bg-ink-50/60' : '']" >
                  {{ rc.col.total_shares_fds ? fmtShares(rc.col.total_shares_fds) : '—' }}
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-600 text-right pr-6">Common</td>
                <td v-for="rc in renderCols" :key="rc.col.round_id + rc.role" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="[rc.col.kind === 'open' ? 'bg-accent-50/40' : '', rc.role === 'subround' ? 'bg-ink-50/60' : '']" >
                  {{ rc.col.common ? fmtShares(rc.col.common) : '—' }}
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-600 text-right pr-6">Preferred issued</td>
                <td v-for="rc in renderCols" :key="rc.col.round_id + rc.role" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="[rc.col.kind === 'open' ? 'bg-accent-50/40' : '', rc.role === 'subround' ? 'bg-ink-50/60' : '']" >
                  {{ rc.col.preferred_issued ? fmtShares(rc.col.preferred_issued) : '—' }}
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-600 text-right pr-6">Notes converted</td>
                <td v-for="rc in renderCols" :key="rc.col.round_id + rc.role" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="[rc.col.kind === 'open' ? 'bg-accent-50/40' : '', rc.role === 'subround' ? 'bg-ink-50/60' : '']" >
                  {{ rc.col.notes_converted ? fmtShares(rc.col.notes_converted) : '—' }}
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-600 text-right pr-6">Option pool issued</td>
                <td v-for="rc in renderCols" :key="rc.col.round_id + rc.role" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="[rc.col.kind === 'open' ? 'bg-accent-50/40' : '', rc.role === 'subround' ? 'bg-ink-50/60' : '']" >
                  <template v-if="rc.col.round_id === 'open'">
                    <span class="text-ink-400">—</span>
                  </template>
                  <NumberInput
                    v-else
                    variant="bare"
                    :model-value="rc.col.option_pool_issued || null"
                    placeholder="—"
                    :input-class="inputCellClass"
                    title="Option pool issued — user input"
                    @update:model-value="(v) => updateRoundPoolIssued(rc.col.round_id, v == null ? '' : String(v))"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="px-4 py-2 text-[11px] text-ink-500 bg-ink-50/60 border-t border-ink-200">
          Closed-round values derived from per-class ledgers + Convertible Ledger; Open round mirrors Assumptions. Re-import to refresh closed-round data.
        </p>
      </UiCard>

      <!-- Securities rollup — one line per security class with authorized vs
           outstanding vs available, Common / Preferred subtotals, and the
           Total fully-diluted footer. (Different lens from the per-round
           summary above.) -->
      <UiCard title="Securities" subtitle="Authorized vs outstanding vs available per share class" :padded="false">
        <div class="overflow-x-auto">
          <table class="text-[13px] border-separate w-full" style="border-spacing: 0; table-layout: fixed;">
            <colgroup>
              <col style="width: 70px" />
              <col />
              <col style="width: 14%" />
              <col style="width: 14%" />
              <col style="width: 13%" />
              <col style="width: 11%" />
              <col style="width: 10%" />
            </colgroup>
            <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide bg-ink-100">
              <tr>
                <th class="px-3 py-1.5 border-b border-ink-300 font-semibold">Code</th>
                <th class="px-3 py-1.5 border-b border-ink-300 font-semibold">Security</th>
                <th class="px-3 py-1.5 border-b border-ink-300 font-semibold text-right">Authorized</th>
                <th class="px-3 py-1.5 border-b border-ink-300 font-semibold text-right">Outstanding</th>
                <th class="px-3 py-1.5 border-b border-ink-300 font-semibold text-right">Available</th>
                <th class="px-3 py-1.5 border-b border-ink-300 font-semibold text-right">FDS</th>
                <th class="px-3 py-1.5 border-b border-ink-300 font-semibold text-right">% FDS</th>
              </tr>
            </thead>
            <tbody class="num">
              <template v-for="(r, i) in summaryRows" :key="i">
                <!-- Spacer row between sections. Transparent so the card stays clean. -->
                <tr v-if="r.kind === 'gap'" aria-hidden="true">
                  <td colspan="7" class="h-3 p-0 bg-transparent" />
                </tr>
                <tr
                  v-else
                  :class="[
                    r.kind === 'total' ? 'bg-ink-200 font-semibold text-ink-900' : '',
                    (r.kind === 'common-subtotal' || r.kind === 'preferred-subtotal') ? 'bg-ink-100 font-semibold text-ink-800' : '',
                    r.kind === 'pool' ? 'bg-amber-50/50' : '',
                    (r.kind === 'common' || r.kind === 'preferred') ? 'hover:bg-accent-50/30 transition-colors' : '',
                  ]"
                >
                  <td
                    class="px-3 py-1.5 font-mono text-[11px] border-b border-ink-200"
                    :class="[
                      (r.kind === 'common-subtotal' || r.kind === 'preferred-subtotal' || r.kind === 'total') ? 'border-t border-ink-300' : '',
                      r.kind === 'total' ? 'text-ink-900' : 'text-ink-700',
                    ]"
                  >{{ r.code || '' }}</td>
                  <td
                    class="px-3 py-1.5 border-b border-ink-200 truncate"
                    :class="[
                      (r.kind === 'common-subtotal' || r.kind === 'preferred-subtotal' || r.kind === 'total') ? 'border-t border-ink-300' : '',
                    ]"
                    :title="r.label"
                  >{{ r.label }}</td>
                  <td
                    class="px-3 py-1.5 text-right border-b border-ink-200"
                    :class="[
                      r.kind === 'total' ? '' : 'text-ink-700',
                      (r.kind === 'common-subtotal' || r.kind === 'preferred-subtotal' || r.kind === 'total') ? 'border-t border-ink-300' : '',
                    ]"
                  >{{ r.authorized == null ? '—' : fmtShares(r.authorized) }}</td>
                  <td
                    class="px-3 py-1.5 text-right border-b border-ink-200"
                    :class="[
                      r.kind === 'total' ? '' : 'text-ink-700',
                      (r.kind === 'common-subtotal' || r.kind === 'preferred-subtotal' || r.kind === 'total') ? 'border-t border-ink-300' : '',
                    ]"
                  >{{ r.outstanding == null ? '—' : fmtShares(r.outstanding) }}</td>
                  <td
                    class="px-3 py-1.5 text-right border-b border-ink-200"
                    :class="[
                      r.kind === 'total' ? '' : 'text-ink-700',
                      (r.kind === 'common-subtotal' || r.kind === 'preferred-subtotal' || r.kind === 'total') ? 'border-t border-ink-300' : '',
                    ]"
                  >{{ r.available == null ? '—' : fmtShares(r.available) }}</td>
                  <td
                    class="px-3 py-1.5 text-right border-b border-ink-200"
                    :class="[
                      r.kind === 'total' ? '' : 'font-medium text-ink-900',
                      (r.kind === 'common-subtotal' || r.kind === 'preferred-subtotal' || r.kind === 'total') ? 'border-t border-ink-300' : '',
                    ]"
                  >{{ fmtShares(r.fds) }}</td>
                  <td
                    class="px-3 py-1.5 text-right border-b border-ink-200"
                    :class="[
                      r.kind === 'total' ? '' : 'text-ink-600',
                      (r.kind === 'common-subtotal' || r.kind === 'preferred-subtotal' || r.kind === 'total') ? 'border-t border-ink-300' : '',
                    ]"
                  >{{ fdsIncludingPool > 0 ? fmtPct(r.fds / fdsIncludingPool, 2) : '—' }}</td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </UiCard>

      <!-- Holdings -->
      <UiCard title="Holdings" :subtitle="`${pivot.length} positions`" :padded="false">
        <template #header>
          <TableUnitsToggle storage-key="capstack:cap-table:holdings:units" />
        </template>
        <div class="overflow-x-auto">
          <table class="text-[13px] border-separate" :style="{ borderSpacing: 0, tableLayout: 'fixed', minWidth: holdingsWidth + 'px' }">
            <colgroup>
              <col v-for="c in holdingsTable.cols" :key="c.key" :style="{ width: c.width + 'px' }" />
            </colgroup>
            <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide bg-ink-100">
              <!-- Row 1: group labels spanning their sub-columns (CS, CS1, Options, CN, FDS, ...).
                   Stakeholder column uses rowspan=2. -->
              <tr>
                <th
                  rowspan="2"
                  class="relative px-2.5 py-1.5 border-b border-ink-300 select-none font-semibold text-left align-bottom bg-ink-100"
                  :class="[holdingsTable.cols[0]?.sortable ? 'cursor-pointer hover:text-ink-900' : '', 'sticky-col']"
                  @click="holdingsTable.cols[0] && holdingsTable.toggleSort(holdingsTable.cols[0].key)"
                >
                  <span class="inline-flex items-center gap-1">
                    {{ holdingsTable.cols[0]?.label }}
                    <ChevronUp v-if="holdingsTable.cols[0] && sortIconFor(holdingsTable, holdingsTable.cols[0].key) === 'asc'" :size="12" class="text-accent-600" />
                    <ChevronDown v-if="holdingsTable.cols[0] && sortIconFor(holdingsTable, holdingsTable.cols[0].key) === 'desc'" :size="12" class="text-accent-600" />
                  </span>
                  <span class="resize-handle" v-if="holdingsTable.cols[0]" @mousedown.prevent.stop="holdingsTable.startResize($event, holdingsTable.cols[0].key)" @click.stop />
                </th>
                <th
                  v-for="(g, gi) in holdingsGroups"
                  :key="g.firstKey"
                  :colspan="g.colspan"
                  class="px-2.5 py-1 text-center border-b border-ink-300 text-ink-700 font-semibold"
                  :class="gi % 2 === 0 ? 'bg-ink-100' : 'bg-ink-100/60'"
                >{{ g.group }}</th>
              </tr>
              <!-- Row 2: per-unit labels (Shares / % / $). Sort + resize live here. -->
              <tr>
                <th
                  v-for="(c, idx) in holdingsTable.cols.slice(1)"
                  :key="c.key"
                  class="relative px-2.5 py-1 border-b border-ink-300 select-none text-[10px] font-medium"
                  :class="[
                    c.align === 'right' ? 'text-right' : 'text-left',
                    c.sortable ? 'cursor-pointer hover:text-ink-900' : '',
                    // Tinted background matching the group row.
                    (() => {
                      let gi = -1; let lastG = ''
                      for (const col of holdingsTable.cols.slice(1, idx + 2)) {
                        if (col.group && col.group !== lastG) { gi++; lastG = col.group }
                      }
                      return gi % 2 === 0 ? 'bg-ink-100' : 'bg-ink-100/60'
                    })(),
                  ]"
                  @click="c.sortable ? holdingsTable.toggleSort(c.key) : null"
                >
                  <span class="inline-flex items-center gap-1" :class="c.align === 'right' ? 'flex-row-reverse' : ''">
                    {{ c.unit ? unitColLabel(c.unit) : c.label }}
                    <ChevronUp v-if="sortIconFor(holdingsTable, c.key) === 'asc'" :size="12" class="text-accent-600" />
                    <ChevronDown v-if="sortIconFor(holdingsTable, c.key) === 'desc'" :size="12" class="text-accent-600" />
                  </span>
                  <span class="resize-handle" @mousedown.prevent.stop="holdingsTable.startResize($event, c.key)" @click.stop />
                </th>
              </tr>
            </thead>
            <tbody class="num">
              <tr v-for="r in sortedPivot" :key="r.stakeholderId" class="group">
                <template v-for="c in holdingsTable.cols" :key="c.key">
                  <td v-if="c.key === 'name'" class="sticky-col px-2.5 py-1.5 font-medium text-ink-900 border-b border-ink-200 truncate bg-white group-hover:bg-accent-50/40" :title="r.name">{{ r.name }}</td>
                  <td v-else class="px-2.5 py-1.5 text-right border-b border-ink-200" :class="c.baseKey === 'fds' ? 'font-medium text-ink-900' : ''">
                    <template v-if="holdingBase(r, c.baseKey!)">{{ formatBy(c.unit!, holdingBase(r, c.baseKey!), fdsIncludingPool, currentPPS) }}</template>
                    <span v-else class="text-ink-400">—</span>
                  </td>
                </template>
              </tr>
              <tr class="text-ink-900 font-semibold num bg-ink-100">
                <template v-for="c in holdingsTable.cols" :key="c.key">
                  <td v-if="c.key === 'name'" class="px-2.5 py-1.5 border-t-2 border-ink-300">Total</td>
                  <td v-else-if="c.baseKey === 'fds'" class="px-2.5 py-1.5 text-right border-t-2 border-ink-300">{{ formatBy(c.unit!, totals.fds, fdsIncludingPool, currentPPS) }}</td>
                  <td v-else-if="c.baseKey === 'optionShares'" class="px-2.5 py-1.5 text-right border-t-2 border-ink-300">{{ formatBy(c.unit!, totals.totalOptions, fdsIncludingPool, currentPPS) }}</td>
                  <td v-else-if="c.baseKey?.startsWith('class_')" class="px-2.5 py-1.5 text-right border-t-2 border-ink-300">{{ formatBy(c.unit!, totals.byClass[c.baseKey.slice(6)] || 0, fdsIncludingPool, currentPPS) }}</td>
                </template>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>

    </div>
  </div>
</template>
