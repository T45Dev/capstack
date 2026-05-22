<script setup lang="ts">
// Spec §5.5 — Overall Dilution page.
// Every stakeholder × (Pre / Post / Δ) for each of Shares / % / $.
// Layout rule: keep Shares cols adjacent, % cols adjacent, $ cols adjacent —
// don't interleave units. Δ cells are color-coded (red negative, green
// positive) so the dilution direction reads at a glance.
//
// Data comes from /compute (already returns preShares, postShares, prePct,
// postPct per stakeholder). $ values use the round PPS — i.e. Pre $ =
// preShares × PPS, Post $ = postShares × PPS — same convention as the
// other pages.
import { ChevronUp, ChevronDown } from 'lucide-vue-next'
import { fmtUSD, fmtPct, fmtShares } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

const computeBody = computed(() => ({}))
const { data: compute } = await useFetch(() => `/api/companies/${id.value}/compute`, {
  method: 'POST',
  body: computeBody,
  watch: [id],
})

const units = useTableUnits('capstack:dilution:units')

interface DilCol {
  key: string
  label: string
  width: number
  sortable: boolean
  align: 'left' | 'right'
  unit?: 'shares' | 'pct' | 'value'
  bucket?: 'pre' | 'post' | 'delta'
  groupEnd?: boolean
}

const widthFor = (unit: 'shares' | 'pct' | 'value', bucket: 'pre' | 'post' | 'delta') => {
  if (unit === 'shares') return bucket === 'delta' ? 120 : 130
  if (unit === 'pct')    return bucket === 'delta' ? 100 : 90
  return bucket === 'delta' ? 120 : 110
}

const cols = computed<DilCol[]>(() => {
  const out: DilCol[] = [
    { key: 'name', label: 'Stakeholder', width: 220, sortable: true, align: 'left' },
  ]
  const selected = units.selected.value
  selected.forEach((u, ui) => {
    const suffix = unitSuffix(u)
    const isLast = ui === selected.length - 1
    out.push({ key: `pre_${u}`,   label: `Pre${suffix}`,   width: widthFor(u, 'pre'),   sortable: true, align: 'right', unit: u, bucket: 'pre' })
    out.push({ key: `post_${u}`,  label: `Post${suffix}`,  width: widthFor(u, 'post'),  sortable: true, align: 'right', unit: u, bucket: 'post' })
    out.push({ key: `delta_${u}`, label: `Δ${suffix}`,     width: widthFor(u, 'delta'), sortable: true, align: 'right', unit: u, bucket: 'delta', groupEnd: !isLast })
  })
  return out
})

const table = useSortableTable({
  key: 'capstack:dilution',
  defaultSort: { key: 'post_shares', dir: 'desc' },
  columns: cols.value as any,
})

watch(cols, (next) => {
  const widthMap: Record<string, number> = {}
  for (const c of table.cols) widthMap[c.key] = c.width
  const merged = next.map(c => ({ ...c, width: widthMap[c.key] ?? c.width }))
  table.cols.splice(0, table.cols.length, ...(merged as any))
  if (!table.cols.find(c => c.key === table.sort.key)) {
    const fb = table.cols.find(c => c.key.startsWith('post_'))?.key || 'name'
    table.sort.key = fb
  }
}, { immediate: true })

const totalWidth = computed(() => table.cols.reduce((s, c) => s + c.width, 0))

interface DilRow {
  stakeholderId: string
  name: string
  pre_shares: number
  post_shares: number
  delta_shares: number
  pre_pct: number
  post_pct: number
  delta_pct: number
  pre_value: number
  post_value: number
  delta_value: number
}

const rows = computed<DilRow[]>(() => {
  const r = compute.value?.round
  const pps = r?.pricePerShare || 0
  const list = (compute.value?.dilution || []) as any[]
  return list.map(d => ({
    stakeholderId: d.stakeholderId,
    name:          d.name,
    pre_shares:    d.preShares,
    post_shares:   d.postShares,
    delta_shares:  d.postShares - d.preShares,
    pre_pct:       d.prePct,
    post_pct:      d.postPct,
    delta_pct:     d.postPct - d.prePct,
    pre_value:     d.preShares  * pps,
    post_value:    d.postShares * pps,
    delta_value:  (d.postShares - d.preShares) * pps,
  }))
})

const sortedRows = computed(() => {
  const k = table.sort.key
  const sign = table.sort.dir === 'asc' ? 1 : -1
  return [...rows.value].sort((a, b) => {
    const av = (a as any)[k], bv = (b as any)[k]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign
    return String(av).localeCompare(String(bv), 'en', { numeric: true }) * sign
  })
})

function fmtCell(unit: 'shares' | 'pct' | 'value', n: number): string {
  if (n == null || !isFinite(n)) return '—'
  if (unit === 'shares') return fmtShares(n)
  if (unit === 'pct')    return fmtPct(n, 2)
  return fmtUSD(n)
}

function fmtDelta(unit: 'shares' | 'pct' | 'value', n: number): string {
  if (n == null || !isFinite(n)) return '—'
  if (n === 0) return unit === 'pct' ? '0.00%' : unit === 'shares' ? '0' : '$0'
  const sign = n > 0 ? '+' : ''
  if (unit === 'shares') return sign + fmtShares(n)
  if (unit === 'pct')    return sign + fmtPct(n, 2)
  return sign + fmtUSD(n)
}

function sortIconFor(key: string) {
  if (table.sort.key !== key) return null
  return table.sort.dir
}
</script>

<template>
  <div>
    <div class="flex items-end justify-between mb-4 gap-3 flex-wrap">
      <div>
        <h1 class="text-xl font-semibold tracking-tight text-ink-900">Overall Dilution</h1>
        <p class="text-sm text-ink-600 mt-1">
          Every stakeholder · Pre / Post / Δ for Shares, %, and $. Round inputs live on the
          <NuxtLink :to="`/companies/${id}/assumptions`" class="text-accent-600 hover:text-accent-700 font-medium">Assumptions</NuxtLink>
          page.
        </p>
      </div>
      <TableUnitsToggle storage-key="capstack:dilution:units" />
    </div>

    <div v-if="!sortedRows.length" class="rounded-lg border border-dashed border-ink-300 bg-white p-8 text-center text-ink-500 text-sm">
      No stakeholders yet. Import the Carta export from
      <NuxtLink :to="`/companies/${id}/import`" class="text-accent-600 hover:text-accent-700 font-medium">Import Carta</NuxtLink>
      to populate this page.
    </div>

    <div v-else class="rounded-lg border border-ink-300 bg-white shadow-card overflow-hidden">
      <div class="overflow-x-auto">
        <table class="text-[13px] border-separate" :style="{ borderSpacing: 0, tableLayout: 'fixed', minWidth: totalWidth + 'px' }">
          <colgroup>
            <col v-for="c in table.cols" :key="c.key" :style="{ width: c.width + 'px' }" />
          </colgroup>
          <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide bg-ink-100">
            <tr>
              <th
                v-for="c in table.cols"
                :key="c.key"
                class="relative px-2.5 py-1.5 border-b border-ink-300 select-none font-semibold"
                :class="[
                  c.align === 'right' ? 'text-right' : 'text-left',
                  c.sortable ? 'cursor-pointer hover:text-ink-900' : '',
                  c.groupEnd ? 'border-r border-ink-300' : '',
                ]"
                @click="c.sortable ? table.toggleSort(c.key) : null"
              >
                <span class="inline-flex items-center gap-1" :class="c.align === 'right' ? 'flex-row-reverse' : ''">
                  {{ c.label }}
                  <ChevronUp v-if="sortIconFor(c.key) === 'asc'" :size="12" class="text-accent-600" />
                  <ChevronDown v-if="sortIconFor(c.key) === 'desc'" :size="12" class="text-accent-600" />
                </span>
                <span class="resize-handle" @mousedown.prevent.stop="table.startResize($event, c.key)" @click.stop />
              </th>
            </tr>
          </thead>
          <tbody class="num">
            <tr v-for="r in sortedRows" :key="r.stakeholderId" class="hover:bg-accent-50/40 transition-colors">
              <template v-for="c in table.cols" :key="c.key">
                <td
                  v-if="c.key === 'name'"
                  class="px-2.5 py-1.5 font-medium text-ink-900 truncate border-b border-ink-200"
                  :title="r.name"
                >{{ r.name }}</td>
                <td
                  v-else-if="c.bucket === 'delta'"
                  class="px-2.5 py-1.5 text-right border-b border-ink-200 font-medium"
                  :class="[
                    (r as any)[c.key] > 0 ? 'text-emerald-600' : (r as any)[c.key] < 0 ? 'text-red-600' : 'text-ink-400',
                    c.groupEnd ? 'border-r border-ink-200' : '',
                  ]"
                >{{ fmtDelta(c.unit!, (r as any)[c.key]) }}</td>
                <td
                  v-else
                  class="px-2.5 py-1.5 text-right border-b border-ink-200"
                  :class="[
                    c.bucket === 'post' ? 'text-ink-900 font-medium' : 'text-ink-700',
                    c.groupEnd ? 'border-r border-ink-200' : '',
                  ]"
                >{{ fmtCell(c.unit!, (r as any)[c.key]) }}</td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
