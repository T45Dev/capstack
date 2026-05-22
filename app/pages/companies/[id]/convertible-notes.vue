<script setup lang="ts">
// Spec §5.3 — Convertible Notes page.
// Recreates the Carta Convertible Ledger, slimmed to the 7 columns the spec
// calls out (Holder, Destination, Conv. Date, Principal, Interest, Conv.
// Price, Resulting Shares). Notes feed the Assumptions page's round math:
// `destination_class_code` decides whether the resulting shares count as
// pre or new for the to-close round; `conversion_date` fixes the interest
// accrual window (and therefore the share count). Rows without a conversion
// date are flagged "incomplete" inline — same convention the user already
// asked for on the Assumptions block.
import { ChevronUp, ChevronDown } from 'lucide-vue-next'
import { fmtUSD, fmtShares, fmtPricePerShare, normalizeDate } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

const { data: assumptions } = await useFetch(() => `/api/companies/${id.value}/assumptions`, { watch: [id] })

// Drive compute off the stored assumption values so this page can render
// independently of Assumptions. Body is null because we want the saved row.
const computeBody = computed(() => ({}))
const { data: compute, refresh: refreshCompute } = await useFetch(() => `/api/companies/${id.value}/compute`, {
  method: 'POST',
  body: computeBody,
  watch: [id],
})

const cnUnits = useTableUnits('capstack:cn-detail:units')

interface CnCol { key: string; label: string; width: number; sortable: boolean; align: 'left' | 'right'; baseKey?: string; unit?: 'shares' | 'pct' | 'value' }

const cnCols = computed<CnCol[]>(() => {
  const cols: CnCol[] = [
    { key: 'stakeholderName',      label: 'Holder',      width: 200, sortable: true, align: 'left' },
    { key: 'destinationClassCode', label: 'Destination', width: 110, sortable: true, align: 'left' },
    { key: 'conversionDate',       label: 'Conv. date',  width: 150, sortable: true, align: 'left' },
    { key: 'principal',            label: 'Principal',   width: 130, sortable: true, align: 'right' },
    { key: 'interestAccrued',      label: 'Interest',    width: 120, sortable: true, align: 'right' },
    { key: 'convPrice',            label: 'Conv. price', width: 120, sortable: true, align: 'right' },
  ]
  for (const u of cnUnits.selected.value) {
    cols.push({
      key: `shares_${u}`, baseKey: 'shares', unit: u,
      label: `Resulting${unitSuffix(u)}`,
      width: u === 'shares' ? 140 : 110, sortable: true, align: 'right',
    })
  }
  return cols
})

const cnTable = useSortableTable({
  key: 'capstack:cn-detail',
  defaultSort: { key: 'shares_shares', dir: 'desc' },
  columns: cnCols.value as any,
})

watch(cnCols, (cols) => {
  const widthMap: Record<string, number> = {}
  for (const c of cnTable.cols) widthMap[c.key] = c.width
  const next = cols.map(c => ({ ...c, width: widthMap[c.key] ?? c.width }))
  cnTable.cols.splice(0, cnTable.cols.length, ...(next as any))
  if (!cnTable.cols.find(c => c.key === cnTable.sort.key)) cnTable.sort.key = 'shares_shares'
}, { immediate: true })

const sortedRows = computed(() => {
  const converting = compute.value?.round?.cnDetails || []
  const deferred = compute.value?.round?.deferred?.details || []
  const rows = [...converting, ...deferred]
  const k = cnTable.sort.key
  const sign = cnTable.sort.dir === 'asc' ? 1 : -1
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

// Edits write straight back to the convertible. Setting a conversion date
// also flips converts_at_round so the note moves from "incomplete" to
// "converting" on the next compute pass.
async function updateConvDate(cnId: string, value: string) {
  await $fetch(`/api/convertibles/${cnId}`, {
    method: 'PATCH',
    body: { conversion_date: value || null, converts_at_round: !!value },
  })
  await refreshCompute()
}

function sortIconFor(key: string) {
  if (cnTable.sort.key !== key) return null
  return cnTable.sort.dir
}
</script>

<template>
  <div>
    <div class="flex items-end justify-between mb-4 gap-3 flex-wrap">
      <div>
        <h1 class="text-xl font-semibold tracking-tight text-ink-900">Convertible Notes</h1>
        <p class="text-sm text-ink-600 mt-1">
          Holder, destination class, conversion date, principal, interest, conversion price, and resulting shares. Edits feed the
          <NuxtLink :to="`/companies/${id}/assumptions`" class="text-accent-600 hover:text-accent-700 font-medium">Assumptions</NuxtLink>
          round math.
        </p>
      </div>
      <TableUnitsToggle storage-key="capstack:cn-detail:units" />
    </div>

    <div v-if="!sortedRows.length" class="rounded-lg border border-dashed border-ink-300 bg-white p-8 text-center text-ink-500 text-sm">
      No convertible notes on file. Re-import the Carta export from
      <NuxtLink :to="`/companies/${id}/import`" class="text-accent-600 hover:text-accent-700 font-medium">Import Carta</NuxtLink>
      if you expected some.
    </div>

    <div v-else class="rounded-lg border border-ink-300 bg-white shadow-card overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-[13px] border-separate" :style="{ borderSpacing: 0, tableLayout: 'fixed', minWidth: '960px' }">
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
                  <ChevronUp v-if="sortIconFor(c.key) === 'asc'" :size="12" class="text-accent-600" />
                  <ChevronDown v-if="sortIconFor(c.key) === 'desc'" :size="12" class="text-accent-600" />
                </span>
                <span class="resize-handle" @mousedown.prevent.stop="cnTable.startResize($event, c.key)" @click.stop />
              </th>
            </tr>
          </thead>
          <tbody class="num">
            <tr
              v-for="d in sortedRows"
              :key="d.id"
              :class="d.basisApplied === 'deferred' ? 'bg-amber-50 hover:bg-amber-100/60' : 'hover:bg-accent-50/40'"
            >
              <template v-for="c in cnTable.cols" :key="c.key">
                <td v-if="c.key === 'stakeholderName'" class="px-2.5 py-1 text-ink-900 border-b border-ink-200 truncate" :title="d.stakeholderName">
                  <span>{{ d.stakeholderName }}</span>
                  <span
                    v-if="d.basisApplied === 'deferred'"
                    class="ml-1.5 inline-block text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border border-amber-300 bg-amber-100 text-amber-800 align-middle"
                    title="No conversion date — note hasn't been assigned to a round yet."
                  >incomplete</span>
                </td>
                <td v-else-if="c.key === 'destinationClassCode'" class="px-2.5 py-1 border-b border-ink-200">
                  <span v-if="d.destinationClassCode" class="text-xs font-mono text-ink-800 bg-ink-100 px-1.5 py-0.5 rounded">{{ d.destinationClassCode }}</span>
                  <span v-else class="text-ink-400">—</span>
                </td>
                <td v-else-if="c.key === 'conversionDate'" class="px-1.5 py-1 border-b border-ink-200">
                  <input
                    type="date"
                    :value="d.conversionDate || ''"
                    class="w-full rounded border px-1.5 py-0.5 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-accent-500"
                    :class="d.conversionDate ? 'border-ink-300 bg-white' : 'border-amber-400 bg-white'"
                    :title="d.conversionDate ? '' : 'No conversion date — set one to accrue interest and convert this round'"
                    @change="updateConvDate(d.id, normalizeDate(($event.target as HTMLInputElement).value))"
                  />
                </td>
                <td v-else-if="c.key === 'principal'" class="px-2.5 py-1 text-right text-ink-700 border-b border-ink-200">{{ fmtUSD(d.principal) }}</td>
                <td v-else-if="c.key === 'interestAccrued'" class="px-2.5 py-1 text-right text-ink-700 border-b border-ink-200">{{ fmtUSD(d.interestAccrued) }}</td>
                <td v-else-if="c.key === 'convPrice'" class="px-2.5 py-1 text-right text-ink-700 border-b border-ink-200">{{ fmtPricePerShare(d.convPrice) }}</td>
                <td v-else-if="c.baseKey === 'shares'" class="px-2.5 py-1 text-right border-b border-ink-200">{{ formatBy(c.unit!, d.shares, compute?.round?.postRoundFDS || 0, compute?.round?.pricePerShare || 0) }}</td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="compute?.round?.deferred?.totalDollars" class="px-4 py-2 text-xs text-ink-600 bg-amber-50/40 border-t border-amber-200/60">
        Incomplete notes total {{ fmtUSD(compute.round.deferred.totalDollars) }} / {{ fmtShares(compute.round.deferred.projectedSharesAtRoundPPS) }} projected shares at round PPS. They do NOT add to post-round FDS or post-money until a conversion date is set.
      </p>
    </div>
  </div>
</template>
