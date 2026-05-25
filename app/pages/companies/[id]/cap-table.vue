<script setup lang="ts">
import { Upload } from 'lucide-vue-next'
import { fmtUSD } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

interface ShareClassRow { id: string; code: string; name: string; kind: string; authorized: number | null; issue_price: number | null }
interface Stakeholder { id: string; name: string; type: string | null }
interface Holding { stakeholder_id: string; share_class_id: string; shares: number }
interface Grant { id: string; stakeholder_id: string | null; recipient_name: string; quantity: number; status: string }

const { data } = await useFetch<{ share_classes: ShareClassRow[]; stakeholders: Stakeholder[]; holdings: Holding[]; grants: Grant[]; pools: any[]; current_pps: number }>(() => `/api/companies/${id.value}/cap-table`, { watch: [id], default: () => ({ share_classes: [], stakeholders: [], holdings: [], grants: [], pools: [], current_pps: 0 } as any) })

// Per-round Financings table — top card. One column per round; the user
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
  liq_pref_multiple: number
  participation: 'none' | 'full' | 'capped'
  participation_cap: number | null
  pref_tier: number
  parent_round_code: string | null
  notes_attributed: Array<{
    id: string
    stakeholderName: string
    destinationCode: string | null
    dollars: number
    shares: number
  }>
}

interface CnReconciliation {
  attributed_dollars: number
  unattributed_dollars: number
  total_dollars: number
  by_reason: { deferred: number; excluded: number; stale_destination: number }
  unreconciled: Array<{
    id: string
    stakeholderName: string
    dollars: number
    destinationCode: string | null
    reason: 'deferred' | 'excluded' | 'stale_destination'
  }>
}
const { data: roundSummary, refresh: refreshRoundSummary } = await useFetch<{ rounds: RoundColumn[]; cn_reconciliation: CnReconciliation }>(() => `/api/companies/${id.value}/round-summary`, {
  watch: [id],
  default: () => ({
    rounds: [],
    cn_reconciliation: { attributed_dollars: 0, unattributed_dollars: 0, total_dollars: 0, by_reason: { deferred: 0, excluded: 0, stale_destination: 0 }, unreconciled: [] },
  }),
})
const roundCols = computed<RoundColumn[]>(() => roundSummary.value?.rounds || [])
const cnReconciliation = computed<CnReconciliation>(() => roundSummary.value?.cn_reconciliation || { attributed_dollars: 0, unattributed_dollars: 0, total_dollars: 0, by_reason: { deferred: 0, excluded: 0, stale_destination: 0 }, unreconciled: [] })

// Tooltip explaining why the CN ledger sum doesn't match Cumulated financing.
const cnReconcileTitle = computed(() => {
  const r = cnReconciliation.value
  const lines: string[] = []
  if (r.by_reason.stale_destination > 0) {
    const codes = [...new Set(r.unreconciled.filter(u => u.reason === 'stale_destination').map(u => u.destinationCode))].filter(Boolean).join(', ')
    lines.push(`Stale destination: ${codes || 'CN destination doesn\'t match any round code'}. Fix on the Convertible notes ledger below.`)
  }
  if (r.by_reason.deferred > 0) lines.push('Unassigned: pick a destination round on the CN ledger.')
  if (r.by_reason.excluded > 0) lines.push('Excluded: "In summary" toggled off on the CN ledger.')
  return lines.join('  •  ')
})

// Add a new round. The server picks a unique code (R1, R2, …); the user can
// rename inline inside the matrix. Close date defaults to today so the row
// sorts predictably.
async function addRound() {
  try {
    await $fetch(`/api/companies/${id.value}/rounds`, {
      method: 'POST',
      body: { close_date: new Date().toISOString().slice(0, 10), kind: 'closed' },
    })
    await refreshRoundSummary()
  } catch (e) { console.error('Failed to add round', e) }
}

// In-flight PATCH counter — bubbled out of FinancingsMatrix to the page
// header so the saving indicator stays consistent with where it was.
const savingCount = ref(0)

// Name of the round currently flagged "open" (used by the page header's
// status pill). Reads off the server data — kind toggles inside the matrix
// commit immediately so this stays fresh.
const openRoundName = computed<string | null>(() => {
  const open = roundCols.value.find(r => r.kind === 'open')
  return open ? (open.name || open.code) : null
})

// Master toggle for the matrix's formula chips + per-column hint sublines.
// Persisted in localStorage so the operator's preference sticks. Default on.
const showFormulas = ref(true)
// Row density. Same persistence pattern as showFormulas.
const matrixDensity = ref<'compact' | 'regular' | 'comfy'>('regular')

if (typeof window !== 'undefined') {
  try {
    const v = localStorage.getItem('capstack:financings:show-formulas')
    if (v !== null) showFormulas.value = v === '1'
    const d = localStorage.getItem('capstack:financings:density')
    if (d === 'compact' || d === 'regular' || d === 'comfy') matrixDensity.value = d
  } catch { /* ignore */ }
  watch(showFormulas, (v) => {
    try { localStorage.setItem('capstack:financings:show-formulas', v ? '1' : '0') } catch { /* ignore */ }
  })
  watch(matrixDensity, (v) => {
    try { localStorage.setItem('capstack:financings:density', v) } catch { /* ignore */ }
  })
}

// Round-name search filter applied to the matrix rows. Lives on the page
// so the toolbar (above the matrix) and the matrix itself can share it.
const matrixQuery = ref('')
const filteredRoundCols = computed<RoundColumn[]>(() => {
  const q = matrixQuery.value.trim().toLowerCase()
  if (!q) return roundCols.value
  return roundCols.value.filter(r => (r.name || r.code).toLowerCase().includes(q))
})

const query = ref('')
const currentPPS = computed(() => data.value?.current_pps || 0)

// Per-table unit visibility.
const holdUnits = useTableUnits('capstack:cap-table:holdings:units')

// Build pivoted rows: stakeholder × share class + outstanding options.
// Convertible notes are NOT counted here — they're either already represented
// in holdings via their destination share class (historical conversions) or
// they live in the Convertible-notes ledger below + are modeled dynamically
// on the Financings table. Showing them again here would double-count.
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

// ----- Financings table (top card, spec §5.1) -----
// Recreates Carta's Financings table tab — one line per security plus
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
// below for CN math.
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
    <FinancingsPageHeader
      :open-round-name="openRoundName"
      :saving-count="savingCount"
      :company-id="id"
      @add-round="addRound"
    />

    <UiEmpty
      v-if="!data.stakeholders.length && !roundCols.length"
      title="No cap table loaded"
      description="Import a Carta export to populate stakeholders, share classes, and convertibles — or click Add round above to start typing your funding history."
    >
      <NuxtLink :to="`/companies/${id}/import`"><UiButton variant="primary"><Upload :size="14" /> Import Carta export</UiButton></NuxtLink>
    </UiEmpty>

    <div class="space-y-4">
      <!-- 6-stat summary above the matrix. Reads off the rounds array — no
           extra fetch — and is hidden when there are no rounds. -->
      <FinancingsSummaryBar v-if="roundCols.length" :rounds="roundCols" />

      <!-- Toolbar: search + density segment + formula-chips toggle. -->
      <FinancingsToolbar
        v-if="roundCols.length"
        v-model="matrixQuery"
        :density="matrixDensity"
        :show-formulas="showFormulas"
        :round-count="filteredRoundCols.length"
        @update:density="(v) => matrixDensity = v"
        @update:show-formulas="(v) => showFormulas = v"
      />

      <!-- Financings matrix — one row per round, columns grouped into
           Money / Shares. Open round is editable; closed rounds are
           read-only. Tooltip diagnostics live on each cell. -->
      <div v-if="!roundCols.length" class="px-4 py-10 text-center text-sm text-ink-500 border border-dashed border-ink-300 rounded-lg bg-white">
        No rounds yet. Click <span class="font-medium text-ink-700">Add round</span> above to start typing your funding history.
      </div>
      <div v-else>
        <FinancingsMatrix
          :rounds="filteredRoundCols"
          :show-formulas="showFormulas"
          :density="matrixDensity"
          @refresh="refreshRoundSummary"
          @update:saving-count="(n) => savingCount = n"
        />

        <!-- CN reconciliation banner. When the CN ledger total doesn't
             equal Cumulated financing, surface the gap below the matrix.
             Same content + tooltip as before; just relocated. -->
        <div
          v-if="cnReconciliation.unattributed_dollars > 0"
          class="mt-2 px-3 py-2 rounded-md border border-amber-200 bg-amber-50/60 text-amber-900 text-[12px] flex items-center justify-between gap-3 num"
          :title="cnReconcileTitle"
        >
          <div class="flex items-center gap-2">
            <span class="font-medium">CNs not rolled up</span>
            <span class="text-[10px] uppercase tracking-wide text-amber-700 font-semibold">{{ cnReconciliation.unreconciled.length }}</span>
          </div>
          <div class="text-right">
            <span class="font-semibold">{{ fmtUSD(cnReconciliation.unattributed_dollars) }}</span>
            <span class="ml-2 text-[10px] text-amber-700">
              <span v-if="cnReconciliation.by_reason.stale_destination > 0">{{ fmtUSD(cnReconciliation.by_reason.stale_destination) }} bad destination</span>
              <span v-if="cnReconciliation.by_reason.deferred > 0" class="ml-2">{{ fmtUSD(cnReconciliation.by_reason.deferred) }} unassigned</span>
              <span v-if="cnReconciliation.by_reason.excluded > 0" class="ml-2">{{ fmtUSD(cnReconciliation.by_reason.excluded) }} excluded</span>
            </span>
          </div>
        </div>
        <div
          v-if="cnReconciliation.total_dollars > 0"
          class="mt-1 px-3 py-1.5 text-[11px] text-ink-500 italic flex items-center justify-between gap-3 num"
        >
          <span>All financings incl. unrolled-up CNs</span>
          <span>{{ fmtUSD((roundCols[roundCols.length - 1]?.cumulated_financing || 0) + cnReconciliation.unattributed_dollars) }}</span>
        </div>
      </div>

      <!-- Investors-by-round matrix hidden by default — backend lives in
           round_investors + /api/companies/:id/investor-matrix when we
           need it. Drop <InvestorMatrix :company-id="id" /> back in here
           to surface it. MOIC on Exit Scenarios still works without it
           (CN-holder invested capital comes from principal + interest). -->

      <!-- Convertible Notes ledger — extracted into a shared component so
           the dollars/shares always render right next to the rounds they
           attribute to. -->
      <CnLedger :company-id="id" @refreshed="refreshRoundSummary" />

    </div>
  </div>
</template>
