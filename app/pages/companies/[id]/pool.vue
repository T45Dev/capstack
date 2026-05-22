<script setup lang="ts">
// Option Pool Impact — chronological timeline of every event that increases
// or decreases the available option pool. Combines real data from the cap
// table (option-pool authorisations + outstanding/proposed grants) with
// user-entered "Ideas" (future hypothetical grants or pool top-ups).
//
//   Modes:
//   - "single-event"  -> each grant reduces the pool fully on its issue date.
//   - "vest-schedule" -> each grant reduces the pool month-by-month as shares
//                        vest (1/vest_months after the cliff, lump-sum at the
//                        cliff date).
import { Plus, Trash2, Edit3, ChevronUp, ChevronDown, Lightbulb, TrendingUp, TrendingDown as ArrowDownIcon, X } from 'lucide-vue-next'
import { fmtShares, fmtPct, fmtUSD, fmtDate } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

const { data: capTable } = await useFetch(() => `/api/companies/${id.value}/cap-table`, { watch: [id], default: () => null as any })
const { data: grantsData } = await useFetch(() => `/api/companies/${id.value}/grants`, { watch: [id], default: () => ({ grants: [], pools: [] } as any) })
const { data: ideas, refresh: refreshIdeas } = await useFetch<any[]>(() => `/api/companies/${id.value}/pool-events`, { watch: [id], default: () => [] })

const mode = ref<'single' | 'vest'>('single')

// ---- Reference values ----
const currentPPS = computed(() => capTable.value?.current_pps || 0)
const fdsIncludingPool = computed(() => {
  if (!capTable.value) return 0
  const heldShares = (capTable.value.holdings || []).reduce((a: number, h: any) => a + (h.shares || 0), 0)
  const outstanding = (capTable.value.grants || []).filter((g: any) => g.status === 'outstanding').reduce((a: number, g: any) => a + g.quantity, 0)
  const poolAuthorized = (grantsData.value?.pools || []).reduce((a: number, p: any) => a + (p.authorized || 0), 0)
  return heldShares + outstanding + poolAuthorized
})

// ---- Build the unified timeline ----
interface TimelineEvent {
  id: string
  date: string                 // ISO yyyy-mm-dd
  name: string
  type: 'pool_topup' | 'grant'
  kind: 'ISO' | 'NSO' | null
  shares: number               // unsigned magnitude
  direction: 1 | -1            // +1 adds to pool, -1 subtracts
  source: 'pool' | 'grant_outstanding' | 'grant_proposed' | 'idea'
  ideaId?: string              // pool_events.id when source === 'idea'
  grantId?: string             // grants.id when source === grant_*
  vestMonths?: number
  cliffMonths?: number
}

const events = computed<TimelineEvent[]>(() => {
  const out: TimelineEvent[] = []

  // Pool top-ups (option_pools rows). adopted_date may be null for legacy.
  for (const p of (grantsData.value?.pools || [])) {
    out.push({
      id: `pool:${p.id}`, date: p.adopted_date || '1970-01-01', name: p.name || 'Option pool',
      type: 'pool_topup', kind: null, shares: p.authorized || 0, direction: 1, source: 'pool',
    })
  }

  // Existing grants: outstanding + proposed
  for (const g of (grantsData.value?.grants || [])) {
    if (g.status !== 'outstanding' && g.status !== 'proposed') continue
    out.push({
      id: `grant:${g.id}`,
      date: g.issue_date || g.vesting_start || '1970-01-01',
      name: g.recipient_name,
      type: 'grant',
      kind: (g.recipient_type || '').toLowerCase() === 'employee' ? 'ISO' : 'NSO',
      shares: g.quantity || 0,
      direction: -1,
      source: g.status === 'outstanding' ? 'grant_outstanding' : 'grant_proposed',
      grantId: g.id,
      vestMonths: g.vest_months ?? 48,
      cliffMonths: g.cliff_months ?? 12,
    })
  }

  // Ideas
  for (const ie of (ideas.value || [])) {
    out.push({
      id: `idea:${ie.id}`,
      date: ie.event_date,
      name: ie.name,
      type: ie.type,
      kind: ie.kind,
      shares: ie.shares,
      direction: ie.type === 'pool_topup' ? 1 : -1,
      source: 'idea',
      ideaId: ie.id,
      vestMonths: ie.vest_months ?? 48,
      cliffMonths: ie.cliff_months ?? 12,
    })
  }

  out.sort((a, b) => a.date.localeCompare(b.date))
  return out
})

// Running balance in "single-event" mode — easy.
const eventsWithRunning = computed(() => {
  let running = 0
  return events.value.map(e => {
    running += e.direction * e.shares
    return { ...e, running }
  })
})

// Chart points. Honours the vest-vs-single mode toggle.
//   Each chart point = { t: ISO date, balance: pool shares available at that t }.
// For "vest" mode we expand each grant into monthly vest reductions starting
// from (issue_date + cliff_months) — at the cliff the cliffed portion vests
// in one chunk, then 1/vest_months per month onwards.
function addMonths(iso: string, n: number): string {
  if (!iso) return iso
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  d.setUTCMonth(d.getUTCMonth() + n)
  return d.toISOString().slice(0, 10)
}

interface ChartPoint { t: string; balance: number; label?: string }
const chartPoints = computed<ChartPoint[]>(() => {
  type Delta = { t: string; d: number; label?: string }
  const deltas: Delta[] = []
  for (const e of events.value) {
    if (mode.value === 'single' || e.type === 'pool_topup') {
      deltas.push({ t: e.date, d: e.direction * e.shares, label: e.name })
      continue
    }
    // vest mode for grants
    const vm = e.vestMonths || 0
    const cm = e.cliffMonths || 0
    const total = e.shares
    if (!vm || vm <= 0) {
      deltas.push({ t: e.date, d: -total, label: e.name })
      continue
    }
    if (cm > 0) {
      const cliffShares = Math.round(total * (cm / vm))
      deltas.push({ t: addMonths(e.date, cm), d: -cliffShares, label: `${e.name} (cliff)` })
      const remaining = total - cliffShares
      const monthsLeft = Math.max(0, vm - cm)
      if (monthsLeft > 0) {
        const perMonth = remaining / monthsLeft
        for (let i = 1; i <= monthsLeft; i++) {
          deltas.push({ t: addMonths(e.date, cm + i), d: -perMonth })
        }
      }
    } else {
      // no cliff — straight monthly 1/vm
      const perMonth = total / vm
      for (let i = 1; i <= vm; i++) {
        deltas.push({ t: addMonths(e.date, i), d: -perMonth })
      }
    }
  }
  deltas.sort((a, b) => a.t.localeCompare(b.t))
  let running = 0
  const points: ChartPoint[] = []
  for (const dlt of deltas) {
    running += dlt.d
    points.push({ t: dlt.t, balance: running, label: dlt.label })
  }
  return points
})

// ---- Top stat values ----
const totals = computed(() => {
  const poolAuthorized = events.value.filter(e => e.type === 'pool_topup' && e.source !== 'idea').reduce((a, e) => a + e.shares, 0)
  const outstandingShares = events.value.filter(e => e.source === 'grant_outstanding').reduce((a, e) => a + e.shares, 0)
  const proposedShares = events.value.filter(e => e.source === 'grant_proposed').reduce((a, e) => a + e.shares, 0)
  const ideaGrants = events.value.filter(e => e.source === 'idea' && e.type === 'grant').reduce((a, e) => a + e.shares, 0)
  const ideaTopups = events.value.filter(e => e.source === 'idea' && e.type === 'pool_topup').reduce((a, e) => a + e.shares, 0)
  const available = poolAuthorized - outstandingShares - proposedShares
  const projectedEnd = poolAuthorized + ideaTopups - outstandingShares - proposedShares - ideaGrants
  return { poolAuthorized, outstandingShares, proposedShares, ideaGrants, ideaTopups, available, projectedEnd }
})

// ---- Idea modal ----
const showModal = ref(false)
const editingIdea = ref<any>(null)
type InputMode = 'shares' | 'pct' | 'value'
const inputMode = ref<InputMode>('shares')
const form = reactive({
  event_date: new Date().toISOString().slice(0, 10),
  type: 'grant' as 'grant' | 'pool_topup',
  name: '',
  kind: 'NSO' as 'ISO' | 'NSO',
  shares: 0,
  pct: 0,
  value: 0,
  vest_months: 48,
  cliff_months: 12,
  notes: '',
})

// Two-way conversion among shares / % / $.
//   shares = pct × fds   = value / pps
//   pct    = shares/fds  = value / (pps × fds)
//   value  = shares × pps = pct × pps × fds
function syncFromShares() {
  const fds = fdsIncludingPool.value
  const pps = currentPPS.value
  form.pct = fds > 0 ? form.shares / fds : 0
  form.value = pps > 0 ? form.shares * pps : 0
}
function syncFromPct() {
  const fds = fdsIncludingPool.value
  const pps = currentPPS.value
  form.shares = Math.round(form.pct * fds)
  form.value = pps > 0 ? form.shares * pps : 0
}
function syncFromValue() {
  const pps = currentPPS.value
  const fds = fdsIncludingPool.value
  form.shares = pps > 0 ? Math.round(form.value / pps) : 0
  form.pct = fds > 0 ? form.shares / fds : 0
}

watch(() => form.shares, () => { if (inputMode.value === 'shares') syncFromShares() })
watch(() => form.pct,    () => { if (inputMode.value === 'pct')    syncFromPct() })
watch(() => form.value,  () => { if (inputMode.value === 'value')  syncFromValue() })

function openModal(idea?: any) {
  if (idea) {
    editingIdea.value = idea
    form.event_date = idea.event_date
    form.type = idea.type
    form.name = idea.name
    form.kind = idea.kind || 'NSO'
    form.shares = idea.shares
    form.vest_months = idea.vest_months ?? 48
    form.cliff_months = idea.cliff_months ?? 12
    form.notes = idea.notes || ''
    inputMode.value = 'shares'
    syncFromShares()
  } else {
    editingIdea.value = null
    form.event_date = new Date().toISOString().slice(0, 10)
    form.type = 'grant'
    form.name = ''
    form.kind = 'NSO'
    form.shares = 0
    form.pct = 0
    form.value = 0
    form.vest_months = 48
    form.cliff_months = 12
    form.notes = ''
    inputMode.value = 'shares'
  }
  showModal.value = true
}

const saving = ref(false)
async function saveIdea() {
  if (!form.name.trim() || form.shares <= 0 || saving.value) return
  saving.value = true
  try {
    const body = {
      event_date: form.event_date,
      type: form.type,
      name: form.name.trim(),
      kind: form.type === 'grant' ? form.kind : null,
      shares: form.shares,
      vest_months: form.type === 'grant' ? form.vest_months : null,
      cliff_months: form.type === 'grant' ? form.cliff_months : null,
      notes: form.notes || null,
    }
    if (editingIdea.value) {
      await $fetch(`/api/pool-events/${editingIdea.value.id}`, { method: 'PATCH', body })
    } else {
      await $fetch(`/api/companies/${id.value}/pool-events`, { method: 'POST', body })
    }
    showModal.value = false
    await refreshIdeas()
  } finally {
    saving.value = false
  }
}

async function deleteIdea(idea: any) {
  if (!confirm(`Delete idea "${idea.name}"?`)) return
  await $fetch(`/api/pool-events/${idea.id}`, { method: 'DELETE' })
  await refreshIdeas()
}

// ---- Chart geometry ----
const chartW = 720, chartH = 160, padL = 50, padR = 12, padT = 10, padB = 26
const chart = computed(() => {
  const pts = chartPoints.value
  if (!pts.length) return { path: '', dots: [] as Array<{ x: number; y: number; t: string; balance: number; label?: string }>, yMin: 0, yMax: 0, xTicks: [] as Array<{ x: number; label: string }>, yTicks: [] as Array<{ y: number; label: string }> }
  const minT = new Date(pts[0].t).getTime()
  const maxT = new Date(pts[pts.length - 1].t).getTime()
  const spanT = Math.max(1, maxT - minT)
  const yVals = pts.map(p => p.balance)
  const yMin = Math.min(0, ...yVals)
  const yMax = Math.max(0, ...yVals)
  const ySpan = Math.max(1, yMax - yMin)
  const xOf = (t: string) => padL + ((new Date(t).getTime() - minT) / spanT) * (chartW - padL - padR)
  const yOf = (v: number) => chartH - padB - ((v - yMin) / ySpan) * (chartH - padT - padB)

  let path = ''
  pts.forEach((p, i) => {
    const x = xOf(p.t), y = yOf(p.balance)
    path += (i === 0 ? 'M' : 'L') + ` ${x} ${y} `
  })

  // Y ticks: 0, max, mid
  const yTicks = [yMin, (yMin + yMax) / 2, yMax].map(v => ({ y: yOf(v), label: fmtShares(v) }))
  // X ticks: first and last
  const xTicks = pts.length > 1
    ? [{ x: xOf(pts[0].t), label: fmtDate(pts[0].t) }, { x: xOf(pts[pts.length - 1].t), label: fmtDate(pts[pts.length - 1].t) }]
    : []

  const dots = pts.filter(p => p.label).map(p => ({ x: xOf(p.t), y: yOf(p.balance), t: p.t, balance: p.balance, label: p.label }))
  return { path, dots, yMin, yMax, xTicks, yTicks }
})
</script>

<template>
  <div>
    <div class="flex items-end justify-between mb-5 gap-3 flex-wrap">
      <div>
        <h1 class="text-xl font-semibold tracking-tight text-ink-900">Option pool impact</h1>
        <p class="text-sm text-ink-600 mt-1">Chronological view of every event that affects the pool — pool top-ups, outstanding grants, proposed grants, and your future ideas.</p>
      </div>
      <div class="flex items-center gap-2">
        <div class="inline-flex items-center rounded-md border border-ink-300 bg-white p-0.5 text-xs">
          <button type="button" class="px-2.5 py-1 rounded-[5px] font-medium transition-colors"
            :class="mode === 'single' ? 'bg-accent-500 text-white' : 'text-ink-600 hover:text-ink-900'"
            @click="mode = 'single'">Single event</button>
          <button type="button" class="px-2.5 py-1 rounded-[5px] font-medium transition-colors"
            :class="mode === 'vest' ? 'bg-accent-500 text-white' : 'text-ink-600 hover:text-ink-900'"
            @click="mode = 'vest'">Vest schedule</button>
        </div>
        <UiButton variant="primary" @click="openModal()"><Plus :size="14" /> Add idea</UiButton>
      </div>
    </div>

    <!-- Top stats + horizontal stacked bar -->
    <div class="rounded-lg border border-ink-300 bg-white shadow-card p-4 mb-5">
      <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <UiStat label="Pool authorized" :value="fmtShares(totals.poolAuthorized)" />
        <UiStat label="Outstanding" :value="fmtShares(totals.outstandingShares)" />
        <UiStat label="Proposed" :value="fmtShares(totals.proposedShares)" />
        <UiStat label="Ideas (grants)" :value="fmtShares(totals.ideaGrants)" :tone="totals.ideaGrants ? 'warn' : 'default'" />
        <UiStat label="Projected ending" :value="fmtShares(totals.projectedEnd)" emphasis :tone="totals.projectedEnd < 0 ? 'warn' : 'default'" />
      </div>
      <!-- Stacked bar visual -->
      <div v-if="totals.poolAuthorized + totals.ideaTopups > 0" class="space-y-1">
        <div class="flex h-6 rounded-md overflow-hidden border border-ink-300">
          <div
            :style="{ width: ((totals.outstandingShares / Math.max(1, totals.poolAuthorized + totals.ideaTopups)) * 100) + '%' }"
            class="bg-ink-500 text-white text-[10px] flex items-center justify-center font-medium"
            :title="`Outstanding: ${fmtShares(totals.outstandingShares)}`"
          >{{ totals.outstandingShares ? 'Out' : '' }}</div>
          <div
            :style="{ width: ((totals.proposedShares / Math.max(1, totals.poolAuthorized + totals.ideaTopups)) * 100) + '%' }"
            class="bg-accent-500 text-white text-[10px] flex items-center justify-center font-medium"
            :title="`Proposed: ${fmtShares(totals.proposedShares)}`"
          >{{ totals.proposedShares ? 'Prop' : '' }}</div>
          <div
            :style="{ width: ((totals.ideaGrants / Math.max(1, totals.poolAuthorized + totals.ideaTopups)) * 100) + '%' }"
            class="bg-amber-400 text-ink-900 text-[10px] flex items-center justify-center font-medium"
            :title="`Idea grants: ${fmtShares(totals.ideaGrants)}`"
          >{{ totals.ideaGrants ? 'Ideas' : '' }}</div>
          <div
            :style="{ width: (Math.max(0, totals.projectedEnd) / Math.max(1, totals.poolAuthorized + totals.ideaTopups) * 100) + '%' }"
            class="bg-emerald-200 text-emerald-900 text-[10px] flex items-center justify-center font-medium"
            :title="`Remaining: ${fmtShares(totals.projectedEnd)}`"
          >{{ totals.projectedEnd > 0 ? 'Free' : '' }}</div>
        </div>
        <div class="flex justify-between text-[10px] text-ink-500">
          <span>0</span>
          <span>{{ fmtShares(totals.poolAuthorized + totals.ideaTopups) }}</span>
        </div>
      </div>
    </div>

    <!-- Line chart -->
    <div v-if="chartPoints.length" class="rounded-lg border border-ink-300 bg-white shadow-card p-4 mb-5">
      <h2 class="text-[11px] font-semibold uppercase tracking-wider text-ink-500 mb-2">Pool balance over time</h2>
      <div class="overflow-x-auto">
        <svg :viewBox="`0 0 ${chartW} ${chartH}`" class="w-full" :style="{ minWidth: '600px', height: chartH + 'px' }">
          <!-- y grid -->
          <g v-for="(t, i) in chart.yTicks" :key="i">
            <line :x1="padL" :x2="chartW - padR" :y1="t.y" :y2="t.y" stroke="#e2e8f0" stroke-width="1" />
            <text :x="padL - 6" :y="t.y + 3" text-anchor="end" font-size="9" fill="#64748b" class="num">{{ t.label }}</text>
          </g>
          <!-- x ticks -->
          <g v-for="(t, i) in chart.xTicks" :key="`x-${i}`">
            <text :x="t.x" :y="chartH - 8" text-anchor="middle" font-size="9" fill="#64748b">{{ t.label }}</text>
          </g>
          <!-- zero baseline -->
          <line v-if="chart.yMin < 0" :x1="padL" :x2="chartW - padR" :y1="chart.yTicks[0]?.y" :y2="chart.yTicks[0]?.y" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3 3" />
          <!-- line -->
          <path :d="chart.path" fill="none" stroke="#2563eb" stroke-width="2" stroke-linejoin="round" />
          <!-- markers -->
          <circle v-for="(d, i) in chart.dots" :key="`d-${i}`" :cx="d.x" :cy="d.y" r="3" fill="#2563eb">
            <title>{{ d.label }} — {{ fmtDate(d.t) }} → balance {{ fmtShares(d.balance) }}</title>
          </circle>
        </svg>
      </div>
    </div>

    <!-- Timeline table -->
    <div class="rounded-lg border border-ink-300 bg-white shadow-card overflow-hidden">
      <div class="flex items-center justify-between px-4 py-3 border-b border-ink-200">
        <div>
          <h2 class="text-sm font-semibold text-ink-900">Timeline</h2>
          <p class="text-xs text-ink-500">All events in chronological order. "Single-event" mode shown — vest curves only affect the chart above.</p>
        </div>
      </div>
      <div v-if="!events.length" class="px-4 py-8 text-sm text-ink-500 text-center">
        No events yet. The first pool top-up or grant will appear here.
      </div>
      <table v-else class="w-full text-[13px] num">
        <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide bg-ink-100">
          <tr>
            <th class="px-2.5 py-1.5 font-semibold w-28">Date</th>
            <th class="px-2.5 py-1.5 font-semibold">Event</th>
            <th class="px-2.5 py-1.5 font-semibold w-32">Type</th>
            <th class="px-2.5 py-1.5 font-semibold text-right w-32">Shares</th>
            <th class="px-2.5 py-1.5 font-semibold text-right w-32">Running pool</th>
            <th class="px-2.5 py-1.5 font-semibold text-right w-20">% FDS</th>
            <th class="px-2.5 py-1.5 font-semibold text-right w-24"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in eventsWithRunning" :key="e.id" class="hover:bg-accent-50/40 border-b border-ink-200">
            <td class="px-2.5 py-1.5 text-ink-600">{{ fmtDate(e.date) }}</td>
            <td class="px-2.5 py-1.5">
              <span class="text-ink-900 font-medium">{{ e.name }}</span>
              <span
                v-if="e.source === 'idea'"
                class="ml-2 text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-800 inline-flex items-center gap-1 align-middle"
              ><Lightbulb :size="10" /> idea</span>
              <span
                v-else-if="e.source === 'grant_proposed'"
                class="ml-2 text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border border-accent-300 bg-accent-50 text-accent-700 align-middle"
              >proposed</span>
            </td>
            <td class="px-2.5 py-1.5 text-ink-700">
              <span class="inline-flex items-center gap-1">
                <TrendingUp v-if="e.direction > 0" :size="12" class="text-emerald-600" />
                <ArrowDownIcon v-else :size="12" class="text-red-500" />
                {{ e.type === 'pool_topup' ? 'Pool top-up' : (e.kind || 'Grant') }}
              </span>
            </td>
            <td class="px-2.5 py-1.5 text-right" :class="e.direction > 0 ? 'text-emerald-700' : 'text-red-600'">
              {{ e.direction > 0 ? '+' : '−' }}{{ fmtShares(e.shares) }}
            </td>
            <td class="px-2.5 py-1.5 text-right text-ink-900 font-medium">{{ fmtShares(e.running) }}</td>
            <td class="px-2.5 py-1.5 text-right text-ink-600">{{ fmtPct(fdsIncludingPool > 0 ? e.shares / fdsIncludingPool : 0, 2) }}</td>
            <td class="px-2.5 py-1.5 text-right whitespace-nowrap">
              <template v-if="e.source === 'idea'">
                <button class="text-ink-500 hover:text-accent-600 px-1 py-0.5 rounded" @click="openModal(ideas.find(i => i.id === e.ideaId))" title="Edit"><Edit3 :size="13" /></button>
                <button class="text-ink-500 hover:text-red-600 px-1 py-0.5 rounded" @click="deleteIdea(ideas.find(i => i.id === e.ideaId))" title="Delete"><Trash2 :size="13" /></button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Idea modal -->
    <div v-if="showModal" class="fixed inset-0 z-40 bg-ink-900/40 backdrop-blur-sm grid place-items-center p-4" @click.self="showModal = false">
      <div class="w-full max-w-lg rounded-lg border border-ink-300 bg-white p-5 shadow-card-hover">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-base font-semibold text-ink-900">{{ editingIdea ? 'Edit idea' : 'Add idea' }}</h2>
          <button class="p-1.5 hover:bg-ink-200 rounded" @click="showModal = false"><X :size="14" /></button>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <label class="block col-span-2">
            <span class="block text-xs font-medium text-ink-700 mb-1">Event type</span>
            <div class="inline-flex rounded-md border border-ink-300 bg-white p-0.5 text-sm w-full">
              <button type="button" class="flex-1 px-2.5 py-1 rounded-[5px] font-medium" :class="form.type === 'grant' ? 'bg-accent-500 text-white' : 'text-ink-700'" @click="form.type = 'grant'">Grant</button>
              <button type="button" class="flex-1 px-2.5 py-1 rounded-[5px] font-medium" :class="form.type === 'pool_topup' ? 'bg-accent-500 text-white' : 'text-ink-700'" @click="form.type = 'pool_topup'">Pool top-up</button>
            </div>
          </label>

          <UiInput v-model="form.name" label="Name" :placeholder="form.type === 'grant' ? 'Future CEO' : 'Q3 2026 top-up'" class="col-span-2" />
          <UiInput v-model="form.event_date" type="date" label="Target date" />
          <label v-if="form.type === 'grant'" class="block">
            <span class="block text-xs font-medium text-ink-700 mb-1">ISO / NSO</span>
            <select v-model="form.kind" class="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500">
              <option value="ISO">ISO</option>
              <option value="NSO">NSO</option>
            </select>
          </label>

          <div class="col-span-2">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs font-medium text-ink-700">Size — enter as:</span>
              <div class="inline-flex rounded-md border border-ink-300 bg-white p-0.5 text-xs">
                <button type="button" class="px-2 py-0.5 rounded-[3px]" :class="inputMode === 'shares' ? 'bg-accent-500 text-white' : 'text-ink-600'" @click="inputMode = 'shares'">Shares</button>
                <button type="button" class="px-2 py-0.5 rounded-[3px]" :class="inputMode === 'pct' ? 'bg-accent-500 text-white' : 'text-ink-600'" @click="inputMode = 'pct'">%</button>
                <button type="button" class="px-2 py-0.5 rounded-[3px]" :class="inputMode === 'value' ? 'bg-accent-500 text-white' : 'text-ink-600'" @click="inputMode = 'value'">$</button>
              </div>
            </div>
            <div class="grid grid-cols-3 gap-3">
              <div>
                <span class="block text-[10px] uppercase tracking-wide text-ink-500 mb-0.5">Shares</span>
                <NumberInput v-model="form.shares" :disabled="inputMode !== 'shares'" :input-class="inputMode === 'shares' ? '' : 'opacity-60'" />
              </div>
              <div>
                <span class="block text-[10px] uppercase tracking-wide text-ink-500 mb-0.5">% of FDS</span>
                <div class="flex items-center rounded-md border border-ink-300 bg-white">
                  <input
                    :disabled="inputMode !== 'pct'"
                    :class="['flex-1 px-1.5 py-1 text-right text-sm num bg-transparent border-0 focus:outline-none focus:ring-0', inputMode === 'pct' ? '' : 'opacity-60']"
                    type="number" step="0.01"
                    :value="(form.pct * 100).toFixed(3)"
                    @input="form.pct = (Number(($event.target as HTMLInputElement).value) || 0) / 100"
                  />
                  <span class="pr-1.5 text-xs text-ink-500">%</span>
                </div>
              </div>
              <div>
                <span class="block text-[10px] uppercase tracking-wide text-ink-500 mb-0.5">$ at current PPS</span>
                <NumberInput v-model="form.value" prefix="$" :disabled="inputMode !== 'value'" :input-class="inputMode === 'value' ? '' : 'opacity-60'" />
              </div>
            </div>
            <p class="mt-1 text-[10px] text-ink-500">% denominator: current FDS incl. pool ({{ fmtShares(fdsIncludingPool) }}). $ uses current PPS ({{ fmtUSD(currentPPS) }}).</p>
          </div>

          <template v-if="form.type === 'grant'">
            <UiInput v-model="form.vest_months" type="number" label="Vest months" />
            <UiInput v-model="form.cliff_months" type="number" label="Cliff months" />
          </template>

          <label class="block col-span-2">
            <span class="block text-xs font-medium text-ink-700 mb-1">Notes (optional)</span>
            <textarea v-model="form.notes" rows="2" class="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500" />
          </label>
        </div>

        <div class="mt-5 flex justify-end gap-2">
          <UiButton variant="ghost" @click="showModal = false">Cancel</UiButton>
          <UiButton variant="primary" :disabled="!form.name.trim() || form.shares <= 0 || saving" @click="saveIdea">
            <Lightbulb :size="14" /> {{ saving ? 'Saving…' : (editingIdea ? 'Update idea' : 'Add idea') }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
