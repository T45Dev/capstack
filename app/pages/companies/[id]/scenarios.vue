<script setup lang="ts">
// Spec §5.7 — Exit Scenarios.
// Three exit-value scenarios (Low / Mid / High) modeled as if the to-close
// round has closed. Page deliberately omits round math (it's covered on the
// Financings table); the only display is the per-stakeholder payout grid.
// Scenarios are identified by sequential numbers; the latest is editable
// in the same sense that all prior ones are append-only (no edit endpoint
// today — the lock is implicit). Older scenarios get a lock badge.
import { Plus, FlaskConical, Copy, Trash2, ChevronUp, ChevronDown, Lock } from 'lucide-vue-next'
import { fmtUSD, fmtPct, fmtShares, fmtDate } from '~/utils/format'
import { calcPct } from '~/utils/calc'

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
// Default a new scenario's pre/new money from the open round on the
// Financings table (was the now-deprecated Assumptions page).
const { data: roundSummary } = await useFetch<{ rounds: Array<{ kind: string; pre_money: number | null; new_money: number }> }>(() => `/api/companies/${id.value}/round-summary`, { watch: [id], default: () => ({ rounds: [] }) })
const openRound = computed(() => roundSummary.value?.rounds.find(r => r.kind === 'open') || null)

// Order scenarios oldest → newest so the sequential numbering reads "1 was
// first, 2 second…". The most recent scenario is editable; everything else
// gets a lock badge.
const orderedScenarios = computed<Scenario[]>(() => {
  const arr = scenarios.value || []
  return [...arr].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
})

function seqNumber(s: Scenario): number {
  return orderedScenarios.value.findIndex(x => x.id === s.id) + 1
}

function isLocked(s: Scenario): boolean {
  const arr = orderedScenarios.value
  return arr.length > 1 && arr[arr.length - 1]!.id !== s.id
}

function lmhValues(s: Scenario): [number, number, number] {
  try {
    const ev = s.exit_values ? JSON.parse(s.exit_values) : null
    if (Array.isArray(ev) && ev.length >= 3) return [ev[0], ev[1], ev[2]]
  } catch { /* ignore */ }
  return [0, 0, 0]
}

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
    form.new_money = openRound.value?.new_money || 0
    form.pre_money = openRound.value?.pre_money || 0
    form.pool_top_up_shares = 0
    form.exit_low = 100_000_000
    form.exit_mid = 250_000_000
    form.exit_high = 500_000_000
  }
  showCreate.value = true
}

const saving = ref(false)
async function create() {
  if (saving.value) return
  saving.value = true
  try {
    const nextNum = (scenarios.value?.length || 0) + 1
    const s = await $fetch<Scenario>(`/api/companies/${id.value}/scenarios`, {
      method: 'POST',
      body: {
        name: form.name?.trim() || `Scenario ${nextNum}`,
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
  if (!selected.value && arr?.length) selected.value = arr[0]?.id ?? null
}, { immediate: true })

const { data: result } = await useFetch(() => selected.value ? `/api/scenarios/${selected.value}/compute` : null, {
  method: 'POST',
  watch: [selected],
  default: () => null,
})

// Fixed payout columns: stakeholder, post-round FDS, post-%, invested,
// plus per-exit columns ($ + MOIC). The Invested + MOIC columns are the
// metrics the spreadsheet centers its analysis on — proceeds tell you
// what cash lands; MOIC tells you whether the round was worth doing.
interface PoutCol { key: string; label: string; sublabel?: string; width: number; sortable: boolean; align: 'left' | 'right'; exitIdx?: number; kind?: 'proceeds' | 'moic' }

const exitLabels = ['Low', 'Mid', 'High'] as const

const payoutCols = computed<PoutCol[]>(() => {
  const cols: PoutCol[] = [
    { key: 'name',       label: 'Stakeholder', width: 240, sortable: true, align: 'left' },
    { key: 'postShares', label: 'Post-FDS',    width: 130, sortable: true, align: 'right' },
    { key: 'postPct',    label: 'Post-%',      width: 90,  sortable: true, align: 'right' },
    { key: 'invested',   label: 'Invested',    width: 120, sortable: true, align: 'right' },
  ]
  const exits = result.value?.exitValues || []
  exits.slice(0, 3).forEach((ev: number, i: number) => {
    cols.push({
      key: `ev_${i}`,
      label: `$ ${exitLabels[i]}`,
      sublabel: fmtUSD(ev),
      exitIdx: i, kind: 'proceeds',
      width: 130, sortable: true, align: 'right',
    })
    cols.push({
      key: `moic_${i}`,
      label: `MOIC`,
      sublabel: exitLabels[i],
      exitIdx: i, kind: 'moic',
      width: 70, sortable: true, align: 'right',
    })
  })
  return cols
})

const payoutTable = useSortableTable({
  key: 'capstack:scenarios:payouts',
  defaultSort: { key: 'postShares', dir: 'desc' },
  columns: payoutCols.value as any,
})

watch(payoutCols, (cols) => {
  const widthMap: Record<string, number> = {}
  for (const c of payoutTable.cols) widthMap[c.key] = c.width
  const next = cols.map(c => ({ ...c, width: widthMap[c.key] ?? c.width }))
  payoutTable.cols.splice(0, payoutTable.cols.length, ...(next as any))
  if (!payoutTable.cols.find(c => c.key === payoutTable.sort.key)) payoutTable.sort.key = 'postShares'
}, { immediate: true })

const sortedPayouts = computed(() => {
  const rows = result.value?.dilution || []
  const k = payoutTable.sort.key
  const sign = payoutTable.sort.dir === 'asc' ? 1 : -1
  const evM = /^ev_(\d+)$/.exec(k)
  if (evM) {
    const idx = Number(evM[1])
    return [...rows].sort((a: any, b: any) => ((a.exits?.[idx] || 0) - (b.exits?.[idx] || 0)) * sign)
  }
  const moicM = /^moic_(\d+)$/.exec(k)
  if (moicM) {
    const idx = Number(moicM[1])
    return [...rows].sort((a: any, b: any) => {
      // null MOICs sort to the bottom (no invested capital → no return rate)
      const av = a.moic?.[idx] ?? -Infinity
      const bv = b.moic?.[idx] ?? -Infinity
      return (av - bv) * sign
    })
  }
  return [...rows].sort((a: any, b: any) => {
    const av = a[k] ?? 0
    const bv = b[k] ?? 0
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
        <h1 class="text-xl font-semibold tracking-tight text-ink-900">Exit Scenarios</h1>
        <p class="text-sm text-ink-600 mt-1">
          Three exit values (Low / Mid / High) modeled as if the to-close round has closed. Saving a new scenario locks the previous ones — they stay available read-only.
        </p>
      </div>
      <UiButton variant="primary" @click="startCreate()"><Plus :size="14" /> New scenario</UiButton>
    </div>

    <UiEmpty
      v-if="!scenarios?.length"
      title="No scenarios yet"
      description="Save a scenario to capture the current round inputs alongside Low / Mid / High exit values."
    >
      <UiButton variant="primary" @click="startCreate()"><Plus :size="14" /> Create scenario</UiButton>
    </UiEmpty>

    <div v-else class="grid grid-cols-12 gap-5">
      <!-- Scenario picker rail — sequential ID is the primary label, L/M/H
           values are subdued alongside. Lock badge on every scenario except
           the most recent (append-only locking per spec §5.7). -->
      <aside class="col-span-12 lg:col-span-3 space-y-2">
        <div class="text-[11px] font-semibold uppercase tracking-wider text-ink-500 mb-1 px-1">Saved scenarios</div>
        <button
          v-for="s in orderedScenarios"
          :key="s.id"
          class="group w-full text-left rounded-lg border p-3 transition-all"
          :class="selected === s.id ? 'border-brand-500 bg-brand-50 shadow-sm' : 'border-ink-300 bg-white hover:border-brand-300 hover:shadow-card'"
          @click="selected = s.id"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium text-ink-900 text-sm">Scenario {{ seqNumber(s) }}</span>
            <span
              v-if="isLocked(s)"
              class="inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wide text-ink-500 shrink-0"
              title="Locked — a newer scenario exists"
            ><Lock :size="10" /> locked</span>
          </div>
          <div class="mt-1 text-[11px] text-ink-500 num leading-relaxed">
            <span class="mr-2"><span class="text-ink-400">L</span> {{ fmtUSD(lmhValues(s)[0]) }}</span>
            <span class="mr-2"><span class="text-ink-400">M</span> {{ fmtUSD(lmhValues(s)[1]) }}</span>
            <span><span class="text-ink-400">H</span> {{ fmtUSD(lmhValues(s)[2]) }}</span>
          </div>
          <div class="mt-1 text-[10px] text-ink-500">{{ fmtDate(s.created_at) }}</div>
          <div class="mt-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <button class="text-[11px] text-ink-600 hover:text-brand-700 inline-flex items-center gap-1" @click.stop="startCreate(s)"><Copy :size="11" /> clone</button>
            <button class="text-[11px] text-ink-600 hover:text-red-600 inline-flex items-center gap-1" @click.stop="destroy(s)"><Trash2 :size="11" /> delete</button>
          </div>
        </button>
      </aside>

      <!-- Detail panel — payout grid only, no round-math display (spec §6:
           "don't show round math on Exit Scenarios"). -->
      <section class="col-span-12 lg:col-span-9 space-y-4">
        <div v-if="!result" class="rounded-md border border-ink-300 bg-white p-6 text-sm text-ink-500 text-center">Select a scenario to view results.</div>
        <template v-else>
          <div class="flex items-end gap-3 flex-wrap">
            <div>
              <h2 class="text-lg font-semibold text-ink-900 flex items-center gap-2">
                Scenario {{ seqNumber(result.scenario) }}
                <span v-if="isLocked(result.scenario)" class="inline-flex items-center gap-0.5 text-[10px] uppercase tracking-wide text-ink-500 font-normal" title="Locked — a newer scenario exists">
                  <Lock :size="11" /> locked
                </span>
              </h2>
              <p v-if="result.scenario.description" class="text-sm text-ink-600 mt-0.5">{{ result.scenario.description }}</p>
            </div>
            <div class="ml-auto text-[11px] text-ink-500 num">
              <span class="mr-2"><span class="text-ink-400">L</span> {{ fmtUSD(lmhValues(result.scenario)[0]) }}</span>
              <span class="mr-2"><span class="text-ink-400">M</span> {{ fmtUSD(lmhValues(result.scenario)[1]) }}</span>
              <span><span class="text-ink-400">H</span> {{ fmtUSD(lmhValues(result.scenario)[2]) }}</span>
            </div>
          </div>

          <div class="rounded-lg border border-ink-300 bg-white shadow-card overflow-hidden">
            <div class="overflow-x-auto table-scroll table-sticky-head">
              <table class="text-[13px] border-separate" :style="{ borderSpacing: 0, tableLayout: 'fixed', minWidth: payoutWidth + 'px' }">
                <colgroup>
                  <col v-for="c in payoutTable.cols" :key="c.key" :style="{ width: c.width + 'px' }" />
                </colgroup>
                <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide bg-ink-100">
                  <tr>
                    <th
                      v-for="c in payoutTable.cols"
                      :key="c.key"
                      class="relative px-2.5 py-1.5 border-b border-ink-300 select-none font-semibold bg-ink-100"
                      :class="[c.align === 'right' ? 'text-right' : 'text-left', c.sortable ? 'cursor-pointer hover:text-ink-900' : '']"
                      @click="c.sortable ? payoutTable.toggleSort(c.key) : null"
                    >
                      <span class="inline-flex items-center gap-1" :class="c.align === 'right' ? 'flex-row-reverse' : ''">
                        <span class="inline-flex flex-col" :class="c.align === 'right' ? 'items-end' : 'items-start'">
                          <span>{{ c.label }}</span>
                          <span v-if="c.sublabel" class="text-[9px] font-normal normal-case text-ink-400 num">{{ c.sublabel }}</span>
                        </span>
                        <ChevronUp v-if="sortIconFor(payoutTable, c.key) === 'asc'" :size="12" class="text-brand-600" />
                        <ChevronDown v-if="sortIconFor(payoutTable, c.key) === 'desc'" :size="12" class="text-brand-600" />
                      </span>
                      <span class="resize-handle" @mousedown.prevent.stop="payoutTable.startResize($event, c.key)" @click.stop />
                    </th>
                  </tr>
                </thead>
                <tbody class="num">
                  <tr
                    v-for="r in sortedPayouts"
                    :key="r.stakeholderId"
                    class="transition-colors"
                    :class="r.isIdea ? 'bg-amber-50/40 hover:bg-amber-50/70' : 'hover:bg-brand-50/40'"
                  >
                    <template v-for="c in payoutTable.cols" :key="c.key">
                      <td v-if="c.key === 'name'" class="px-2.5 py-1.5 font-medium text-ink-900 border-b border-ink-200 truncate" :title="r.name">
                        <span>{{ r.name }}</span>
                        <span
                          v-if="r.isIdea"
                          class="ml-1.5 inline-block text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-800 align-middle"
                          title="Hypothetical grant from the Option Pool Impact page"
                        >idea</span>
                      </td>
                      <td v-else-if="c.key === 'postShares'" class="px-2.5 py-1.5 text-right text-ink-900 font-medium border-b border-ink-200">{{ fmtShares(r.postShares) }}</td>
                      <td v-else-if="c.key === 'postPct'" class="px-2.5 py-1.5 text-right text-ink-700 border-b border-ink-200"><UiCalcTip :formula="result.round.postRoundFDS > 0 ? calcPct(r.postShares, result.round.postRoundFDS, 2) : null">{{ result.round.postRoundFDS > 0 ? fmtPct(r.postShares / result.round.postRoundFDS, 2) : '—' }}</UiCalcTip></td>
                      <td v-else-if="c.key === 'invested'" class="px-2.5 py-1.5 text-right border-b border-ink-200" :class="r.invested ? 'text-ink-700' : 'text-ink-400'">
                        {{ r.invested ? fmtUSD(r.invested) : '—' }}
                      </td>
                      <td v-else-if="c.kind === 'proceeds' && c.exitIdx != null" class="px-2.5 py-1.5 text-right border-b border-ink-200 text-ink-800">{{ fmtUSD(r.exits?.[c.exitIdx] || 0) }}</td>
                      <td v-else-if="c.kind === 'moic' && c.exitIdx != null" class="px-2.5 py-1.5 text-right border-b border-ink-200" :class="(r.moic?.[c.exitIdx] ?? null) == null ? 'text-ink-400' : (r.moic?.[c.exitIdx] ?? 0) >= 1 ? 'text-emerald-700 font-medium' : 'text-red-600 font-medium'">
                        <template v-if="(r.moic?.[c.exitIdx] ?? null) == null">—</template>
                        <template v-else>{{ (r.moic?.[c.exitIdx] ?? 0).toFixed(2) }}x</template>
                      </td>
                    </template>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </section>
    </div>

    <!-- Create modal — sequential ID is assigned automatically; description
         is the only user-facing label. -->
    <div v-if="showCreate" class="fixed inset-0 z-40 bg-ink-900/40 backdrop-blur-sm grid place-items-center p-4" @click.self="showCreate = false">
      <div class="w-full max-w-lg rounded-lg border border-ink-300 bg-white p-5 shadow-card-hover">
        <h2 class="text-base font-semibold text-ink-900">New scenario · Scenario {{ (scenarios?.length || 0) + 1 }}</h2>
        <p class="text-xs text-ink-500 mt-1">Once saved, the previous scenario is locked — it stays available for reference but you can't change its inputs.</p>
        <div class="mt-4 grid grid-cols-2 gap-3">
          <UiInput v-model="form.description" label="Description (optional)" placeholder="Bridge + 18.5M B" class="col-span-2" />
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
          <UiButton variant="primary" :disabled="saving" @click="create">
            <FlaskConical :size="14" /> {{ saving ? 'Creating…' : 'Create scenario' }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
