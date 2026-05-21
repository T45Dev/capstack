<script setup lang="ts">
import { Upload, Filter } from 'lucide-vue-next'
import { fmtShares, fmtPct, fmtUSD, fmtDate, fmtPricePerShare } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

interface ShareClassRow { id: string; code: string; name: string; kind: string; authorized: number | null; issue_price: number | null }
interface Stakeholder { id: string; name: string; type: string | null }
interface Holding { stakeholder_id: string; share_class_id: string; shares: number }
interface Grant { id: string; stakeholder_id: string | null; recipient_name: string; quantity: number; status: string }
interface Convertible { id: string; stakeholder_name: string; principal: number; interest_accrued: number; interest_rate: number; issue_date: string | null; maturity_date: string | null; valuation_cap: number | null; conversion_discount: number }

const { data } = await useFetch<{ share_classes: ShareClassRow[]; stakeholders: Stakeholder[]; holdings: Holding[]; grants: Grant[]; convertibles: Convertible[]; pools: any[] }>(() => `/api/companies/${id.value}/cap-table`, { watch: [id], default: () => ({ share_classes: [], stakeholders: [], holdings: [], grants: [], convertibles: [], pools: [] } as any) })

const query = ref('')

// Build pivoted rows: stakeholder × share class + outstanding options
interface PivotRow {
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
    map.set(s.id, { stakeholderId: s.id, name: s.name, totalShares: 0, optionShares: 0, fds: 0, byClass: {} })
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
    return arr.filter(r => r.name.toLowerCase().includes(q)).sort((a, b) => b.fds - a.fds)
  }
  return arr.sort((a, b) => b.fds - a.fds)
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
</script>

<template>
  <div v-if="data">
    <div class="flex items-end justify-between mb-4 gap-3">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight text-ink-100">Cap table</h1>
        <p class="text-sm text-ink-400 mt-1">Stakeholders × share classes. Sorted by fully-diluted size.</p>
      </div>
      <div class="flex items-center gap-2">
        <div class="relative">
          <Filter :size="12" class="absolute left-2 top-1/2 -translate-y-1/2 text-ink-500" />
          <input v-model="query" placeholder="Filter stakeholders…" class="rounded-md border border-ink-600 bg-ink-800 pl-7 pr-3 py-1.5 text-sm w-64" />
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

    <div v-else>
      <UiCard padded title="Share classes" :subtitle="`${data.share_classes.length} classes`">
        <div class="overflow-x-auto -mx-4">
          <table class="w-full text-sm">
            <thead class="text-left text-ink-400 text-xs uppercase tracking-wide">
              <tr class="border-b border-ink-700">
                <th class="px-4 py-2">Code</th>
                <th class="px-4 py-2">Name</th>
                <th class="px-4 py-2 text-right">Issued</th>
                <th class="px-4 py-2 text-right">Authorized</th>
                <th class="px-4 py-2 text-right">PPS</th>
                <th class="px-4 py-2 text-right">% FDS</th>
              </tr>
            </thead>
            <tbody class="num">
              <tr v-for="sc in data.share_classes" :key="sc.id" class="border-b border-ink-800/80">
                <td class="px-4 py-2 font-mono text-xs">{{ sc.code }}</td>
                <td class="px-4 py-2">{{ sc.name }} <span class="text-[10px] uppercase text-ink-500 ml-1">{{ sc.kind }}</span></td>
                <td class="px-4 py-2 text-right">{{ fmtShares(totals.byClass[sc.id] || 0) }}</td>
                <td class="px-4 py-2 text-right text-ink-400">{{ sc.authorized ? fmtShares(sc.authorized) : '—' }}</td>
                <td class="px-4 py-2 text-right text-ink-400">{{ fmtPricePerShare(sc.issue_price) }}</td>
                <td class="px-4 py-2 text-right text-ink-400">{{ fdsIncludingPool ? fmtPct((totals.byClass[sc.id] || 0) / fdsIncludingPool, 2) : '—' }}</td>
              </tr>
              <tr class="bg-ink-800/40 font-medium">
                <td class="px-4 py-2">Pool</td>
                <td class="px-4 py-2">Option pool authorized</td>
                <td class="px-4 py-2 text-right">{{ fmtShares(totals.totalOptions) }} <span class="text-xs text-ink-500">(attributed)</span></td>
                <td class="px-4 py-2 text-right text-ink-400">{{ fmtShares(poolAuthorized) }}</td>
                <td class="px-4 py-2 text-right text-ink-400">—</td>
                <td class="px-4 py-2 text-right text-ink-400">{{ fdsIncludingPool ? fmtPct((totals.totalOptions + poolAvailable) / fdsIncludingPool, 2) : '—' }}</td>
              </tr>
              <tr class="font-semibold">
                <td class="px-4 py-2"></td>
                <td class="px-4 py-2">Fully-diluted shares</td>
                <td class="px-4 py-2 text-right" colspan="3">{{ fmtShares(fdsIncludingPool) }}</td>
                <td class="px-4 py-2 text-right">{{ fmtPct(1, 0) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>

      <UiCard padded class="mt-4" title="Stakeholder holdings" :subtitle="`${pivot.length} positions`">
        <div class="overflow-x-auto -mx-4">
          <table class="w-full text-sm">
            <thead class="text-left text-ink-400 text-xs uppercase tracking-wide">
              <tr class="border-b border-ink-700">
                <th class="px-4 py-2 sticky left-0 bg-ink-800/60">Name</th>
                <th v-for="sc in data.share_classes" :key="sc.id" class="px-3 py-2 text-right">{{ sc.code }}</th>
                <th class="px-3 py-2 text-right">Options</th>
                <th class="px-3 py-2 text-right">FDS</th>
                <th class="px-3 py-2 text-right">% FDS</th>
              </tr>
            </thead>
            <tbody class="num">
              <tr v-for="r in pivot" :key="r.stakeholderId" class="border-b border-ink-800/80 hover:bg-ink-800/40">
                <td class="px-4 py-2 sticky left-0 bg-ink-900/95 font-medium text-ink-100">{{ r.name }}</td>
                <td v-for="sc in data.share_classes" :key="sc.id" class="px-3 py-2 text-right">
                  <span v-if="r.byClass[sc.id]">{{ fmtShares(r.byClass[sc.id]) }}</span>
                  <span v-else class="text-ink-600">—</span>
                </td>
                <td class="px-3 py-2 text-right">
                  <span v-if="r.optionShares">{{ fmtShares(r.optionShares) }}</span>
                  <span v-else class="text-ink-600">—</span>
                </td>
                <td class="px-3 py-2 text-right font-medium">{{ fmtShares(r.fds) }}</td>
                <td class="px-3 py-2 text-right">{{ fdsIncludingPool ? fmtPct(r.fds / fdsIncludingPool, 3) : '—' }}</td>
              </tr>
            </tbody>
            <tfoot class="text-ink-200 font-semibold num">
              <tr class="border-t border-ink-700 bg-ink-800/40">
                <td class="px-4 py-2 sticky left-0 bg-ink-800/60">Total</td>
                <td v-for="sc in data.share_classes" :key="sc.id" class="px-3 py-2 text-right">{{ fmtShares(totals.byClass[sc.id] || 0) }}</td>
                <td class="px-3 py-2 text-right">{{ fmtShares(totals.totalOptions) }}</td>
                <td class="px-3 py-2 text-right">{{ fmtShares(totals.fds) }}</td>
                <td class="px-3 py-2 text-right">{{ fdsIncludingPool ? fmtPct(totals.fds / fdsIncludingPool, 2) : '—' }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </UiCard>

      <UiCard v-if="data.convertibles.length" padded class="mt-4" title="Convertible notes" :subtitle="`${data.convertibles.length} outstanding`">
        <div class="overflow-x-auto -mx-4">
          <table class="w-full text-sm">
            <thead class="text-left text-ink-400 text-xs uppercase tracking-wide">
              <tr class="border-b border-ink-700">
                <th class="px-4 py-2">Holder</th>
                <th class="px-3 py-2 text-right">Principal</th>
                <th class="px-3 py-2 text-right">Interest accrued</th>
                <th class="px-3 py-2 text-right">Total</th>
                <th class="px-3 py-2 text-right">Rate</th>
                <th class="px-3 py-2 text-right">Cap</th>
                <th class="px-3 py-2 text-right">Discount</th>
                <th class="px-3 py-2">Issue</th>
                <th class="px-3 py-2">Maturity</th>
              </tr>
            </thead>
            <tbody class="num">
              <tr v-for="cn in data.convertibles" :key="cn.id" class="border-b border-ink-800/80">
                <td class="px-4 py-2 font-medium text-ink-100">{{ cn.stakeholder_name }}</td>
                <td class="px-3 py-2 text-right">{{ fmtUSD(cn.principal) }}</td>
                <td class="px-3 py-2 text-right text-ink-300">{{ fmtUSD(cn.interest_accrued) }}</td>
                <td class="px-3 py-2 text-right font-medium">{{ fmtUSD(cn.principal + cn.interest_accrued) }}</td>
                <td class="px-3 py-2 text-right text-ink-300">{{ fmtPct(cn.interest_rate, 1) }}</td>
                <td class="px-3 py-2 text-right text-ink-300">{{ cn.valuation_cap ? fmtUSD(cn.valuation_cap) : '—' }}</td>
                <td class="px-3 py-2 text-right text-ink-300">{{ cn.conversion_discount ? fmtPct(cn.conversion_discount, 0) : '—' }}</td>
                <td class="px-3 py-2 text-ink-400">{{ fmtDate(cn.issue_date) }}</td>
                <td class="px-3 py-2 text-ink-400">{{ fmtDate(cn.maturity_date) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>
    </div>
  </div>
</template>
