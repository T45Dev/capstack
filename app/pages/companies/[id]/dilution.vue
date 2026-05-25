<script setup lang="ts">
// Overall Dilution — three grouped categories side by side (Shares,
// Ownership %, Value $), each showing Pre / Post / Δ. All columns
// are sortable and resizable; widths + sort direction persist in
// localStorage via useSortableTable.
//
// Toggle: "Include proposed + ideas in post" rolls in not-yet-issued
// grants (status='proposed' from the Grants page) and pool Ideas
// (anonymous future grants from the Pool Impact page) on the POST
// side only. Pre stays as-is. Both the per-stakeholder postShares
// and the postFDS denominator are augmented when toggled.
//
// Denominators (per user spec):
//   - post% = stakeholder shares ÷ open round's total_shares_fds
//             (+ proposed + ideas if toggled)
//   - pre%  = stakeholder shares ÷ (round IMMEDIATELY BEFORE open)'s
//             total_shares_fds
import { ArrowUp, ArrowDown } from 'lucide-vue-next'
import { fmtUSD, fmtPct, fmtShares } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

const computeBody = computed(() => ({}))
const { data: compute } = await useFetch(() => `/api/companies/${id.value}/compute`, {
  method: 'POST',
  body: computeBody,
  watch: [id],
})
const { data: roundSummary } = await useFetch<{
  rounds: Array<{
    code: string
    name: string | null
    kind: string
    total_shares_fds: number
    share_price: number | null
  }>
}>(() => `/api/companies/${id.value}/round-summary`, { watch: [id], default: () => ({ rounds: [] }) })
// Proposed grants live on the grants endpoint (status='proposed').
const { data: grantsData } = await useFetch<{ grants: any[] }>(
  () => `/api/companies/${id.value}/grants`,
  { watch: [id], default: () => ({ grants: [] } as any) },
)
// Ideas live on the pool-events endpoint. Anonymous future grants —
// no stakeholder attribution, so they're rolled into a synthetic
// "Future ideas" row when the toggle is on.
const { data: ideas } = await useFetch<any[]>(
  () => `/api/companies/${id.value}/pool-events`,
  { watch: [id], default: () => [] },
)

const openRound = computed(() => roundSummary.value?.rounds.find(r => r.kind === 'open') || null)
const openRoundName = computed(() => openRound.value?.name || openRound.value?.code || 'open round')
const previousRound = computed(() => {
  const rounds = roundSummary.value?.rounds || []
  const openIdx = rounds.findIndex(r => r.kind === 'open')
  if (openIdx <= 0) return null
  return rounds[openIdx - 1] || null
})

const pps = computed(() => openRound.value?.share_price || (compute.value?.round?.pricePerShare as number) || 0)

// Toggle: include proposed + ideas in post-side math. Persists per
// company across reloads.
const includeFuture = ref(false)
const STORAGE_KEY = 'capstack:dilution:includeFuture'
if (typeof window !== 'undefined') {
  try { includeFuture.value = localStorage.getItem(STORAGE_KEY) === 'true' } catch { /* ignore */ }
  watch(includeFuture, v => {
    try { localStorage.setItem(STORAGE_KEY, String(v)) } catch { /* ignore */ }
  })
}

// Proposed grants grouped by stakeholder_id (fallback to a synthetic
// id based on recipient_name when no stakeholder linkage exists).
const proposedByStakeholder = computed(() => {
  const map = new Map<string, { stakeholderId: string; name: string; shares: number }>()
  for (const g of (grantsData.value?.grants || [])) {
    if (g.status !== 'proposed') continue
    const sid = g.stakeholder_id || `proposed:${(g.recipient_name || '').toLowerCase()}`
    const cur = map.get(sid)
    if (cur) {
      cur.shares += g.quantity || 0
    } else {
      map.set(sid, { stakeholderId: sid, name: g.recipient_name || 'Proposed grant', shares: g.quantity || 0 })
    }
  }
  return map
})

// Idea grants/reserves total. pool_events doesn't carry a stakeholder
// link so we aggregate everything into one synthetic row labeled
// "Future ideas (N)".
const ideaConsumingShares = computed(() => {
  return (ideas.value || []).reduce((sum, ie) => {
    if (ie.type === 'grant' || ie.type === 'reserve') return sum + (ie.shares || 0)
    return sum
  }, 0)
})
const ideaCount = computed(() =>
  (ideas.value || []).filter((ie: any) => ie.type === 'grant' || ie.type === 'reserve').length,
)

// Augment postFDS denominator with future shares when the toggle is on.
const proposedTotal = computed(() => {
  let total = 0
  for (const p of proposedByStakeholder.value.values()) total += p.shares
  return total
})
const preFDS = computed(() => previousRound.value?.total_shares_fds || 0)
const postFDS = computed(() => {
  const base = openRound.value?.total_shares_fds || 0
  if (!includeFuture.value) return base
  return base + proposedTotal.value + ideaConsumingShares.value
})

interface DilRow {
  stakeholderId: string
  name: string
  type: string | null
  preShares: number
  postShares: number
  prePct: number
  postPct: number
  preValue: number
  postValue: number
  deltaShares: number
  deltaPct: number
  deltaValue: number
  isNewRound: boolean
  isFuture: boolean  // synthetic future-only rows (idea-grants aggregate)
}

const rows = computed<DilRow[]>(() => {
  const list = (compute.value?.dilution || []) as any[]
  const pre = preFDS.value
  const post = postFDS.value
  const sharePrice = pps.value
  const propMap = includeFuture.value ? proposedByStakeholder.value : new Map()

  const out: DilRow[] = list.map(d => {
    const preShares = d.preShares || 0
    let postShares = d.postShares || 0
    // Augment with proposed shares allocated to this stakeholder.
    const proposed = propMap.get(d.stakeholderId)?.shares || 0
    if (proposed > 0) postShares += proposed
    const preValue = preShares * sharePrice
    const postValue = postShares * sharePrice
    return {
      stakeholderId: d.stakeholderId,
      name: d.name,
      type: d.type || null,
      preShares,
      postShares,
      prePct: pre > 0 ? preShares / pre : 0,
      postPct: post > 0 ? postShares / post : 0,
      preValue,
      postValue,
      deltaShares: postShares - preShares,
      deltaPct: (post > 0 ? postShares / post : 0) - (pre > 0 ? preShares / pre : 0),
      deltaValue: postValue - preValue,
      isNewRound: String(d.stakeholderId).startsWith('new:') || String(d.stakeholderId).startsWith('idea:'),
      isFuture: false,
    }
  })

  // Proposed-only stakeholders not already in the dilution list (a new
  // hire with no existing position, for example).
  if (includeFuture.value) {
    const seen = new Set(list.map((d: any) => d.stakeholderId))
    for (const p of proposedByStakeholder.value.values()) {
      if (seen.has(p.stakeholderId)) continue
      const postValue = p.shares * sharePrice
      out.push({
        stakeholderId: p.stakeholderId,
        name: p.name,
        type: 'proposed',
        preShares: 0,
        postShares: p.shares,
        prePct: 0,
        postPct: post > 0 ? p.shares / post : 0,
        preValue: 0,
        postValue,
        deltaShares: p.shares,
        deltaPct: post > 0 ? p.shares / post : 0,
        deltaValue: postValue,
        isNewRound: true,
        isFuture: true,
      })
    }
    // Idea grants → single synthetic row, anonymous bucket.
    if (ideaConsumingShares.value > 0) {
      const shares = ideaConsumingShares.value
      const postValue = shares * sharePrice
      out.push({
        stakeholderId: 'ideas:aggregate',
        name: `Future ideas (${ideaCount.value})`,
        type: 'idea',
        preShares: 0,
        postShares: shares,
        prePct: 0,
        postPct: post > 0 ? shares / post : 0,
        preValue: 0,
        postValue,
        deltaShares: shares,
        deltaPct: post > 0 ? shares / post : 0,
        deltaValue: postValue,
        isNewRound: true,
        isFuture: true,
      })
    }
  }
  return out
})

// ---- Sortable + resizable columns via the shared composable ----
const table = useSortableTable({
  key: 'capstack:dilution:v2',
  defaultSort: { key: 'deltaPct', dir: 'asc' },
  columns: [
    { key: 'name',         label: 'Stakeholder',  width: 240, sortable: true, align: 'left' },
    { key: 'preShares',    label: 'Pre shares',   width: 110, sortable: true, align: 'right' },
    { key: 'postShares',   label: 'Post shares',  width: 110, sortable: true, align: 'right' },
    { key: 'deltaShares',  label: 'Δ shares',     width: 100, sortable: true, align: 'right' },
    { key: 'prePct',       label: 'Pre %',        width: 80,  sortable: true, align: 'right' },
    { key: 'postPct',      label: 'Post %',       width: 80,  sortable: true, align: 'right' },
    { key: 'deltaPct',     label: 'Δ %',          width: 80,  sortable: true, align: 'right' },
    { key: 'preValue',     label: 'Pre $',        width: 120, sortable: true, align: 'right' },
    { key: 'postValue',    label: 'Post $',       width: 120, sortable: true, align: 'right' },
    { key: 'deltaValue',   label: 'Δ $',          width: 120, sortable: true, align: 'right' },
  ],
})

const sortedRows = computed(() => table.applySort(rows.value as any) as DilRow[])

function sortIconFor(key: string) {
  if (table.sort.key !== key) return null
  return table.sort.dir === 'asc' ? ArrowUp : ArrowDown
}

// Column-group spans for the two-row header. Order matches the column
// order above.
const groupSpans = [
  { label: '', span: 1 },                       // Stakeholder
  { label: 'Shares', span: 3 },                 // Pre / Post / Δ shares
  { label: 'Ownership %', span: 3 },            // Pre / Post / Δ %
  { label: 'Value ($)', span: 3 },              // Pre / Post / Δ $
]

// ---- Δ formatters ----
const EPS = 0.000001
function deltaColor(delta: number): string {
  if (delta > EPS) return 'text-emerald-700'
  if (delta < -EPS) return 'text-red-600'
  return 'text-ink-400'
}
function fmtDeltaShares(n: number): string {
  if (Math.abs(n) < 1) return '0'
  return (n > 0 ? '+' : '') + fmtShares(n)
}
function fmtDeltaPct(n: number): string {
  if (Math.abs(n) < EPS) return '0.00%'
  return (n > 0 ? '+' : '') + fmtPct(n, 2)
}
function fmtDeltaUSD(n: number): string {
  if (Math.abs(n) < 1) return '$0'
  return (n > 0 ? '+' : '') + fmtUSD(n)
}
</script>

<template>
  <div class="flex flex-col" style="height: calc(100vh - 3.5rem - 3rem)">
    <!-- Framing banner -->
    <div class="mb-3 shrink-0">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 class="text-xl font-semibold tracking-tight text-ink-900">Overall Dilution</h1>
          <p class="text-sm text-ink-600 mt-1">
            Comparing <span class="font-medium text-ink-800">pre-{{ openRoundName }}</span> vs.
            <span class="font-medium text-accent-700">post-{{ openRoundName }}</span>.
            Δ = post − pre; red = dilution, green = growth.
          </p>
        </div>
        <!-- Toggle: include proposed + idea grants in the post side.
             Per the operator's spec, future not-yet-issued shares
             should fall under "post" (never "pre"). -->
        <label class="inline-flex items-center gap-2 cursor-pointer select-none text-xs text-ink-700 bg-white border border-ink-300 rounded-md px-3 py-1.5 hover:border-ink-400">
          <input type="checkbox" v-model="includeFuture" class="accent-accent-500" />
          <span>Include proposed + ideas in post</span>
          <span class="text-[10px] text-ink-400 num">
            ({{ fmtShares(proposedTotal) }} prop · {{ fmtShares(ideaConsumingShares) }} ideas)
          </span>
        </label>
      </div>
      <div v-if="openRound" class="mt-2 text-[11px] num text-ink-500 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          <span class="uppercase tracking-wider">Pre FDS</span>
          <span class="ml-1 text-ink-700">{{ fmtShares(preFDS) }}</span>
          <span v-if="previousRound" class="ml-0.5 text-ink-400">({{ previousRound.name || previousRound.code }})</span>
          <span v-else class="ml-0.5 text-amber-700">(no round before open — pre% will be 0)</span>
        </span>
        <span class="text-ink-300">·</span>
        <span>
          <span class="uppercase tracking-wider">Post FDS</span>
          <span class="ml-1 text-ink-700">{{ fmtShares(postFDS) }}</span>
          <span class="ml-0.5 text-ink-400">({{ openRound.name || openRound.code }}<span v-if="includeFuture"> + future</span>)</span>
        </span>
        <span v-if="pps > 0" class="text-ink-300">·</span>
        <span v-if="pps > 0">
          <span class="uppercase tracking-wider">PPS</span>
          <span class="ml-1 text-ink-700">${{ pps.toFixed(5) }}</span>
        </span>
      </div>
      <div v-else class="mt-2 text-[11px] text-amber-700">
        No round is flagged as "Open" on the Financings page — set one to model dilution against it.
      </div>
    </div>

    <!-- Table: sortable + resizable columns, 3 grouped column groups. -->
    <div class="rounded-lg border border-ink-300 bg-white shadow-card flex flex-col min-h-0 flex-1 overflow-hidden">
      <div v-if="!sortedRows.length" class="px-4 py-12 text-center text-sm text-ink-500">
        No data yet — set a round to "Open" on the Financings page to model dilution against it.
      </div>
      <div v-else class="overflow-auto min-h-0 flex-1">
        <table class="text-[13px] num border-separate" style="border-spacing: 0;">
          <colgroup>
            <col v-for="c in table.cols" :key="c.key" :style="{ width: c.width + 'px' }" />
          </colgroup>
          <thead class="text-ink-500 text-[10px] uppercase tracking-wider font-semibold bg-ink-100 sticky top-0 z-10">
            <!-- Group label row -->
            <tr>
              <th v-for="(g, gi) in groupSpans" :key="gi" :colspan="g.span"
                  class="px-3 py-1 text-center text-ink-700 border-b border-ink-300"
                  :class="gi > 0 ? 'border-l' : ''">
                {{ g.label }}
              </th>
            </tr>
            <!-- Per-column sortable + resizable label row -->
            <tr>
              <th v-for="(col, ci) in table.cols" :key="col.key"
                  class="relative px-3 py-1.5 border-b border-ink-300"
                  :class="[
                    col.align === 'right' ? 'text-right' : 'text-left',
                    ci === 1 || ci === 4 || ci === 7 ? 'border-l' : '',
                    ci === 2 || ci === 5 || ci === 8 ? 'text-accent-700' : '',
                  ]"
              >
                <button
                  type="button"
                  class="inline-flex items-center gap-1 hover:text-ink-900 select-none"
                  :class="col.align === 'right' ? 'flex-row-reverse' : ''"
                  @click="table.toggleSort(col.key)"
                >
                  {{ col.label }}
                  <component :is="sortIconFor(col.key)" v-if="sortIconFor(col.key)" :size="11" class="text-accent-600" />
                </button>
                <span class="resize-handle" @mousedown.prevent.stop="table.startResize($event, col.key)" @click.stop />
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in sortedRows" :key="r.stakeholderId" class="hover:bg-accent-50/40">
              <td class="px-3 py-1.5 border-b border-ink-200">
                <span class="text-ink-900 font-medium" :title="r.name">{{ r.name }}</span>
                <span v-if="r.type" class="ml-1.5 text-[9px] uppercase tracking-wide text-ink-500 bg-ink-100 border border-ink-200 px-1 py-0.5 rounded align-middle">{{ r.type }}</span>
                <span v-if="r.isFuture" class="ml-1.5 text-[9px] uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 px-1 py-0.5 rounded align-middle">future</span>
                <span v-else-if="r.isNewRound" class="ml-1.5 text-[9px] uppercase tracking-wide text-accent-700 bg-accent-50 border border-accent-200 px-1 py-0.5 rounded align-middle">new</span>
              </td>

              <!-- ---- Shares group ---- -->
              <td class="px-3 py-1.5 text-right text-ink-700 border-l border-b border-ink-200">{{ fmtShares(r.preShares) }}</td>
              <td class="px-3 py-1.5 text-right text-ink-900 font-medium border-b border-ink-200">{{ fmtShares(r.postShares) }}</td>
              <td class="px-3 py-1.5 text-right font-semibold border-b border-ink-200" :class="deltaColor(r.deltaShares)">{{ fmtDeltaShares(r.deltaShares) }}</td>

              <!-- ---- Ownership % group ---- -->
              <td class="px-3 py-1.5 text-right text-ink-700 border-l border-b border-ink-200">{{ fmtPct(r.prePct, 2) }}</td>
              <td class="px-3 py-1.5 text-right text-ink-900 font-medium border-b border-ink-200">{{ fmtPct(r.postPct, 2) }}</td>
              <td class="px-3 py-1.5 text-right font-semibold border-b border-ink-200" :class="deltaColor(r.deltaPct)">{{ fmtDeltaPct(r.deltaPct) }}</td>

              <!-- ---- Value ($) group ---- -->
              <td class="px-3 py-1.5 text-right text-ink-700 border-l border-b border-ink-200">{{ pps > 0 ? fmtUSD(r.preValue) : '—' }}</td>
              <td class="px-3 py-1.5 text-right text-ink-900 font-medium border-b border-ink-200">{{ pps > 0 ? fmtUSD(r.postValue) : '—' }}</td>
              <td class="px-3 py-1.5 text-right font-semibold border-b border-ink-200" :class="deltaColor(r.deltaValue)">{{ pps > 0 ? fmtDeltaUSD(r.deltaValue) : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
