<script setup lang="ts">
import { Save, RefreshCw, RotateCcw, ChevronUp, ChevronDown, BookmarkPlus, History, Trash2, Upload, X } from 'lucide-vue-next'
import { fmtUSD, fmtPct, fmtShares, fmtPricePerShare, fmtDate } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

interface AssumptionsRow {
  company_id: string
  round_name: string
  new_money: number
  pre_money: number
  pre_round_fds: number | null
  target_pool_pct: number | null
  pool_top_up_shares: number
  cn_conversion_basis: 'best' | 'round_price' | 'cap' | 'discount'
  notes: string | null
}

interface AssumptionVersion {
  id: string
  label: string | null
  is_auto: number
  round_name: string
  new_money: number
  pre_money: number
  pre_round_fds: number | null
  pool_top_up_shares: number
  cn_conversion_basis: string
  notes: string | null
  created_at: string
}

const { data: assumptions } = await useFetch<AssumptionsRow>(() => `/api/companies/${id.value}/assumptions`, { watch: [id] })
const { data: versions, refresh: refreshVersions } = await useFetch<AssumptionVersion[]>(() => `/api/companies/${id.value}/assumption-versions`, { watch: [id], default: () => [] })

const form = reactive({
  round_name: 'Series B',
  new_money: 0,
  pre_money: 0,
  pre_round_fds: null as number | null,
  cn_conversion_basis: 'best' as 'best' | 'round_price' | 'cap' | 'discount',
  notes: '',
})

watch(assumptions, (a) => {
  if (!a) return
  form.round_name = a.round_name
  form.new_money = a.new_money
  form.pre_money = a.pre_money
  form.pre_round_fds = a.pre_round_fds
  form.cn_conversion_basis = a.cn_conversion_basis
  form.notes = a.notes || ''
}, { immediate: true })

const computeBody = computed(() => ({
  newMoney: form.new_money,
  preMoney: form.pre_money,
  preRoundFDS: form.pre_round_fds,
  cnBasis: form.cn_conversion_basis,
}))

const { data: compute, pending } = await useFetch(() => `/api/companies/${id.value}/compute`, {
  method: 'POST',
  body: computeBody,
  watch: [computeBody, id],
})

const fdsFromCapTable = computed(() => (compute.value?.capTableBaseline?.fdsFromCapTable || 0) as number)
const usingOverride = computed(() => form.pre_round_fds != null && form.pre_round_fds !== fdsFromCapTable.value)

function useComputedFDS() {
  form.pre_round_fds = fdsFromCapTable.value
}
function clearOverride() {
  form.pre_round_fds = null
}

const saving = ref(false)
const savedAt = ref<string | null>(null)
async function save() {
  saving.value = true
  try {
    await $fetch(`/api/companies/${id.value}/assumptions`, { method: 'POST', body: form })
    savedAt.value = new Date().toLocaleTimeString()
    await refreshVersions()
  } finally {
    saving.value = false
  }
}

// --- Versions ---
const showVersions = ref(false)
const namingSnapshot = ref(false)
const snapshotLabel = ref('')
async function snapshotNow() {
  if (!snapshotLabel.value.trim()) return
  await $fetch(`/api/companies/${id.value}/assumption-versions`, { method: 'POST', body: { label: snapshotLabel.value.trim() } })
  snapshotLabel.value = ''
  namingSnapshot.value = false
  await refreshVersions()
}
async function loadVersion(v: AssumptionVersion) {
  if (!confirm(`Load "${v.label || 'Auto-snapshot ' + fmtDate(v.created_at)}" into working assumptions? Your current values will be auto-snapshotted before replacement.`)) return
  await $fetch(`/api/assumption-versions/${v.id}/load`, { method: 'POST' })
  // Reload to pick up the new working assumptions everywhere on the page.
  location.reload()
}
async function deleteVersion(v: AssumptionVersion) {
  if (!confirm(`Delete this version? This is permanent.`)) return
  await $fetch(`/api/assumption-versions/${v.id}`, { method: 'DELETE' })
  await refreshVersions()
}

const seriesShortcuts = [
  'Pre-seed', 'Seed', 'Series Seed', 'Series A', 'Series A-1', 'Series A-2', 'Series A-3', 'Series A-4',
  'Series B', 'Series B-1', 'Series B-2', 'Series C', 'Series D', 'Bridge',
]

// ---------- Per-stakeholder dilution table ----------
// Pre / CN / Post each unfold into 1-3 sub-columns per the per-table toggle.
const dilUnits = useTableUnits('capstack:dilution:units')

interface DilCol { key: string; label: string; width: number; sortable: boolean; align: 'left' | 'right'; baseKey?: string; unit?: 'shares' | 'pct' | 'value' }

const dilutionCols = computed<DilCol[]>(() => {
  const cols: DilCol[] = [
    { key: 'name', label: 'Stakeholder', width: 260, sortable: true, align: 'left' },
  ]
  const groups: Array<{ base: string; label: string }> = [
    { base: 'preShares',  label: 'Pre' },
    { base: 'cnShares',   label: 'CN conv.' },
    { base: 'postShares', label: 'Post' },
  ]
  for (const g of groups) {
    for (const u of dilUnits.selected.value) {
      cols.push({
        key: `${g.base}_${u}`, baseKey: g.base, unit: u,
        label: `${g.label}${unitSuffix(u)}`,
        width: u === 'shares' ? 140 : 110, sortable: true, align: 'right',
      })
    }
  }
  cols.push({ key: 'delta', label: 'Δ %', width: 100, sortable: true, align: 'right' })
  return cols
})

const dilutionTable = useSortableTable({
  key: 'capstack:dilution',
  defaultSort: { key: 'postShares_shares', dir: 'desc' },
  columns: dilutionCols.value as any,
})

watch(dilutionCols, (cols) => {
  const widthMap: Record<string, number> = {}
  for (const c of dilutionTable.cols) widthMap[c.key] = c.width
  const next = cols.map(c => ({ ...c, width: widthMap[c.key] ?? c.width }))
  dilutionTable.cols.splice(0, dilutionTable.cols.length, ...(next as any))
  if (!dilutionTable.cols.find(c => c.key === dilutionTable.sort.key)) {
    dilutionTable.sort.key = 'postShares_shares'
  }
}, { immediate: true })

const sortedDilution = computed(() => {
  const rows = (compute.value?.dilution || []).map((r: any) => ({
    ...r,
    delta: r.postPct - r.prePct,
  }))
  const k = dilutionTable.sort.key
  const sign = dilutionTable.sort.dir === 'asc' ? 1 : -1
  const baseKey = k === 'name' || k === 'delta' ? k : k.replace(/_(shares|pct|value)$/, '')
  return [...rows].sort((a, b) => {
    const av = (a as any)[baseKey], bv = (b as any)[baseKey]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign
    return String(av).localeCompare(String(bv), 'en', { numeric: true }) * sign
  })
})

const dilutionWidth = computed(() => dilutionTable.cols.reduce((s, c) => s + c.width, 0))

// ---------- CN detail table ----------
const cnDetailUnits = useTableUnits('capstack:cn-detail:units')

interface CnCol { key: string; label: string; width: number; sortable: boolean; align: 'left' | 'right'; baseKey?: string; unit?: 'shares' | 'pct' | 'value' }

const cnDetailCols = computed<CnCol[]>(() => {
  const cols: CnCol[] = [
    { key: 'stakeholderName', label: 'Holder', width: 200, sortable: true, align: 'left' },
    { key: 'dollars', label: 'Dollars', width: 130, sortable: true, align: 'right' },
    { key: 'convPrice', label: 'Conv. price', width: 130, sortable: true, align: 'right' },
  ]
  for (const u of cnDetailUnits.selected.value) {
    cols.push({
      key: `shares_${u}`, baseKey: 'shares', unit: u,
      label: `Resulting${unitSuffix(u)}`,
      width: u === 'shares' ? 130 : 110, sortable: true, align: 'right',
    })
  }
  cols.push({ key: 'basisApplied', label: 'Basis', width: 100, sortable: true, align: 'left' })
  return cols
})

const cnDetailTable = useSortableTable({
  key: 'capstack:cn-detail',
  defaultSort: { key: 'shares_shares', dir: 'desc' },
  columns: cnDetailCols.value as any,
})

watch(cnDetailCols, (cols) => {
  const widthMap: Record<string, number> = {}
  for (const c of cnDetailTable.cols) widthMap[c.key] = c.width
  const next = cols.map(c => ({ ...c, width: widthMap[c.key] ?? c.width }))
  cnDetailTable.cols.splice(0, cnDetailTable.cols.length, ...(next as any))
  if (!cnDetailTable.cols.find(c => c.key === cnDetailTable.sort.key)) {
    cnDetailTable.sort.key = 'shares_shares'
  }
}, { immediate: true })

const sortedCnDetails = computed(() => {
  const rows = compute.value?.round?.cnDetails || []
  const k = cnDetailTable.sort.key
  const sign = cnDetailTable.sort.dir === 'asc' ? 1 : -1
  const baseKey = k.replace(/_(shares|pct|value)$/, '')
  return [...rows].sort((a: any, b: any) => {
    const av = a[baseKey], bv = b[baseKey]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign
    return String(av).localeCompare(String(bv), 'en', { numeric: true }) * sign
  })
})

function sortIconFor(table: ReturnType<typeof useSortableTable>, key: string) {
  if (table.sort.key !== key) return null
  return table.sort.dir
}
</script>

<template>
  <div v-if="assumptions">
    <div class="flex items-end justify-between mb-5 gap-3 flex-wrap">
      <div>
        <h1 class="text-xl font-semibold tracking-tight text-ink-900">Key assumptions</h1>
        <p class="text-sm text-ink-600 mt-1">
          Three primary inputs:
          <span class="text-ink-900 font-medium">pre-round FDS</span>,
          <span class="text-ink-900 font-medium">pre-money valuation</span>,
          <span class="text-ink-900 font-medium">amount raised</span>. Everything else is derived live.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <UiButton variant="ghost" @click="showVersions = true">
          <History :size="14" /> Versions
          <span v-if="versions?.length" class="ml-1 text-[10px] bg-ink-200 text-ink-700 px-1.5 py-0.5 rounded">{{ versions.length }}</span>
        </UiButton>
        <UiButton @click="namingSnapshot = true">
          <BookmarkPlus :size="14" /> Snapshot
        </UiButton>
        <UiButton variant="primary" :disabled="saving" @click="save">
          <Save :size="14" /> {{ saving ? 'Saving…' : 'Save' }}
        </UiButton>
      </div>
    </div>

    <!-- Inputs + Derived round math, side-by-side at wide widths -->
    <div class="grid grid-cols-1 xl:grid-cols-12 gap-5">
      <!-- Inputs column -->
      <section class="xl:col-span-5">
        <div class="rounded-lg border border-ink-300 bg-white shadow-card p-5">
          <div class="flex items-baseline justify-between mb-4">
            <h2 class="text-sm font-semibold text-ink-900">Inputs</h2>
            <p v-if="savedAt" class="text-xs text-emerald-600">Saved at {{ savedAt }}</p>
          </div>

          <div class="space-y-4">
            <div class="grid grid-cols-2 gap-3">
              <label class="block">
                <span class="block text-xs font-medium text-ink-700 mb-1">Round name</span>
                <select v-model="form.round_name" class="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500">
                  <option v-for="s in seriesShortcuts" :key="s" :value="s">{{ s }}</option>
                </select>
              </label>
              <label class="block">
                <span class="block text-xs font-medium text-ink-700 mb-1">CN conversion basis</span>
                <select v-model="form.cn_conversion_basis" class="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500">
                  <option value="best">Best for holder</option>
                  <option value="discount">Discount only</option>
                  <option value="cap">Cap only</option>
                  <option value="round_price">Round price</option>
                </select>
              </label>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <UiInput v-model="form.pre_money" type="number" label="Pre-money valuation" prefix="$" step="100000" />
              <UiInput v-model="form.new_money" type="number" label="New money (raise)" prefix="$" step="100000" />
            </div>

            <div>
              <UiInput
                v-model="form.pre_round_fds"
                type="number"
                label="Pre-round fully-diluted shares"
                step="1"
                hint="Holdings + outstanding options + available pool. Override if you're modelling a planned adjustment."
              />
              <div class="mt-1.5 flex items-center justify-between text-xs">
                <span class="text-ink-500">
                  From cap table:
                  <button type="button" class="text-accent-600 hover:text-accent-700 font-medium num" @click="useComputedFDS">
                    {{ fmtShares(fdsFromCapTable) }}
                  </button>
                </span>
                <button v-if="form.pre_round_fds != null" type="button"
                  class="text-ink-500 hover:text-ink-900 inline-flex items-center gap-1"
                  @click="clearOverride">
                  <RotateCcw :size="11" /> use computed
                </button>
              </div>
            </div>

            <label class="block">
              <span class="block text-xs font-medium text-ink-700 mb-1">Notes</span>
              <textarea v-model="form.notes" rows="3" class="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500" />
            </label>
          </div>
        </div>
      </section>

      <!-- Derived metrics + CN math column -->
      <section class="xl:col-span-7 space-y-5">
        <!-- Round math, flat stat strip — no card to make it feel like an output -->
        <div>
          <div class="flex items-center justify-between mb-2">
            <h2 class="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
              Derived round math
              <RefreshCw v-if="pending" :size="11" class="inline animate-spin text-ink-400 ml-1" />
            </h2>
          </div>
          <div v-if="compute" class="grid grid-cols-2 md:grid-cols-3 gap-3">
            <UiStat label="Price per share" :value="fmtPricePerShare(compute.round.pricePerShare)" emphasis />
            <UiStat label="Post-money" :value="fmtUSD(compute.round.postMoney)" emphasis />
            <UiStat label="Post-round FDS" :value="fmtShares(compute.round.postRoundFDS)" emphasis />
            <UiStat label="Pre-round FDS" :value="fmtShares(compute.round.preRoundFDS)" :hint="usingOverride ? 'override' : 'from cap table'" />
            <UiStat label="New preferred shares" :value="fmtShares(compute.round.newPreferredShares)" />
            <UiStat label="CN conversion shares" :value="fmtShares(compute.round.cnConvertedShares)" :hint="compute.round.cnConvertedDollars ? `from ${fmtUSD(compute.round.cnConvertedDollars)}` : ''" />
            <UiStat label="Valuation at post-FDS" :value="fmtUSD(compute.round.impliedPostFDSValuation)" hint="PPS × post-FDS (incl. CN dilution)" class="md:col-span-2" />
            <UiStat
              v-if="compute.round.deferred?.totalDollars"
              label="Deferred CN obligation"
              :value="fmtUSD(compute.round.deferred.totalDollars)"
              :hint="`${fmtShares(compute.round.deferred.projectedSharesAtRoundPPS)} at round PPS`"
              tone="warn"
            />
          </div>
        </div>

        <!-- Convertible-note conversion detail -->
        <div v-if="compute?.round.cnDetails?.length">
          <div class="flex items-center justify-between mb-2">
            <h2 class="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
              CN conversion detail
              <span class="text-ink-400 font-normal normal-case ml-1">— notes converting at this round</span>
            </h2>
            <TableUnitsToggle storage-key="capstack:cn-detail:units" />
          </div>
          <div class="rounded-lg border border-ink-300 bg-white shadow-card overflow-hidden">
            <div class="overflow-x-auto">
              <table class="w-full text-[13px] border-separate" style="border-spacing: 0; table-layout: fixed; min-width: 700px;">
                <colgroup>
                  <col v-for="c in cnDetailTable.cols" :key="c.key" :style="{ width: c.width + 'px' }" />
                </colgroup>
                <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide bg-ink-100">
                  <tr>
                    <th
                      v-for="c in cnDetailTable.cols"
                      :key="c.key"
                      class="relative px-2.5 py-1.5 border-b border-ink-300 select-none font-semibold"
                      :class="[c.align === 'right' ? 'text-right' : 'text-left', c.sortable ? 'cursor-pointer hover:text-ink-900' : '']"
                      @click="c.sortable ? cnDetailTable.toggleSort(c.key) : null"
                    >
                      <span class="inline-flex items-center gap-1" :class="c.align === 'right' ? 'flex-row-reverse' : ''">
                        {{ c.label }}
                        <ChevronUp v-if="sortIconFor(cnDetailTable, c.key) === 'asc'" :size="12" class="text-accent-600" />
                        <ChevronDown v-if="sortIconFor(cnDetailTable, c.key) === 'desc'" :size="12" class="text-accent-600" />
                      </span>
                      <span class="resize-handle" @mousedown.prevent.stop="cnDetailTable.startResize($event, c.key)" @click.stop />
                    </th>
                  </tr>
                </thead>
                <tbody class="num">
                  <tr v-for="d in sortedCnDetails" :key="d.id" class="hover:bg-accent-50/40 transition-colors">
                    <template v-for="c in cnDetailTable.cols" :key="c.key">
                      <td v-if="c.key === 'stakeholderName'" class="px-2.5 py-1.5 text-ink-900 border-b border-ink-200 truncate" :title="d.stakeholderName">{{ d.stakeholderName }}</td>
                      <td v-else-if="c.key === 'dollars'" class="px-2.5 py-1.5 text-right border-b border-ink-200">{{ fmtUSD(d.dollars) }}</td>
                      <td v-else-if="c.key === 'convPrice'" class="px-2.5 py-1.5 text-right text-ink-700 border-b border-ink-200">{{ fmtPricePerShare(d.convPrice) }}</td>
                      <td v-else-if="c.baseKey === 'shares'" class="px-2.5 py-1.5 text-right border-b border-ink-200">{{ formatBy(c.unit!, d.shares, compute.round.postRoundFDS, compute.round.pricePerShare) }}</td>
                      <td v-else-if="c.key === 'basisApplied'" class="px-2.5 py-1.5 text-[11px] uppercase tracking-wide border-b border-ink-200" :class="{
                        'text-emerald-700': d.basisApplied === 'discount',
                        'text-amber-700': d.basisApplied === 'cap',
                        'text-ink-600': d.basisApplied === 'round',
                      }">{{ d.basisApplied }}</td>
                    </template>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Deferred -->
        <div v-if="compute?.round.deferred?.details?.length">
          <h2 class="text-[11px] font-semibold uppercase tracking-wider text-ink-500 mb-2">
            Deferred CN obligations
            <span class="text-ink-400 font-normal normal-case ml-1">— projected at the round PPS ({{ fmtPricePerShare(compute.round.pricePerShare) }})</span>
          </h2>
          <div class="rounded-lg border border-amber-200 bg-amber-50/50 p-4">
            <table class="w-full text-sm">
              <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide">
                <tr>
                  <th class="px-2 py-1 font-semibold">Holder</th>
                  <th class="px-2 py-1 text-right font-semibold">Dollars</th>
                  <th class="px-2 py-1 text-right font-semibold">Projected shares</th>
                </tr>
              </thead>
              <tbody class="num">
                <tr v-for="d in compute.round.deferred.details" :key="d.id" class="border-t border-amber-200/60">
                  <td class="px-2 py-1.5 text-ink-900">{{ d.stakeholderName }}</td>
                  <td class="px-2 py-1.5 text-right">{{ fmtUSD(d.dollars) }}</td>
                  <td class="px-2 py-1.5 text-right">{{ fmtShares(d.shares) }}</td>
                </tr>
                <tr class="border-t-2 border-amber-300 font-semibold text-ink-900">
                  <td class="px-2 py-1.5">Total</td>
                  <td class="px-2 py-1.5 text-right">{{ fmtUSD(compute.round.deferred.totalDollars) }}</td>
                  <td class="px-2 py-1.5 text-right">{{ fmtShares(compute.round.deferred.projectedSharesAtRoundPPS) }}</td>
                </tr>
              </tbody>
            </table>
            <p class="mt-3 text-xs text-ink-600">
              Deferred notes do NOT add to post-round FDS or post-money. To include them as this-round conversions, flip "Converts at round?" on the
              <NuxtLink :to="`/companies/${id}/cap-table`" class="text-accent-600 hover:text-accent-700 font-medium">Cap table</NuxtLink> page.
            </p>
          </div>
        </div>

        <!-- Warnings -->
        <div v-if="compute?.round.warnings?.length" class="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-amber-700 mb-2">Warnings</h3>
          <ul class="space-y-1 text-sm text-amber-900 list-disc pl-5">
            <li v-for="(w, i) in compute.round.warnings" :key="i">{{ w }}</li>
          </ul>
        </div>
      </section>
    </div>

    <!-- Per-stakeholder dilution table — full width below -->
    <div v-if="compute?.dilution?.length" class="mt-6">
      <div class="flex items-center justify-between mb-2">
        <h2 class="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
          Per-stakeholder dilution
          <span class="text-ink-400 font-normal normal-case ml-1">— {{ compute.dilution.length }} stakeholders. Click headers to sort, drag edges to resize.</span>
        </h2>
        <TableUnitsToggle storage-key="capstack:dilution:units" />
      </div>
      <div class="rounded-lg border border-ink-300 bg-white shadow-card overflow-hidden">
        <div class="overflow-x-auto">
          <table class="text-[13px] border-separate" :style="{ borderSpacing: 0, tableLayout: 'fixed', minWidth: dilutionWidth + 'px' }">
            <colgroup>
              <col v-for="col in dilutionTable.cols" :key="col.key" :style="{ width: col.width + 'px' }" />
            </colgroup>
            <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide bg-ink-100">
              <tr>
                <th
                  v-for="col in dilutionTable.cols"
                  :key="col.key"
                  class="relative px-2.5 py-1.5 border-b border-ink-300 select-none font-semibold"
                  :class="[col.align === 'right' ? 'text-right' : 'text-left', col.sortable ? 'cursor-pointer hover:text-ink-900' : '']"
                  @click="col.sortable ? dilutionTable.toggleSort(col.key) : null"
                >
                  <span class="inline-flex items-center gap-1" :class="col.align === 'right' ? 'flex-row-reverse' : ''">
                    {{ col.label }}
                    <ChevronUp v-if="sortIconFor(dilutionTable, col.key) === 'asc'" :size="12" class="text-accent-600" />
                    <ChevronDown v-if="sortIconFor(dilutionTable, col.key) === 'desc'" :size="12" class="text-accent-600" />
                  </span>
                  <span class="resize-handle" @mousedown.prevent.stop="dilutionTable.startResize($event, col.key)" @click.stop />
                </th>
              </tr>
            </thead>
            <tbody class="num">
              <tr v-for="r in sortedDilution" :key="r.stakeholderId" class="hover:bg-accent-50/40 transition-colors">
                <template v-for="col in dilutionTable.cols" :key="col.key">
                  <td v-if="col.key === 'name'" class="px-2.5 py-1.5 font-medium text-ink-900 truncate border-b border-ink-200" :title="r.name">{{ r.name }}</td>
                  <td v-else-if="col.key === 'delta'" class="px-2.5 py-1.5 text-right border-b border-ink-200 font-medium" :class="r.delta < 0 ? 'text-red-600' : 'text-emerald-600'">
                    {{ (r.delta >= 0 ? '+' : '') + fmtPct(r.delta, 2) }}
                  </td>
                  <td v-else-if="col.baseKey === 'preShares'" class="px-2.5 py-1.5 text-right border-b border-ink-200">{{ formatBy(col.unit!, r.preShares, compute.round.preRoundFDS, compute.round.pricePerShare) }}</td>
                  <td v-else-if="col.baseKey === 'cnShares'" class="px-2.5 py-1.5 text-right border-b border-ink-200">{{ r.cnShares ? formatBy(col.unit!, r.cnShares, compute.round.postRoundFDS, compute.round.pricePerShare) : '—' }}</td>
                  <td v-else-if="col.baseKey === 'postShares'" class="px-2.5 py-1.5 text-right font-medium border-b border-ink-200 text-ink-900">{{ formatBy(col.unit!, r.postShares, compute.round.postRoundFDS, compute.round.pricePerShare) }}</td>
                </template>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Versions drawer -->
    <div v-if="showVersions" class="fixed inset-0 z-40 bg-ink-900/40 backdrop-blur-sm" @click.self="showVersions = false">
      <aside class="absolute right-0 top-0 h-full w-full max-w-md bg-white border-l border-ink-300 shadow-2xl overflow-y-auto">
        <div class="sticky top-0 bg-white border-b border-ink-200 p-4 flex items-center justify-between">
          <div>
            <h2 class="text-base font-semibold text-ink-900">Version history</h2>
            <p class="text-xs text-ink-500">Auto-snapshots happen when numeric inputs change. Named snapshots are explicit.</p>
          </div>
          <button class="p-1.5 hover:bg-ink-200 rounded" @click="showVersions = false"><X :size="16" /></button>
        </div>
        <div class="p-4">
          <div v-if="!versions?.length" class="text-sm text-ink-500 text-center py-8">No saved versions yet.</div>
          <ul v-else class="space-y-2">
            <li v-for="v in versions" :key="v.id" class="border border-ink-200 rounded-lg p-3 bg-white hover:border-accent-300 transition-colors">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span v-if="v.is_auto" class="text-[10px] uppercase tracking-wide text-ink-500 bg-ink-200 px-1.5 py-0.5 rounded">auto</span>
                    <span v-else class="text-[10px] uppercase tracking-wide text-accent-700 bg-accent-50 border border-accent-200 px-1.5 py-0.5 rounded">named</span>
                    <span class="text-sm font-medium text-ink-900 truncate">{{ v.label || fmtDate(v.created_at) }}</span>
                  </div>
                  <div class="mt-1 text-xs text-ink-500">{{ new Date(v.created_at).toLocaleString() }} · {{ v.round_name }}</div>
                  <div class="mt-2 grid grid-cols-3 gap-1 text-[11px] num text-ink-700">
                    <span>Pre {{ fmtUSD(v.pre_money) }}</span>
                    <span>Raise {{ fmtUSD(v.new_money) }}</span>
                    <span>FDS {{ v.pre_round_fds ? fmtShares(v.pre_round_fds) : 'auto' }}</span>
                  </div>
                </div>
                <div class="shrink-0 flex flex-col gap-1">
                  <button class="text-xs text-accent-600 hover:text-accent-700 inline-flex items-center gap-1 px-2 py-1 rounded border border-accent-300 hover:bg-accent-50" @click="loadVersion(v)">
                    <Upload :size="11" /> load
                  </button>
                  <button class="text-xs text-ink-500 hover:text-red-600 inline-flex items-center gap-1 px-2 py-1 rounded border border-ink-300 hover:border-red-300" @click="deleteVersion(v)">
                    <Trash2 :size="11" /> delete
                  </button>
                </div>
              </div>
            </li>
          </ul>
        </div>
      </aside>
    </div>

    <!-- Name snapshot dialog -->
    <div v-if="namingSnapshot" class="fixed inset-0 z-50 bg-ink-900/40 backdrop-blur-sm grid place-items-center p-4" @click.self="namingSnapshot = false">
      <div class="w-full max-w-md rounded-lg border border-ink-300 bg-white p-5 shadow-card-hover">
        <h2 class="text-base font-semibold text-ink-900">Name this snapshot</h2>
        <p class="text-xs text-ink-500 mt-1">Captures the current working assumptions with a label you'll remember.</p>
        <div class="mt-4">
          <UiInput v-model="snapshotLabel" label="Label" placeholder="Series B base case" />
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <UiButton variant="ghost" @click="namingSnapshot = false">Cancel</UiButton>
          <UiButton variant="primary" :disabled="!snapshotLabel.trim()" @click="snapshotNow">
            <BookmarkPlus :size="14" /> Save snapshot
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
