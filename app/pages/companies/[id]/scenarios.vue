<script setup lang="ts">
import { Plus, FlaskConical, Copy, Trash2, ChevronUp, ChevronDown } from 'lucide-vue-next'
import { fmtUSD, fmtPct, fmtShares, fmtPricePerShare, fmtDate } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

interface Scenario {
  id: string
  name: string
  description: string | null
  round_name: string
  new_money: number
  pre_money: number
  pool_top_up_shares: number
  exit_values: string | null
  created_at: string
}

const { data: scenarios, refresh } = await useFetch<Scenario[]>(() => `/api/companies/${id.value}/scenarios`, { watch: [id], default: () => [] })
const { data: assumptions } = await useFetch(() => `/api/companies/${id.value}/assumptions`, { watch: [id] })

const payoutUnits = useTableUnits('capstack:scenarios:payouts:units')

const showCreate = ref(false)
const form = reactive({
  name: '',
  description: '',
  new_money: 0,
  pre_money: 0,
  pool_top_up_shares: 0,
  exit_low: 100_000_000,
  exit_mid: 250_000_000,
  exit_high: 500_000_000,
})

function startCreate(cloneFrom?: Scenario) {
  if (cloneFrom) {
    form.name = `${cloneFrom.name} (copy)`
    form.description = cloneFrom.description || ''
    form.new_money = cloneFrom.new_money
    form.pre_money = cloneFrom.pre_money
    form.pool_top_up_shares = cloneFrom.pool_top_up_shares
    const ev = (() => { try { return cloneFrom.exit_values ? JSON.parse(cloneFrom.exit_values) : null } catch { return null } })()
    if (Array.isArray(ev) && ev.length >= 3) {
      form.exit_low = ev[0]
      form.exit_mid = ev[1]
      form.exit_high = ev[2]
    }
  } else {
    form.name = `Scenario ${(scenarios.value?.length || 0) + 1}`
    form.description = ''
    form.new_money = (assumptions.value as any)?.new_money || 0
    form.pre_money = (assumptions.value as any)?.pre_money || 0
    form.pool_top_up_shares = (assumptions.value as any)?.pool_top_up_shares || 0
    form.exit_low = 100_000_000
    form.exit_mid = 250_000_000
    form.exit_high = 500_000_000
  }
  showCreate.value = true
}

const saving = ref(false)
async function create() {
  if (!form.name.trim() || saving.value) return
  saving.value = true
  try {
    const s = await $fetch<Scenario>(`/api/companies/${id.value}/scenarios`, {
      method: 'POST',
      body: {
        name: form.name,
        description: form.description,
        new_money: form.new_money,
        pre_money: form.pre_money,
        pool_top_up_shares: form.pool_top_up_shares,
        exit_values: [form.exit_low, form.exit_mid, form.exit_high],
      },
    })
    showCreate.value = false
    await refresh()
    selected.value = s.id
  } finally {
    saving.value = false
  }
}

async function destroy(s: Scenario) {
  if (!confirm(`Delete scenario "${s.name}"?`)) return
  await $fetch(`/api/scenarios/${s.id}`, { method: 'DELETE' })
  if (selected.value === s.id) selected.value = null
  await refresh()
}

const selected = ref<string | null>(null)
watch(scenarios, (arr) => {
  if (!selected.value && arr?.length) selected.value = arr[0].id
}, { immediate: true })

const { data: result } = await useFetch(() => selected.value ? `/api/scenarios/${selected.value}/compute` : null, {
  method: 'POST',
  watch: [selected],
  default: () => null,
})

// Sortable exit-payout table — Post shares unfolds per per-table toggle.
interface PoutCol { key: string; label: string; width: number; sortable: boolean; align: 'left' | 'right'; baseKey?: string; unit?: 'shares' | 'pct' | 'value'; exitIdx?: number }

const payoutCols = computed<PoutCol[]>(() => {
  const cols: PoutCol[] = [
    { key: 'name', label: 'Stakeholder', width: 220, sortable: true, align: 'left' },
  ]
  for (const u of payoutUnits.selected.value) {
    cols.push({
      key: `postShares_${u}`, baseKey: 'postShares', unit: u,
      label: `Post${unitSuffix(u)}`,
      width: u === 'shares' ? 140 : 110, sortable: true, align: 'right',
    })
  }
  const exits = result.value?.exitValues || []
  exits.forEach((ev: number, i: number) => {
    cols.push({ key: `ev_${i}`, exitIdx: i, label: `Exit @ ${fmtUSD(ev)}`, width: 160, sortable: true, align: 'right' })
  })
  return cols
})

const payoutTable = useSortableTable({
  key: 'capstack:scenarios:payouts',
  defaultSort: { key: 'postShares_shares', dir: 'desc' },
  columns: payoutCols.value as any,
})

watch(payoutCols, (cols) => {
  const widthMap: Record<string, number> = {}
  for (const c of payoutTable.cols) widthMap[c.key] = c.width
  const next = cols.map(c => ({ ...c, width: widthMap[c.key] ?? c.width }))
  payoutTable.cols.splice(0, payoutTable.cols.length, ...(next as any))
  if (!payoutTable.cols.find(c => c.key === payoutTable.sort.key)) payoutTable.sort.key = 'postShares_shares'
}, { immediate: true })

const sortedPayouts = computed(() => {
  const rows = result.value?.dilution || []
  const k = payoutTable.sort.key
  const sign = payoutTable.sort.dir === 'asc' ? 1 : -1
  const m = /^ev_(\d+)$/.exec(k)
  if (m) {
    const idx = Number(m[1])
    return [...rows].sort((a: any, b: any) => ((a.exits?.[idx] || 0) - (b.exits?.[idx] || 0)) * sign)
  }
  const baseKey = k === 'name' ? 'name' : k.replace(/_(shares|pct|value)$/, '')
  return [...rows].sort((a: any, b: any) => {
    const av = a[baseKey] ?? 0
    const bv = b[baseKey] ?? 0
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign
    return String(av).localeCompare(String(bv), 'en', { numeric: true }) * sign
  })
})

function sortIconFor(table: ReturnType<typeof useSortableTable>, key: string) {
  if (table.sort.key !== key) return null
  return table.sort.dir
}

const payoutWidth = computed(() => payoutTable.cols.reduce((s, c) => s + c.width, 0))
</script>

<template>
  <div>
    <div class="flex items-end justify-between mb-5 gap-3 flex-wrap">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight text-ink-900">Scenarios</h1>
        <p class="text-sm text-ink-600 mt-1">Clone the current cap table state and vary raise / pre-money / pool. Compare exit payouts side-by-side.</p>
      </div>
      <UiButton variant="primary" @click="startCreate()"><Plus :size="14" /> New scenario</UiButton>
    </div>

    <UiEmpty
      v-if="!scenarios?.length"
      title="No scenarios yet"
      description="Scenarios are immutable what-ifs: change the raise, pre-money, or pool top-up and see how it changes dilution and exit payouts."
    >
      <UiButton variant="primary" @click="startCreate()"><Plus :size="14" /> Create scenario</UiButton>
    </UiEmpty>

    <div v-else class="grid grid-cols-12 gap-5">
      <!-- Scenario picker rail -->
      <aside class="col-span-12 lg:col-span-3 space-y-2">
        <div class="text-[11px] font-semibold uppercase tracking-wider text-ink-500 mb-1 px-1">Saved scenarios</div>
        <button
          v-for="s in scenarios"
          :key="s.id"
          class="group w-full text-left rounded-lg border p-3 transition-all"
          :class="selected === s.id ? 'border-accent-500 bg-accent-50 shadow-sm' : 'border-ink-300 bg-white hover:border-accent-300 hover:shadow-card'"
          @click="selected = s.id"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium text-ink-900 text-sm truncate">{{ s.name }}</span>
            <span class="text-[10px] uppercase tracking-wide text-ink-500 shrink-0">{{ s.round_name }}</span>
          </div>
          <div class="mt-1 grid grid-cols-2 gap-1 text-[11px] text-ink-600 num">
            <span>Raise {{ fmtUSD(s.new_money) }}</span>
            <span>Pre {{ fmtUSD(s.pre_money) }}</span>
          </div>
          <div class="mt-1 text-[10px] text-ink-500">{{ fmtDate(s.created_at) }}</div>
          <div class="mt-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <button class="text-[11px] text-ink-600 hover:text-accent-700 inline-flex items-center gap-1" @click.stop="startCreate(s)"><Copy :size="11" /> clone</button>
            <button class="text-[11px] text-ink-600 hover:text-red-600 inline-flex items-center gap-1" @click.stop="destroy(s)"><Trash2 :size="11" /> delete</button>
          </div>
        </button>
      </aside>

      <!-- Detail panel -->
      <section class="col-span-12 lg:col-span-9 space-y-5">
        <div v-if="!result" class="rounded-md border border-ink-300 bg-white p-6 text-sm text-ink-500 text-center">Select a scenario to view results.</div>
        <template v-else>
          <!-- Header strip: name + description -->
          <div>
            <h2 class="text-lg font-semibold text-ink-900">{{ result.scenario.name }}</h2>
            <p v-if="result.scenario.description" class="text-sm text-ink-600 mt-0.5">{{ result.scenario.description }}</p>
          </div>

          <!-- Round metrics — flat stat grid -->
          <div>
            <h3 class="text-[11px] font-semibold uppercase tracking-wider text-ink-500 mb-2">Round math</h3>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
              <UiStat label="Pre-money" :value="fmtUSD(result.round.preMoney)" />
              <UiStat label="New money" :value="fmtUSD(result.round.newMoney)" />
              <UiStat label="Post-money" :value="fmtUSD(result.round.postMoney)" emphasis />
              <UiStat label="Round PPS" :value="fmtPricePerShare(result.round.pricePerShare)" emphasis />
              <UiStat label="Pre-round FDS" :value="fmtShares(result.round.preRoundFDS)" />
              <UiStat label="Pool top-up" :value="fmtShares(result.round.newPoolShares)" />
              <UiStat label="New preferred" :value="fmtShares(result.round.newPreferredShares)" />
              <UiStat label="Post-round FDS" :value="fmtShares(result.round.postRoundFDS)" emphasis />
            </div>
          </div>

          <!-- Exit payout table -->
          <div>
            <div class="flex items-center justify-between mb-2">
              <h3 class="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                Exit payouts
                <span class="text-ink-400 font-normal normal-case ml-1">— per stakeholder, by exit valuation. Click headers to sort, drag edges to resize.</span>
              </h3>
              <TableUnitsToggle storage-key="capstack:scenarios:payouts:units" />
            </div>
            <div class="rounded-lg border border-ink-300 bg-white shadow-card overflow-hidden">
              <div class="overflow-x-auto">
                <table class="text-sm border-separate" :style="{ borderSpacing: 0, tableLayout: 'fixed', minWidth: payoutWidth + 'px' }">
                  <colgroup>
                    <col v-for="c in payoutTable.cols" :key="c.key" :style="{ width: c.width + 'px' }" />
                  </colgroup>
                  <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide bg-ink-100">
                    <tr>
                      <th
                        v-for="c in payoutTable.cols"
                        :key="c.key"
                        class="relative px-3 py-2 border-b border-ink-300 select-none font-semibold"
                        :class="[c.align === 'right' ? 'text-right' : 'text-left', c.sortable ? 'cursor-pointer hover:text-ink-900' : '']"
                        @click="c.sortable ? payoutTable.toggleSort(c.key) : null"
                      >
                        <span class="inline-flex items-center gap-1" :class="c.align === 'right' ? 'flex-row-reverse' : ''">
                          {{ c.label }}
                          <ChevronUp v-if="sortIconFor(payoutTable, c.key) === 'asc'" :size="12" class="text-accent-600" />
                          <ChevronDown v-if="sortIconFor(payoutTable, c.key) === 'desc'" :size="12" class="text-accent-600" />
                        </span>
                        <span class="resize-handle" @mousedown.prevent.stop="payoutTable.startResize($event, c.key)" @click.stop />
                      </th>
                    </tr>
                  </thead>
                  <tbody class="num">
                    <tr v-for="r in sortedPayouts" :key="r.stakeholderId" class="hover:bg-accent-50/40 transition-colors">
                      <template v-for="c in payoutTable.cols" :key="c.key">
                        <td v-if="c.key === 'name'" class="px-3 py-2 font-medium text-ink-900 border-b border-ink-200 truncate" :title="r.name">{{ r.name }}</td>
                        <td v-else-if="c.baseKey === 'postShares'" class="px-3 py-2 text-right border-b border-ink-200">{{ formatBy(c.unit!, r.postShares, result.round.postRoundFDS, result.round.pricePerShare) }}</td>
                        <td v-else-if="c.exitIdx != null" class="px-3 py-2 text-right border-b border-ink-200 text-ink-800">{{ fmtUSD(r.exits?.[c.exitIdx] || 0) }}</td>
                      </template>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </template>
      </section>
    </div>

    <!-- Create modal -->
    <div v-if="showCreate" class="fixed inset-0 z-40 bg-ink-900/40 backdrop-blur-sm grid place-items-center p-4" @click.self="showCreate = false">
      <div class="w-full max-w-lg rounded-lg border border-ink-300 bg-white p-5 shadow-card-hover">
        <h2 class="text-base font-semibold text-ink-900">New scenario</h2>
        <div class="mt-4 grid grid-cols-2 gap-3">
          <UiInput v-model="form.name" label="Name" placeholder="Bridge + 18.5M B" class="col-span-2" />
          <UiInput v-model="form.description" label="Description" class="col-span-2" />
          <UiInput v-model="form.pre_money" type="number" label="Pre-money" prefix="$" step="100000" />
          <UiInput v-model="form.new_money" type="number" label="New money" prefix="$" step="100000" />
          <UiInput v-model="form.pool_top_up_shares" type="number" label="Pool top-up shares" class="col-span-2" />
          <div class="col-span-2 grid grid-cols-3 gap-2">
            <UiInput v-model="form.exit_low" type="number" label="Exit (low)" prefix="$" step="10000000" />
            <UiInput v-model="form.exit_mid" type="number" label="Exit (mid)" prefix="$" step="10000000" />
            <UiInput v-model="form.exit_high" type="number" label="Exit (high)" prefix="$" step="10000000" />
          </div>
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <UiButton variant="ghost" @click="showCreate = false">Cancel</UiButton>
          <UiButton variant="primary" :disabled="!form.name.trim() || saving" @click="create">
            <FlaskConical :size="14" /> {{ saving ? 'Creating…' : 'Create scenario' }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
