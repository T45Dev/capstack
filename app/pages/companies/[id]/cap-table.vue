<script setup lang="ts">
import { Upload, Filter, ChevronUp, ChevronDown, Plus, Trash2 } from 'lucide-vue-next'
import { fmtShares, fmtPct, fmtPricePerShare, normalizeDate } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

interface ShareClassRow { id: string; code: string; name: string; kind: string; authorized: number | null; issue_price: number | null }
interface Stakeholder { id: string; name: string; type: string | null }
interface Holding { stakeholder_id: string; share_class_id: string; shares: number }
interface Grant { id: string; stakeholder_id: string | null; recipient_name: string; quantity: number; status: string }

const { data } = await useFetch<{ share_classes: ShareClassRow[]; stakeholders: Stakeholder[]; holdings: Holding[]; grants: Grant[]; pools: any[]; current_pps: number }>(() => `/api/companies/${id.value}/cap-table`, { watch: [id], default: () => ({ share_classes: [], stakeholders: [], holdings: [], grants: [], pools: [], current_pps: 0 } as any) })

// Per-round Summary Cap Table — top card. One column per round; the user
// manages the row set directly via Add round / Delete round. Every cell
// the operator owns is editable. The Carta import doesn't seed rounds
// anymore; this is a manually-entered table.
interface RoundColumn {
  round_id: string
  code: string
  name: string | null
  kind: 'formation' | 'closed' | 'open'
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
  preferred_issued_override: number | null
  notes_converted: number
  option_pool_issued: number
  total_shares_fds: number
  cumulated_financing: number
}

const { data: roundSummary, refresh: refreshRoundSummary } = await useFetch<{ rounds: RoundColumn[] }>(() => `/api/companies/${id.value}/round-summary`, { watch: [id], default: () => ({ rounds: [] }) })
const roundCols = computed<RoundColumn[]>(() => roundSummary.value?.rounds || [])

// Display label for a round. The user names it; if blank, fall back to the
// code. Draft override wins when there's an in-flight edit.
function friendlyRoundLabel(r: RoundColumn): string {
  const d = drafts.value[r.round_id]
  const draftName = d && 'name' in d ? d.name : undefined
  const name = (draftName ?? r.name ?? '')
  return name.trim() || r.code
}

// Effective kind for a round (draft override wins).
function effectiveKind(r: RoundColumn): 'formation' | 'closed' | 'open' {
  const d = drafts.value[r.round_id]
  if (d && 'kind' in d && d.kind) return d.kind
  return r.kind
}

// Toggle a round between open / closed. Single-open invariant: setting one
// open drafts every other currently-open round (server-side or draft-side)
// back to 'closed' in the same buffer so Save commits the swap atomically.
function setKind(roundId: string, newKind: 'closed' | 'open'): void {
  if (newKind === 'open') {
    for (const r of roundCols.value) {
      if (r.round_id === roundId) continue
      if (effectiveKind(r) === 'open') setDraft(r.round_id, 'kind', 'closed')
    }
  }
  setDraft(roundId, 'kind', newKind)
}

// ---- Edit/save state ----
// Every input on the Summary card writes into a local draft instead of
// PATCHing immediately. The user clicks "Save" to commit the batch — that's
// when the close-date sort actually re-runs, so columns don't jump around
// mid-edit. Cancel discards. Add round / Delete round still hit the server
// immediately so the row set itself stays in sync.
interface RoundDraft {
  name?: string | null
  kind?: 'formation' | 'closed' | 'open'
  close_date?: string | null
  pre_money?: number | null
  new_money?: number
  share_price?: number | null
  common?: number
  preferred_issued?: number
  preferred_issued_override?: number | null
  option_pool_issued?: number
}
const drafts = ref<Record<string, RoundDraft>>({})
const isSaving = ref(false)
const dirtyCount = computed(() => Object.keys(drafts.value).filter(k => {
  const d = drafts.value[k]
  return d && Object.keys(d).length > 0
}).length)

function setDraft<K extends keyof RoundDraft>(roundId: string, field: K, value: RoundDraft[K]): void {
  const cur = drafts.value[roundId] || {}
  drafts.value = { ...drafts.value, [roundId]: { ...cur, [field]: value } }
}

// Effective value to display in a cell — draft override wins, otherwise
// the server value. Used by every input's :model-value / :value binding.
function effective<K extends keyof RoundDraft>(r: RoundColumn, field: K): RoundDraft[K] {
  const d = drafts.value[r.round_id]
  if (d && field in d) return d[field]
  return (r as any)[field]
}

async function saveDrafts() {
  if (!dirtyCount.value) return
  isSaving.value = true
  try {
    for (const [roundId, body] of Object.entries(drafts.value)) {
      if (!body || Object.keys(body).length === 0) continue
      // Normalize close_date before saving (Chrome 2-digit-year gotcha).
      const payload: any = { ...body }
      if ('close_date' in payload) payload.close_date = normalizeDate(payload.close_date || '') || null
      await $fetch(`/api/rounds/${roundId}`, { method: 'PATCH', body: payload })
    }
    drafts.value = {}
    await refreshRoundSummary()
  } catch (e) {
    console.error('Save failed', e)
  } finally {
    isSaving.value = false
  }
}

function cancelDrafts() {
  drafts.value = {}
}

// Soft amber tint marks every cell that's a user-input field, so the operator
// can tell at a glance which numbers they own vs which are derived from the
// ledger import. Focus state clears the tint and switches to the accent ring.
const inputCellClass = 'w-full bg-amber-50 border border-amber-300 hover:border-amber-500 focus:border-accent-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-accent-500 rounded px-1 py-0.5 text-right text-[12px] text-ink-900 num'
// Cells that show a computed value but allow override (Preferred issued).
// When the formula's in effect we render in a muted style so the user can
// see at a glance which cells are derived vs manually set.
const formulaCellClass = 'w-full bg-transparent border border-transparent hover:border-ink-300 focus:border-accent-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-accent-500 rounded px-1 py-0.5 text-right text-[12px] text-ink-500 italic num'

// Preferred issued: when the user has overridden the formula, show the
// override value with the standard amber input chrome. Otherwise display
// the computed value (or nothing) with the muted formula chrome.
function isPreferredOverridden(r: RoundColumn): boolean {
  const d = drafts.value[r.round_id]
  if (d && 'preferred_issued_override' in d) return d.preferred_issued_override != null
  return r.preferred_issued_override != null
}
function preferredIssuedDisplay(r: RoundColumn): number | null {
  const d = drafts.value[r.round_id]
  if (d && 'preferred_issued_override' in d) return d.preferred_issued_override ?? null
  if (r.preferred_issued_override != null) return r.preferred_issued_override
  return r.preferred_issued ? r.preferred_issued : null
}
function preferredIssuedInputClass(r: RoundColumn): string {
  return isPreferredOverridden(r) ? inputCellClass : formulaCellClass
}

// Add a new round. The server picks a unique code (R1, R2, …); the user can
// rename inline. Close date defaults to today so the row sorts predictably.
async function addRound() {
  try {
    await $fetch(`/api/companies/${id.value}/rounds`, {
      method: 'POST',
      body: { close_date: new Date().toISOString().slice(0, 10), kind: 'closed' },
    })
    await refreshRoundSummary()
  } catch (e) { console.error('Failed to add round', e) }
}

// Delete a round. Confirms first. Any CN whose destination matched this
// round's code keeps the value but will read as unmatched until reassigned.
// Also clears any in-flight draft for that round so the dirty count stays
// accurate. Defensive: clear the draft BEFORE the network call so a
// transient render between the DELETE returning and the refresh fetching
// can't reach into a stale draft for a no-longer-existing round.
async function deleteRound(roundId: string, label: string) {
  if (!roundId) return
  if (!confirm(`Delete round "${label}"? Any CNs attributed here will become unassigned.`)) return
  // Optimistically clear the draft first.
  if (drafts.value[roundId]) {
    const next = { ...drafts.value }
    delete next[roundId]
    drafts.value = next
  }
  try {
    await $fetch(`/api/rounds/${roundId}`, { method: 'DELETE' })
    await refreshRoundSummary()
  } catch (e) {
    console.error('Failed to delete round', e)
    // If the delete fails, the round comes back on the next refresh. Try to
    // resync so the UI doesn't lie about what's actually in the DB.
    try { await refreshRoundSummary() } catch {}
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
        <h1 class="text-xl font-semibold tracking-tight text-ink-900">Financings</h1>
        <p class="text-sm text-ink-600 mt-1">
          Funding rounds (top) and convertible notes (below). Round values are user-entered; CNs roll up into the round they're attributed to.
        </p>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <NuxtLink :to="`/companies/${id}/import`">
          <UiButton><Upload :size="14" /> Re-import</UiButton>
        </NuxtLink>
      </div>
    </div>

    <UiEmpty
      v-if="!data.stakeholders.length && !roundCols.length"
      title="No cap table loaded"
      description="Import a Carta export to populate stakeholders, share classes, and convertibles — or click Add round on the Summary card below to start typing your funding history."
    >
      <NuxtLink :to="`/companies/${id}/import`"><UiButton variant="primary"><Upload :size="14" /> Import Carta export</UiButton></NuxtLink>
    </UiEmpty>

    <div class="space-y-6">
      <!-- Per-round Summary Cap Table — one column per user-entered round.
           Rows are the line items the user expects to see at a glance: close
           date, money / share-price math at the top, then the per-round
           share contributions, with cumulative FDS + financing at the
           bottom. The Open round column is highlighted; closed rounds are
           plain. Single-open invariant: only one round can be flagged Open
           at a time. -->
      <UiCard
        title="Summary cap table"
        subtitle="One column per round — type the values; Save commits and re-sorts by close date."
        :padded="false"
      >
        <template #header>
          <div class="flex items-center gap-2">
            <span v-if="dirtyCount" class="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
              {{ dirtyCount }} unsaved {{ dirtyCount === 1 ? 'change' : 'changes' }}
            </span>
            <UiButton v-if="dirtyCount" variant="ghost" :disabled="isSaving" @click="cancelDrafts">Cancel</UiButton>
            <UiButton v-if="dirtyCount" variant="primary" :disabled="isSaving" @click="saveDrafts">
              {{ isSaving ? 'Saving…' : 'Save' }}
            </UiButton>
            <UiButton :disabled="isSaving" @click="addRound"><Plus :size="14" /> Add round</UiButton>
          </div>
        </template>
        <div v-if="!roundCols.length" class="px-4 py-8 text-center text-sm text-ink-500">
          No rounds yet. Click <span class="font-medium text-ink-700">Add round</span> to start typing your funding history.
        </div>
        <div v-else class="overflow-x-auto">
          <table class="text-[12px] border-separate whitespace-nowrap" style="border-spacing: 0; min-width: 100%;">
            <colgroup>
              <col style="width: 220px" />
              <col v-for="r in roundCols" :key="r.round_id" style="min-width: 140px" />
            </colgroup>
            <thead class="text-ink-700 bg-ink-100">
              <tr>
                <th class="px-3 py-2 border-b border-ink-300 text-left text-[11px] font-semibold uppercase tracking-wide sticky left-0 z-10 bg-ink-100">Capitalization table</th>
                <th
                  v-for="r in roundCols"
                  :key="r.round_id"
                  class="px-3 py-2 border-b border-ink-300 text-right text-[11px] font-semibold group"
                  :class="effectiveKind(r) === 'open' ? 'bg-accent-50 text-accent-700' : 'text-ink-700'"
                >
                  <div class="flex items-center justify-end gap-1.5">
                    <button
                      type="button"
                      class="shrink-0 text-ink-400 hover:text-red-600 transition-colors p-0.5 rounded hover:bg-red-50"
                      @click="deleteRound(r.round_id, friendlyRoundLabel(r))"
                      title="Delete round"
                      aria-label="Delete round"
                    >
                      <Trash2 :size="13" />
                    </button>
                    <input
                      type="text"
                      :value="effective(r, 'name') ?? r.code"
                      class="flex-1 min-w-0 bg-transparent text-right font-semibold text-[11px] border border-transparent hover:border-ink-300 focus:border-accent-500 focus:bg-white focus:outline-none rounded px-1 py-0.5"
                      :class="effectiveKind(r) === 'open' ? 'text-accent-700' : ''"
                      @input="setDraft(r.round_id, 'name', ($event.target as HTMLInputElement).value)"
                    />
                  </div>
                  <div class="mt-1 flex items-center justify-end gap-1">
                    <button
                      type="button"
                      class="text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border transition-colors"
                      :class="effectiveKind(r) === 'closed'
                        ? 'bg-ink-200 text-ink-800 border-ink-300'
                        : 'bg-white text-ink-500 border-ink-200 hover:border-ink-300'"
                      @click="setKind(r.round_id, 'closed')"
                    >Closed</button>
                    <button
                      type="button"
                      class="text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border transition-colors"
                      :class="effectiveKind(r) === 'open'
                        ? 'bg-accent-600 text-white border-accent-600'
                        : 'bg-white text-ink-500 border-ink-200 hover:border-ink-300'"
                      @click="setKind(r.round_id, 'open')"
                    >Open</button>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody class="num">
              <!-- Round-level money math (top group). Every cell is a real
                   user-input value on the round row. -->
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-700 sticky left-0 z-10 bg-white">Closing date of funding</td>
                <td v-for="r in roundCols" :key="r.round_id" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="effectiveKind(r) === 'open' ? 'bg-accent-50/40' : ''">
                  <input
                    type="date"
                    :value="(effective(r, 'close_date') ?? r.close_date) || ''"
                    :class="inputCellClass + ' cursor-pointer'"
                    @change="setDraft(r.round_id, 'close_date', ($event.target as HTMLInputElement).value || null)"
                  />
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-700 sticky left-0 z-10 bg-white">Pre-money valuation ($)</td>
                <td v-for="r in roundCols" :key="r.round_id" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="effectiveKind(r) === 'open' ? 'bg-accent-50/40' : ''">
                  <NumberInput
                    variant="bare"
                    prefix="$"
                    :model-value="effective(r, 'pre_money') ?? r.pre_money"
                    placeholder="—"
                    :input-class="inputCellClass"
                    title="Pre-money valuation — user input"
                    @update:model-value="(v) => setDraft(r.round_id, 'pre_money', v)"
                  />
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-700 sticky left-0 z-10 bg-white">New money ($)</td>
                <td v-for="r in roundCols" :key="r.round_id" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="effectiveKind(r) === 'open' ? 'bg-accent-50/40' : ''">
                  <NumberInput
                    variant="bare"
                    prefix="$"
                    :model-value="effective(r, 'new_money') ?? (r.new_money || null)"
                    placeholder="—"
                    :input-class="inputCellClass"
                    title="New money — user input"
                    @update:model-value="(v) => setDraft(r.round_id, 'new_money', v ?? 0)"
                  />
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-700 sticky left-0 z-10 bg-white">Notes financing ($)</td>
                <td v-for="r in roundCols" :key="r.round_id" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="effectiveKind(r) === 'open' ? 'bg-accent-50/40' : ''">
                  {{ r.notes_financing ? fmtUSD(r.notes_financing) : '—' }}
                </td>
              </tr>
              <tr class="font-medium">
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-800 sticky left-0 z-10 bg-white">Post-money valuation ($)</td>
                <td v-for="r in roundCols" :key="r.round_id" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-900" :class="effectiveKind(r) === 'open' ? 'bg-accent-50/40 text-accent-700' : ''">
                  {{ r.post_money ? fmtUSD(r.post_money) : '—' }}
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-700 sticky left-0 z-10 bg-white">Share price ($)</td>
                <td v-for="r in roundCols" :key="r.round_id" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="effectiveKind(r) === 'open' ? 'bg-accent-50/40' : ''">
                  <NumberInput
                    variant="bare"
                    prefix="$"
                    :digits="5"
                    :model-value="effective(r, 'share_price') ?? r.share_price"
                    placeholder="—"
                    :input-class="inputCellClass"
                    @update:model-value="(v) => setDraft(r.round_id, 'share_price', v)"
                  />
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-700 sticky left-0 z-10 bg-white">Cumulated financing</td>
                <td v-for="r in roundCols" :key="r.round_id" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="effectiveKind(r) === 'open' ? 'bg-accent-50/40' : ''">
                  {{ fmtUSD(r.cumulated_financing) }}
                </td>
              </tr>

              <!-- Spacer -->
              <tr aria-hidden="true"><td colspan="99" class="h-3 p-0 bg-transparent" /></tr>

              <!-- Per-round share contributions -->
              <tr class="font-medium">
                <td class="px-3 py-1.5 border-b border-ink-300 border-t-2 text-ink-900 sticky left-0 z-10 bg-white">Total shares issued (#) — fully diluted</td>
                <td v-for="r in roundCols" :key="r.round_id" class="px-3 py-1.5 border-b border-ink-300 border-t-2 text-right text-ink-900" :class="effectiveKind(r) === 'open' ? 'bg-accent-50/40 text-accent-700' : ''">
                  {{ r.total_shares_fds ? fmtShares(r.total_shares_fds) : '—' }}
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-600 text-right pr-6 sticky left-0 z-10 bg-white">Common</td>
                <td v-for="r in roundCols" :key="r.round_id" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="effectiveKind(r) === 'open' ? 'bg-accent-50/40' : ''">
                  <NumberInput
                    variant="bare"
                    :model-value="effective(r, 'common') ?? (r.common || null)"
                    placeholder="—"
                    :input-class="inputCellClass"
                    @update:model-value="(v) => setDraft(r.round_id, 'common', v ?? 0)"
                  />
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-600 text-right pr-6 sticky left-0 z-10 bg-white" title="Defaults to New money ÷ Share price. Type a value to override (use 0 for debt-only rounds); clear to revert.">Preferred issued</td>
                <td v-for="r in roundCols" :key="r.round_id" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="effectiveKind(r) === 'open' ? 'bg-accent-50/40' : ''">
                  <NumberInput
                    variant="bare"
                    :model-value="preferredIssuedDisplay(r)"
                    :placeholder="r.preferred_issued ? fmtShares(r.preferred_issued) : '—'"
                    :input-class="preferredIssuedInputClass(r)"
                    :title="isPreferredOverridden(r) ? 'Manual override — clear to revert to formula' : 'Formula: new_money ÷ share_price (auto). Type to override.'"
                    @update:model-value="(v) => setDraft(r.round_id, 'preferred_issued_override', v ?? null)"
                  />
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-600 text-right pr-6 sticky left-0 z-10 bg-white">Notes converted</td>
                <td v-for="r in roundCols" :key="r.round_id" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="effectiveKind(r) === 'open' ? 'bg-accent-50/40' : ''">
                  {{ r.notes_converted ? fmtShares(r.notes_converted) : '—' }}
                </td>
              </tr>
              <tr>
                <td class="px-3 py-1.5 border-b border-ink-200 text-ink-600 text-right pr-6 sticky left-0 z-10 bg-white">Option pool issued</td>
                <td v-for="r in roundCols" :key="r.round_id" class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700" :class="effectiveKind(r) === 'open' ? 'bg-accent-50/40' : ''">
                  <NumberInput
                    variant="bare"
                    :model-value="effective(r, 'option_pool_issued') ?? (r.option_pool_issued || null)"
                    placeholder="—"
                    :input-class="inputCellClass"
                    title="Option pool issued — user input"
                    @update:model-value="(v) => setDraft(r.round_id, 'option_pool_issued', v ?? 0)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="px-4 py-2 text-[11px] text-ink-500 bg-ink-50/60 border-t border-ink-200">
          Values are user-entered. Toggle a column to Open to mark it as the round currently being modeled — only one round can be Open at a time.
        </p>
      </UiCard>

      <!-- Convertible Notes ledger — extracted into a shared component so
           the dollars/shares always render right next to the rounds they
           attribute to. -->
      <CnLedger :company-id="id" @refreshed="refreshRoundSummary" />

    </div>
  </div>
</template>
