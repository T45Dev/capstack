<script setup lang="ts">
import { Upload, Filter, Plus, Edit3, Trash2, ChevronUp, ChevronDown } from 'lucide-vue-next'
import { fmtShares, fmtPct, fmtUSD, fmtDate, fmtPricePerShare } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

interface ShareClassRow { id: string; code: string; name: string; kind: string; authorized: number | null; issue_price: number | null }
interface Stakeholder { id: string; name: string; type: string | null }
interface Holding { stakeholder_id: string; share_class_id: string; shares: number }
interface Grant { id: string; stakeholder_id: string | null; recipient_name: string; quantity: number; status: string }
interface Convertible { id: string; stakeholder_name: string; principal: number; interest_accrued: number; interest_rate: number; issue_date: string | null; maturity_date: string | null; valuation_cap: number | null; conversion_discount: number; converts_at_round: number }

const { data, refresh } = await useFetch<{ share_classes: ShareClassRow[]; stakeholders: Stakeholder[]; holdings: Holding[]; grants: Grant[]; convertibles: Convertible[]; pools: any[]; current_pps: number }>(() => `/api/companies/${id.value}/cap-table`, { watch: [id], default: () => ({ share_classes: [], stakeholders: [], holdings: [], grants: [], convertibles: [], pools: [], current_pps: 0 } as any) })

const query = ref('')
const currentPPS = computed(() => data.value?.current_pps || 0)

// Per-table unit visibility.
const scUnits = useTableUnits('capstack:cap-table:share-classes:units')
const holdUnits = useTableUnits('capstack:cap-table:holdings:units')

// Share-classes section is collapsible — the holdings pivot is the main view.
const scExpanded = ref(false)

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
interface SummaryRow {
  label: string
  authorized: number | null
  outstanding: number | null
  available: number | null
  fds: number
  kind: 'common' | 'preferred' | 'pool' | 'common-subtotal' | 'preferred-subtotal' | 'total'
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
    rows.push({ label: 'Common — subtotal', authorized: sumAuth, outstanding: sumOut, available: null, fds: sumOut, kind: 'common-subtotal' })
  }

  for (const c of preferred) {
    rows.push({
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
    rows.push({ label: 'Preferred — subtotal', authorized: sumAuth, outstanding: sumOut, available: null, fds: sumOut, kind: 'preferred-subtotal' })
  }

  for (const c of other) {
    rows.push({
      label: c.name || c.code,
      authorized: c.authorized ?? null,
      outstanding: issued[c.id] || 0,
      available: null,
      fds: issued[c.id] || 0,
      kind: 'common',
    })
  }

  const pools = data.value?.pools || []
  const poolName = pools.length === 1 ? (pools[0] as any).name : 'Equity incentive plans'
  rows.push({
    label: poolName,
    authorized: poolAuthorized.value,
    outstanding: totals.value.totalOptions,
    available: poolAvailable.value,
    fds: poolAuthorized.value,
    kind: 'pool',
  })

  rows.push({
    label: 'Total fully diluted',
    authorized: null,
    outstanding: totals.value.totalShares,
    available: poolAvailable.value,
    fds: fdsIncludingPool.value,
    kind: 'total',
  })
  return rows
})

// ----- Share classes table (sortable + resizable) -----
// "Issued" + "Authorized" each unfold into up to 3 sub-columns
// (shares / % / $) depending on which units the user has toggled on.
interface ScCol { key: string; label: string; width: number; sortable: boolean; align: 'left' | 'right'; baseKey?: string; unit?: 'shares' | 'pct' | 'value' }

const shareClassCols = computed<ScCol[]>(() => {
  const cols: ScCol[] = [
    { key: 'code', label: 'Code', width: 90, sortable: true, align: 'left' },
    { key: 'name', label: 'Name', width: 220, sortable: true, align: 'left' },
    { key: 'kind', label: 'Kind', width: 100, sortable: true, align: 'left' },
  ]
  for (const u of scUnits.selected.value) {
    cols.push({
      key: `issued_${u}`, baseKey: 'issued', unit: u,
      label: `Issued${unitSuffix(u)}`, width: 130, sortable: true, align: 'right',
    })
  }
  for (const u of scUnits.selected.value) {
    cols.push({
      key: `authorized_${u}`, baseKey: 'authorized', unit: u,
      label: `Authorized${unitSuffix(u)}`, width: 130, sortable: true, align: 'right',
    })
  }
  cols.push({ key: 'issue_price', label: 'PPS', width: 110, sortable: true, align: 'right' })
  return cols
})

const shareClassTable = useSortableTable({
  key: 'capstack:cap-table:share-classes',
  defaultSort: { key: 'seniority', dir: 'asc' },
  columns: shareClassCols.value as any,
})

// Rebuild columns on toggle change, preserving any widths the user has adjusted.
watch(shareClassCols, (cols) => {
  const widthMap: Record<string, number> = {}
  for (const c of shareClassTable.cols) widthMap[c.key] = c.width
  const next = cols.map(c => ({ ...c, width: widthMap[c.key] ?? c.width }))
  shareClassTable.cols.splice(0, shareClassTable.cols.length, ...(next as any))
}, { immediate: true })

const sortedShareClasses = computed(() => {
  const rows = (data.value?.share_classes || []).map((sc: any) => ({
    ...sc,
    issued: totals.value.byClass[sc.id] || 0,
    seniority: sc.seniority || 0,
  }))
  const k = shareClassTable.sort.key
  const sign = shareClassTable.sort.dir === 'asc' ? 1 : -1
  // Unit-variant sort keys all collapse to the same underlying base value.
  const baseKey = k.startsWith('issued_') ? 'issued'
    : k.startsWith('authorized_') ? 'authorized'
    : k
  return [...rows].sort((a, b) => {
    const av = (a as any)[baseKey], bv = (b as any)[baseKey]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign
    return String(av).localeCompare(String(bv), 'en', { numeric: true }) * sign
  })
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

// ----- Convertibles ledger -----
const cnTable = useSortableTable({
  key: 'capstack:cap-table:convertibles',
  defaultSort: { key: 'total', dir: 'desc' },
  columns: [
    { key: 'stakeholder_name', label: 'Holder', width: 200, sortable: true, align: 'left' },
    { key: 'principal', label: 'Principal', width: 130, sortable: true, align: 'right' },
    { key: 'interest_accrued', label: 'Interest accrued', width: 150, sortable: true, align: 'right' },
    { key: 'total', label: 'Total', width: 130, sortable: true, align: 'right' },
    { key: 'interest_rate', label: 'Rate', width: 80, sortable: true, align: 'right' },
    { key: 'valuation_cap', label: 'Cap', width: 130, sortable: true, align: 'right' },
    { key: 'conversion_discount', label: 'Discount', width: 100, sortable: true, align: 'right' },
    { key: 'issue_date', label: 'Issued', width: 120, sortable: true, align: 'left' },
    { key: 'maturity_date', label: 'Matures', width: 120, sortable: true, align: 'left' },
    { key: 'converts_at_round', label: 'Converts at round?', width: 180, sortable: true, align: 'left' },
    { key: 'actions', label: '', width: 90, sortable: false, align: 'right' },
  ],
})
const sortedConvertibles = computed(() => {
  const rows = (data.value?.convertibles || []).map((c: any) => ({
    ...c,
    total: (c.principal || 0) + (c.interest_accrued || 0),
  }))
  return cnTable.applySort(rows)
})

// ----- Convertible-note CRUD -----
const cnModalOpen = ref(false)
const cnEditing = ref<Convertible | null>(null)
const cnSaving = ref(false)
const cnForm = reactive({
  stakeholder_name: '',
  principal: 0,
  interest_accrued: 0,
  interest_rate: 0.08,
  valuation_cap: null as number | null,
  conversion_discount: 0,
  issue_date: '',
  maturity_date: '',
  converts_at_round: true,
})

function resetCnForm() {
  cnForm.stakeholder_name = ''
  cnForm.principal = 0
  cnForm.interest_accrued = 0
  cnForm.interest_rate = 0.08
  cnForm.valuation_cap = null
  cnForm.conversion_discount = 0
  cnForm.issue_date = ''
  cnForm.maturity_date = ''
  cnForm.converts_at_round = true
  cnEditing.value = null
}

function openCnModal(cn?: Convertible) {
  if (cn) {
    cnEditing.value = cn
    cnForm.stakeholder_name = cn.stakeholder_name
    cnForm.principal = cn.principal
    cnForm.interest_accrued = cn.interest_accrued
    cnForm.interest_rate = cn.interest_rate
    cnForm.valuation_cap = cn.valuation_cap
    cnForm.conversion_discount = cn.conversion_discount
    cnForm.issue_date = cn.issue_date || ''
    cnForm.maturity_date = cn.maturity_date || ''
    cnForm.converts_at_round = !!cn.converts_at_round
  } else {
    resetCnForm()
  }
  cnModalOpen.value = true
}

async function saveCn() {
  if (cnSaving.value) return
  cnSaving.value = true
  try {
    if (cnEditing.value) {
      await $fetch(`/api/convertibles/${cnEditing.value.id}`, { method: 'PATCH', body: cnForm })
    } else {
      await $fetch(`/api/companies/${id.value}/convertibles`, { method: 'POST', body: cnForm })
    }
    cnModalOpen.value = false
    await refresh()
  } finally {
    cnSaving.value = false
  }
}

async function toggleConvertsAtRound(cn: Convertible) {
  const next = !cn.converts_at_round
  await $fetch(`/api/convertibles/${cn.id}`, { method: 'PATCH', body: { converts_at_round: next } })
  await refresh()
}

async function deleteCn(cn: Convertible) {
  if (!confirm(`Delete the ${cn.stakeholder_name} convertible (${fmtUSD(cn.principal)})?`)) return
  await $fetch(`/api/convertibles/${cn.id}`, { method: 'DELETE' })
  await refresh()
}

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
      <!-- Summary cap table — Carta-style rollup. One line per security, with
           Common / Preferred subtotals when more than one class exists in the
           group. Pool row shows authorized / outstanding (granted) / available.
           Total row sums FDS including unissued pool. -->
      <UiCard title="Summary cap table" subtitle="Rolled up by security — recreates the Carta Summary tab" :padded="false">
        <div class="overflow-x-auto">
          <table class="text-[13px] border-separate w-full" style="border-spacing: 0; table-layout: fixed;">
            <colgroup>
              <col style="width: 38%" />
              <col style="width: 14%" />
              <col style="width: 14%" />
              <col style="width: 13%" />
              <col style="width: 11%" />
              <col style="width: 10%" />
            </colgroup>
            <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide bg-ink-100">
              <tr>
                <th class="px-3 py-1.5 border-b border-ink-300 font-semibold">Security</th>
                <th class="px-3 py-1.5 border-b border-ink-300 font-semibold text-right">Authorized</th>
                <th class="px-3 py-1.5 border-b border-ink-300 font-semibold text-right">Outstanding</th>
                <th class="px-3 py-1.5 border-b border-ink-300 font-semibold text-right">Available</th>
                <th class="px-3 py-1.5 border-b border-ink-300 font-semibold text-right">FDS</th>
                <th class="px-3 py-1.5 border-b border-ink-300 font-semibold text-right">% FDS</th>
              </tr>
            </thead>
            <tbody class="num">
              <tr
                v-for="(r, i) in summaryRows"
                :key="i"
                :class="[
                  r.kind === 'total' ? 'bg-ink-100 font-semibold text-ink-900' : '',
                  (r.kind === 'common-subtotal' || r.kind === 'preferred-subtotal') ? 'bg-ink-100/60 italic text-ink-700' : '',
                  r.kind === 'pool' ? 'bg-amber-50/40' : '',
                  r.kind !== 'total' ? 'hover:bg-accent-50/30 transition-colors' : '',
                ]"
              >
                <td class="px-3 py-1.5 border-b border-ink-200 truncate" :title="r.label">{{ r.label }}</td>
                <td class="px-3 py-1.5 text-right text-ink-700 border-b border-ink-200">{{ r.authorized == null ? '—' : fmtShares(r.authorized) }}</td>
                <td class="px-3 py-1.5 text-right text-ink-700 border-b border-ink-200">{{ r.outstanding == null ? '—' : fmtShares(r.outstanding) }}</td>
                <td class="px-3 py-1.5 text-right text-ink-700 border-b border-ink-200">{{ r.available == null ? '—' : fmtShares(r.available) }}</td>
                <td class="px-3 py-1.5 text-right border-b border-ink-200" :class="r.kind === 'total' ? '' : 'font-medium text-ink-900'">{{ fmtShares(r.fds) }}</td>
                <td class="px-3 py-1.5 text-right border-b border-ink-200" :class="r.kind === 'total' ? '' : 'text-ink-600'">{{ fdsIncludingPool > 0 ? fmtPct(r.fds / fdsIncludingPool, 2) : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>

      <!-- Share classes — compact, collapsible (the holdings pivot is the main view). -->
      <UiCard :title="`Share classes (${data.share_classes.length})`" :padded="false">
        <template #header>
          <div class="flex items-center gap-2">
            <TableUnitsToggle v-if="scExpanded" storage-key="capstack:cap-table:share-classes:units" />
            <button
              type="button"
              class="text-xs text-ink-500 hover:text-ink-900 inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-ink-100"
              @click="scExpanded = !scExpanded"
            >
              <ChevronUp v-if="scExpanded" :size="12" />
              <ChevronDown v-else :size="12" />
              {{ scExpanded ? 'collapse' : 'expand' }}
            </button>
          </div>
        </template>
        <div v-if="scExpanded" class="overflow-x-auto">
          <table class="text-xs border-separate w-full" style="border-spacing: 0; table-layout: fixed;">
            <colgroup>
              <col v-for="c in shareClassTable.cols" :key="c.key" :style="{ width: c.width + 'px' }" />
            </colgroup>
            <thead class="text-left text-ink-500 text-[10px] uppercase tracking-wide bg-ink-100">
              <tr>
                <th
                  v-for="c in shareClassTable.cols"
                  :key="c.key"
                  class="relative px-2 py-1 border-b border-ink-300 select-none font-semibold"
                  :class="[c.align === 'right' ? 'text-right' : 'text-left', c.sortable ? 'cursor-pointer hover:text-ink-900' : '']"
                  @click="c.sortable ? shareClassTable.toggleSort(c.key) : null"
                >
                  <span class="inline-flex items-center gap-1" :class="c.align === 'right' ? 'flex-row-reverse' : ''">
                    {{ c.label }}
                    <ChevronUp v-if="sortIconFor(shareClassTable, c.key) === 'asc'" :size="11" class="text-accent-600" />
                    <ChevronDown v-if="sortIconFor(shareClassTable, c.key) === 'desc'" :size="11" class="text-accent-600" />
                  </span>
                  <span class="resize-handle" @mousedown.prevent.stop="shareClassTable.startResize($event, c.key)" @click.stop />
                </th>
              </tr>
            </thead>
            <tbody class="num">
              <tr v-for="sc in sortedShareClasses" :key="sc.id" class="hover:bg-accent-50/40 transition-colors">
                <template v-for="c in shareClassTable.cols" :key="c.key">
                  <td v-if="c.key === 'code'"  class="px-2 py-0.5 font-mono text-xs border-b border-ink-200 text-ink-800">{{ sc.code }}</td>
                  <td v-else-if="c.key === 'name'"  class="px-2 py-0.5 border-b border-ink-200 text-ink-900 truncate" :title="sc.name">{{ sc.name }}</td>
                  <td v-else-if="c.key === 'kind'"  class="px-2 py-0.5 text-[11px] uppercase tracking-wide text-ink-500 border-b border-ink-200">{{ sc.kind }}</td>
                  <td v-else-if="c.key === 'issue_price'"  class="px-2 py-0.5 text-right text-ink-600 border-b border-ink-200">{{ fmtPricePerShare(sc.issue_price) }}</td>
                  <td v-else-if="c.baseKey === 'issued'"  class="px-2 py-0.5 text-right border-b border-ink-200">{{ formatBy(c.unit!, sc.issued, fdsIncludingPool, sc.issue_price || currentPPS) }}</td>
                  <td v-else-if="c.baseKey === 'authorized'"  class="px-2 py-0.5 text-right text-ink-600 border-b border-ink-200">{{ sc.authorized ? formatBy(c.unit!, sc.authorized, fdsIncludingPool, sc.issue_price || currentPPS) : '—' }}</td>
                </template>
              </tr>
              <tr class="bg-ink-100/60 font-medium">
                <template v-for="(c, idx) in shareClassTable.cols" :key="c.key">
                  <td v-if="c.key === 'code'"  class="px-2 py-0.5 border-b border-ink-200 text-ink-700">Pool</td>
                  <td v-else-if="c.key === 'name'"  class="px-2 py-0.5 border-b border-ink-200 text-ink-700">Option pool authorized</td>
                  <td v-else-if="c.key === 'kind'"  class="px-2 py-0.5 border-b border-ink-200"></td>
                  <td v-else-if="c.key === 'issue_price'"  class="px-2 py-0.5 border-b border-ink-200"></td>
                  <td v-else-if="c.baseKey === 'issued'"  class="px-2 py-0.5 text-right border-b border-ink-200">
                    {{ formatBy(c.unit!, totals.totalOptions, fdsIncludingPool, currentPPS) }}<span class="text-[10px] text-ink-500 ml-1">attributed</span>
                  </td>
                  <td v-else-if="c.baseKey === 'authorized'"  class="px-2 py-0.5 text-right text-ink-600 border-b border-ink-200">{{ formatBy(c.unit!, poolAuthorized, fdsIncludingPool, currentPPS) }}</td>
                </template>
              </tr>
              <tr class="font-semibold bg-ink-100 text-ink-900">
                <template v-for="c in shareClassTable.cols" :key="c.key">
                  <td v-if="c.key === 'code'"  class="px-2 py-0.5">FDS</td>
                  <td v-else-if="c.key === 'name'"  class="px-2 py-0.5">Fully-diluted shares</td>
                  <td v-else-if="c.key === 'kind'"  class="px-2 py-0.5"></td>
                  <td v-else-if="c.key === 'issue_price'"  class="px-2 py-0.5"></td>
                  <td v-else-if="c.baseKey === 'issued'"  class="px-2 py-0.5 text-right">{{ formatBy(c.unit!, fdsIncludingPool, fdsIncludingPool, currentPPS) }}</td>
                  <td v-else-if="c.baseKey === 'authorized'"  class="px-2 py-0.5 text-right">—</td>
                </template>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>

      <!-- Stakeholder holdings -->
      <UiCard title="Stakeholder holdings" :subtitle="`${pivot.length} positions`" :padded="false">
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

      <!-- Convertible notes -->
      <UiCard title="Convertible notes" :subtitle="`${data.convertibles.length} outstanding — imported from Carta Convertible Notes sheet`" :padded="false">
        <template #header>
          <UiButton size="sm" variant="primary" @click="openCnModal()"><Plus :size="12" /> Add convertible</UiButton>
        </template>
        <div v-if="!data.convertibles.length" class="text-sm text-ink-500 px-4 py-6 text-center">
          No convertibles. Click "Add convertible" to enter a note manually (e.g. a bridge note bought between rounds).
        </div>
        <div v-else class="overflow-x-auto">
          <table class="text-[13px] border-separate w-full" style="border-spacing: 0; table-layout: fixed;">
            <colgroup>
              <col v-for="c in cnTable.cols" :key="c.key" :style="{ width: c.width + 'px' }" />
            </colgroup>
            <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide bg-ink-100">
              <tr>
                <th
                  v-for="c in cnTable.cols"
                  :key="c.key"
                  class="relative px-2.5 py-1.5 border-b border-ink-300 select-none font-semibold"
                  :class="[c.align === 'right' ? 'text-right' : 'text-left', c.sortable ? 'cursor-pointer hover:text-ink-900' : '']"
                  @click="c.sortable ? cnTable.toggleSort(c.key) : null"
                >
                  <span class="inline-flex items-center gap-1" :class="c.align === 'right' ? 'flex-row-reverse' : ''">
                    {{ c.label }}
                    <ChevronUp v-if="sortIconFor(cnTable, c.key) === 'asc'" :size="12" class="text-accent-600" />
                    <ChevronDown v-if="sortIconFor(cnTable, c.key) === 'desc'" :size="12" class="text-accent-600" />
                  </span>
                  <span class="resize-handle" @mousedown.prevent.stop="cnTable.startResize($event, c.key)" @click.stop />
                </th>
              </tr>
            </thead>
            <tbody class="num">
              <tr v-for="cn in sortedConvertibles" :key="cn.id" class="hover:bg-accent-50/40 transition-colors">
                <td class="px-2.5 py-1.5 font-medium text-ink-900 border-b border-ink-200 truncate" :title="cn.stakeholder_name">{{ cn.stakeholder_name }}</td>
                <td class="px-2.5 py-1.5 text-right border-b border-ink-200">{{ fmtUSD(cn.principal) }}</td>
                <td class="px-2.5 py-1.5 text-right text-ink-700 border-b border-ink-200">{{ fmtUSD(cn.interest_accrued) }}</td>
                <td class="px-2.5 py-1.5 text-right font-medium border-b border-ink-200 text-ink-900">{{ fmtUSD(cn.total) }}</td>
                <td class="px-2.5 py-1.5 text-right text-ink-700 border-b border-ink-200">{{ fmtPct(cn.interest_rate, 1) }}</td>
                <td class="px-2.5 py-1.5 text-right text-ink-700 border-b border-ink-200">{{ cn.valuation_cap ? fmtUSD(cn.valuation_cap) : '—' }}</td>
                <td class="px-2.5 py-1.5 text-right text-ink-700 border-b border-ink-200">{{ cn.conversion_discount ? fmtPct(cn.conversion_discount, 0) : '—' }}</td>
                <td class="px-2.5 py-1.5 text-ink-600 border-b border-ink-200">{{ fmtDate(cn.issue_date) }}</td>
                <td class="px-2.5 py-1.5 text-ink-600 border-b border-ink-200">{{ fmtDate(cn.maturity_date) }}</td>
                <td class="px-2.5 py-1.5 border-b border-ink-200">
                  <button
                    class="text-xs px-2 py-1 rounded-md border transition-colors font-medium"
                    :class="cn.converts_at_round ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100' : 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'"
                    @click="toggleConvertsAtRound(cn)"
                  >
                    {{ cn.converts_at_round ? 'Yes — converts now' : 'No — deferred' }}
                  </button>
                </td>
                <td class="px-2.5 py-1.5 text-right whitespace-nowrap border-b border-ink-200">
                  <button class="text-ink-500 hover:text-accent-600 px-1.5 py-1 rounded" @click="openCnModal(cn)" title="Edit"><Edit3 :size="14" /></button>
                  <button class="text-ink-500 hover:text-red-600 px-1.5 py-1 rounded" @click="deleteCn(cn)" title="Delete"><Trash2 :size="14" /></button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>

      <!-- Convertible create/edit modal -->
      <div v-if="cnModalOpen" class="fixed inset-0 z-40 bg-ink-900/40 backdrop-blur-sm grid place-items-center p-4" @click.self="cnModalOpen = false">
        <div class="w-full max-w-lg rounded-lg border border-ink-300 bg-white p-5 shadow-card-hover">
          <h2 class="text-base font-semibold text-ink-900">{{ cnEditing ? 'Edit convertible' : 'Add convertible' }}</h2>
          <p class="text-xs text-ink-500 mt-1">For bridge notes purchased outside of a Carta export, or notes that convert at a different time than the modelled round.</p>
          <div class="mt-4 grid grid-cols-2 gap-3">
            <UiInput v-model="cnForm.stakeholder_name" label="Holder name" placeholder="VCT Investments, Inc." class="col-span-2" />
            <UiInput v-model="cnForm.principal" type="number" label="Principal" prefix="$" step="1000" />
            <UiInput v-model="cnForm.interest_accrued" type="number" label="Interest accrued" prefix="$" step="1000" />
            <UiInput v-model="cnForm.interest_rate" type="number" label="Interest rate" suffix="%" step="0.5" hint="Decimal: 0.08 = 8%" />
            <UiInput v-model="cnForm.valuation_cap" type="number" label="Valuation cap" prefix="$" step="1000000" />
            <UiInput v-model="cnForm.conversion_discount" type="number" label="Conversion discount" suffix="%" step="0.05" hint="Decimal: 0.15 = 15%" />
            <UiInput v-model="cnForm.issue_date" type="date" label="Issue date" />
            <UiInput v-model="cnForm.maturity_date" type="date" label="Maturity date" />
            <label class="col-span-2 flex items-center gap-2 text-sm text-ink-800 mt-1 bg-ink-100 rounded p-3">
              <input type="checkbox" v-model="cnForm.converts_at_round" class="rounded border-ink-400 text-accent-500 focus:ring-accent-500" />
              <span><b>Converts at the modelled round.</b> Uncheck for a deferred note — won't add to post-round FDS; we'll still project its shares at the round PPS for reference.</span>
            </label>
          </div>
          <div class="mt-5 flex justify-end gap-2">
            <UiButton variant="ghost" @click="cnModalOpen = false">Cancel</UiButton>
            <UiButton variant="primary" :disabled="!cnForm.stakeholder_name?.trim() || !cnForm.principal || cnSaving" @click="saveCn">
              {{ cnSaving ? 'Saving…' : (cnEditing ? 'Update' : 'Add convertible') }}
            </UiButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
