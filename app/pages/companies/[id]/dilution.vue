<script setup lang="ts">
// Overall Dilution — three grouped categories side by side (Shares,
// Ownership %, Value $), each showing Pre / Post / Δ. All columns
// are sortable and resizable; widths + sort direction persist in
// localStorage via useSortableTable.
//
// Denominators (TWO, so dilution is visible) — single-list basis: both
// read straight off the chronological rounds list (round-summary), whose
// per-round cumulative FDS the timeline→rounds migration pins to the
// operator's Round-history figures.
//   - pre%  = shares ÷ PRE FDS  = the PRIOR round's cumulative Total FDS
//             (the row immediately before the current round).
//   - post% = shares ÷ POST FDS = the CURRENT round's own cumulative
//             Total FDS.
// A holder whose share count doesn't change is STILL diluted: same
// numerator, bigger denominator → pre% > post%. Dilution comes from the
// denominator growing from one round's cumulative FDS to the next.
//
// Toggle: "Include proposed + ideas in post" rolls not-yet-issued
// grants (status='proposed' from the Grants page) and pool Ideas
// (anonymous future grants from the Pool Impact page) into the POST
// NUMERATOR only — per-stakeholder postShares, plus a synthetic
// "Future ideas" row. Pre and the denominator are untouched (proposed/
// ideas draw from pool capacity already inside postFDS).
import { ArrowUp, ArrowDown, Upload, GitCompare } from 'lucide-vue-next'
import { fmtUSD, fmtPct, fmtShares } from '~/utils/format'
import { calcPct, calcValueUSD } from '~/utils/calc'

const route = useRoute()
const id = computed(() => route.params.id as string)

const computeBody = computed(() => ({}))
const { data: compute, refresh: refreshCompute } = await useFetch(() => `/api/companies/${id.value}/compute`, {
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
    new_money: number | null
    option_pool_issued: number | null
    notes_converted: number | null
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

// Non-formation rounds in timeline order (the API sorts open rounds last).
const timelineRounds = computed(() => (roundSummary.value?.rounds || []).filter(r => r.kind !== 'formation'))

// Current round being modeled — the open round if one's flagged, else
// the latest round. Mirrors the Rounds page's Open Round card, so a
// round that's been marked "closed" still models pre vs post.
const currentRound = computed(() => {
  const rs = timelineRounds.value
  if (!rs.length) return null
  return rs.find(r => r.kind === 'open') || rs[rs.length - 1] || null
})
const currentRoundName = computed(() => currentRound.value?.name || currentRound.value?.code || 'current round')

const pps = computed(() => currentRound.value?.share_price || (compute.value?.round?.pricePerShare as number) || 0)

// Toggle: include proposed + ideas in post-side math. Persists per
// company across reloads. The localStorage read happens in onMounted
// (not during setup) — otherwise the value would flip true between SSR
// (where window is undefined and the toggle renders unchecked) and the
// client's first render (where localStorage may say "true" and flip the
// toggle on), producing a Vue hydration mismatch.
const includeFuture = ref(false)
const STORAGE_KEY = 'capstack:dilution:includeFuture'
onMounted(() => {
  try { includeFuture.value = localStorage.getItem(STORAGE_KEY) === 'true' } catch { /* ignore */ }
})
watch(includeFuture, v => {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(STORAGE_KEY, String(v)) } catch { /* ignore */ }
})

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

// Full chronological rounds list (open rounds sorted last by the API),
// each carrying its cumulative Total FDS. The migration pins those to the
// operator's Round-history figures, so they're the single source.
const allRounds = computed(() => roundSummary.value?.rounds || [])
const currentIdx = computed(() => {
  const r = currentRound.value
  return r ? allRounds.value.findIndex(x => x.code === r.code) : -1
})
// PRE FDS = the PRIOR round's cumulative Total FDS (the row immediately
// before the current round in the list). Zero when the current round is
// the first one. POST FDS = the current round's OWN cumulative Total FDS.
// Proposed/idea grants do NOT grow these — they augment the POST numerator
// only.
const preFDS = computed(() => {
  const i = currentIdx.value
  if (i <= 0) return 0
  return allRounds.value[i - 1]?.total_shares_fds || 0
})
const postFDS = computed(() => currentRound.value?.total_shares_fds || 0)

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
  aliasNames: string[]  // linked stakeholders rolled into this row
  hasOptions: boolean
  // Cost-basis from round_investors (cluster-summed for linked rows).
  // Independent of current PPS — what they actually paid.
  invested: number
  avgEntryPPS: number | null
}

// "Include preferred" toggle. When unchecked, preferred-only rows (no
// options) drop out of the table. Linked rows where ANY contributor
// holds options stay visible regardless of the toggle — that was the
// operator's explicit rule.
const includePreferred = ref(true)
const PREF_STORAGE = 'capstack:dilution:includePreferred'
onMounted(() => {
  try { const v = localStorage.getItem(PREF_STORAGE); if (v !== null) includePreferred.value = v === 'true' } catch { /* ignore */ }
})
watch(includePreferred, v => {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(PREF_STORAGE, String(v)) } catch { /* ignore */ }
})

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
      // Same numerator (post/final shares) in BOTH columns; only the
      // denominator changes (preFDS → postFDS), so Δ isolates the pure
      // dilution from the round's new shares growing the FDS.
      prePct: pre > 0 ? postShares / pre : 0,
      postPct: post > 0 ? postShares / post : 0,
      preValue,
      postValue,
      deltaShares: postShares - preShares,
      deltaPct: (post > 0 ? postShares / post : 0) - (pre > 0 ? postShares / pre : 0),
      deltaValue: postValue - preValue,
      isNewRound: String(d.stakeholderId).startsWith('new:') || String(d.stakeholderId).startsWith('idea:'),
      isFuture: false,
      aliasNames: Array.isArray(d.aliasNames) ? d.aliasNames : [],
      // A proposed grant counts as (proposed) options, so a holder whose
      // only position is a proposed grant must survive the "Include
      // preferred" filter — otherwise new-hire proposed grants (which land
      // on a real stakeholder with no base holdings) silently drop out.
      hasOptions: !!d.hasOptions || proposed > 0,
      invested: d.investedDollars || 0,
      avgEntryPPS: d.avgEntryPPS ?? null,
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
        aliasNames: [],
        hasOptions: true,
        invested: 0,
        avgEntryPPS: null,
      })
    }
    // Idea grants/reserves → one row each, listed individually by name
    // (no longer rolled into a single "Future ideas" bucket).
    for (const ie of (ideas.value || [])) {
      if (ie.type !== 'grant' && ie.type !== 'reserve') continue
      const shares = ie.shares || 0
      if (shares <= 0) continue
      const postValue = shares * sharePrice
      out.push({
        stakeholderId: `idea:${ie.id}`,
        name: ie.name || 'Idea',
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
        aliasNames: [],
        hasOptions: true,
        invested: 0,
        avgEntryPPS: null,
      })
    }
  }
  // Apply the "Include preferred" filter. Row drops out only when
  // there's no options anywhere in this stakeholder (or its linked
  // aliases) AND the toggle is off. Future/new-round rows are kept.
  if (!includePreferred.value) {
    return out.filter(r => r.hasOptions || r.isFuture || r.isNewRound)
  }
  return out
})

// ---- Sortable + resizable columns via the shared composable ----
// Bumped to v3 so the new Invested-$ column widths don't get
// short-circuited by a v2 entry in localStorage.
const table = useSortableTable({
  key: 'capstack:dilution:v4',
  defaultSort: { key: 'deltaPct', dir: 'asc' },
  columns: [
    { key: 'name',         label: 'Stakeholder',  width: 240, sortable: true, align: 'left' },
    { key: 'preShares',    label: 'Pre shares',   width: 110, sortable: true, align: 'right' },
    { key: 'deltaShares',  label: 'Δ shares',     width: 100, sortable: true, align: 'right' },
    { key: 'postShares',   label: 'Post shares',  width: 110, sortable: true, align: 'right' },
    { key: 'prePct',       label: 'Pre %',        width: 80,  sortable: true, align: 'right' },
    { key: 'deltaPct',     label: 'Δ %',          width: 80,  sortable: true, align: 'right' },
    { key: 'postPct',      label: 'Post %',       width: 80,  sortable: true, align: 'right' },
    { key: 'preValue',     label: 'Pre $',        width: 120, sortable: true, align: 'right' },
    { key: 'deltaValue',   label: 'Δ $',          width: 120, sortable: true, align: 'right' },
    { key: 'postValue',    label: 'Post $',       width: 120, sortable: true, align: 'right' },
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
  { label: 'Shares', span: 3 },                 // Pre / Δ / Post shares
  { label: 'Ownership %', span: 3 },            // Pre / Δ / Post %
  { label: 'Value ($)', span: 3 },              // Pre / Δ / Post $
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

// Calc-tooltip strings — the raw arithmetic with this row's actual numbers.
const fPostFDS = computed<string | null>(() => {
  if (!currentRound.value) return null
  return `${fmtShares(preFDS.value)} (prior round) → ${fmtShares(postFDS.value)} (${currentRoundName.value})`
})
const fPreRow = (r: DilRow) => calcPct(r.isFuture ? 0 : r.postShares, preFDS.value)
const fPostRow = (r: DilRow) => calcPct(r.postShares, postFDS.value)
const fDeltaPctRow = (r: DilRow) => `${fmtPct(r.postPct, 2)} − ${fmtPct(r.prePct, 2)} = ${fmtDeltaPct(r.deltaPct)}`
const fDeltaSharesRow = (r: DilRow) => `${fmtShares(r.postShares)} − ${fmtShares(r.preShares)} = ${fmtDeltaShares(r.deltaShares)}`
const fPreVal = (r: DilRow) => calcValueUSD(r.preShares, pps.value)
const fPostVal = (r: DilRow) => calcValueUSD(r.postShares, pps.value)
const fDeltaValRow = (r: DilRow) => `${fmtUSD(r.postValue)} − ${fmtUSD(r.preValue)} = ${fmtDeltaUSD(r.deltaValue)}`

// ---- Import modal for preferred shareholders ----
const importOpen = ref(false)
async function onImported() {
  await refreshCompute()
}
</script>

<template>
  <div class="flex flex-col" style="height: calc(100vh - 3.5rem - 3rem)">
    <PageHeader class="shrink-0" :breadcrumb="[{ label: 'Cap-table model' }, { label: 'Overall Dilution' }]">
      <template #title><GitCompare :size="20" /> Overall Dilution</template>
      <template #description>
        Comparing <span class="font-medium text-ink-800">pre-{{ currentRoundName }}</span> vs.
        <span class="font-medium text-brand-700">post-{{ currentRoundName }}</span> —
        same shares against a bigger post denominator, so holders dilute even with no new shares.
        Δ = post − pre; red = dilution, green = growth.
      </template>
      <template #actions>
        <!-- Bulk-import preferred holders so they tie into the pre-side. -->
        <button
          type="button"
          class="inline-flex items-center gap-1.5 text-xs text-ink-700 bg-white border border-ink-300 rounded-md px-3 py-1.5 hover:border-ink-400 hover:bg-ink-50"
          @click="importOpen = true"
        >
          <Upload :size="12" />
          Import preferred holders
        </button>
        <label class="inline-flex items-center gap-2 cursor-pointer select-none text-xs text-ink-700 bg-white border border-ink-300 rounded-md px-3 py-1.5 hover:border-ink-400">
          <input type="checkbox" v-model="includePreferred" class="accent-brand" />
          <span>Include preferred holders</span>
        </label>
        <label class="inline-flex items-center gap-2 cursor-pointer select-none text-xs text-ink-700 bg-white border border-ink-300 rounded-md px-3 py-1.5 hover:border-ink-400">
          <input type="checkbox" v-model="includeFuture" class="accent-brand" />
          <span>Include proposed + ideas in post</span>
        </label>
      </template>
    </PageHeader>
    <!-- Pre/Post FDS reference line. -->
    <div class="shrink-0 -mt-3 mb-3">
      <div v-if="currentRound" class="text-[11px] num text-ink-500 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          <span class="uppercase tracking-wider">Pre FDS</span>
          <template v-if="preFDS > 0">
            <span class="ml-1 text-ink-700">{{ fmtShares(preFDS) }}</span>
            <span class="ml-0.5 text-ink-400">(prior round)</span>
          </template>
          <span v-else class="ml-1 text-ink-400">0 (first round)</span>
        </span>
        <span class="text-ink-300">·</span>
        <span>
          <span class="uppercase tracking-wider">Post FDS</span>
          <span class="ml-1 text-ink-700"><UiCalcTip :formula="fPostFDS">{{ fmtShares(postFDS) }}</UiCalcTip></span>
          <span class="ml-0.5 text-ink-400">({{ currentRoundName }})</span>
        </span>
        <span v-if="pps > 0" class="text-ink-300">·</span>
        <span v-if="pps > 0">
          <span class="uppercase tracking-wider">PPS</span>
          <span class="ml-1 text-ink-700">${{ pps.toFixed(5) }}</span>
        </span>
      </div>
      <div v-else class="text-[11px] text-amber-700">
        No round to model yet — add one on the Rounds page to compare pre vs post.
      </div>
    </div>

    <!-- Table: sortable + resizable columns, 3 grouped column groups. -->
    <div class="rounded-lg border border-ink-300 bg-white shadow-card flex flex-col min-h-0 flex-1 overflow-hidden">
      <div v-if="!sortedRows.length" class="px-4 py-12 text-center text-sm text-ink-500">
        No data yet — add a round on the Rounds page and import or enter holders to model dilution.
      </div>
      <div v-else class="overflow-auto min-h-0 flex-1">
        <table class="text-[13px] num border-separate data-table" style="border-spacing: 0;">
          <colgroup>
            <col v-for="c in table.cols" :key="c.key" :style="{ width: c.width + 'px' }" />
          </colgroup>
          <thead class="text-ink-500 text-[10px] uppercase tracking-wider font-semibold bg-ink-100 sticky top-0 z-10">
            <!-- Group label row -->
            <tr>
              <th v-for="(g, gi) in groupSpans" :key="gi" :colspan="g.span"
                  class="px-3 py-1 text-center text-ink-700 border-b border-ink-300">
                {{ g.label }}
              </th>
            </tr>
            <!-- Per-column sortable + resizable label row -->
            <tr>
              <th v-for="(col, ci) in table.cols" :key="col.key"
                  class="relative px-3 py-1.5 border-b border-ink-300"
                  :class="[
                    col.align === 'right' ? 'text-right' : 'text-left',
                    ci === 1 || ci === 4 || ci === 7 ? 'pl-6' : '',
                    ci === 2 || ci === 5 || ci === 8 ? 'text-brand-700' : '',
                  ]"
              >
                <button
                  type="button"
                  class="inline-flex items-center gap-1 hover:text-ink-900 select-none"
                  :class="col.align === 'right' ? 'flex-row-reverse' : ''"
                  @click="table.toggleSort(col.key)"
                >
                  {{ col.label }}
                  <component :is="sortIconFor(col.key)" v-if="sortIconFor(col.key)" :size="11" class="text-brand-600" />
                </button>
                <span class="resize-handle" @mousedown.prevent.stop="table.startResize($event, col.key)" @click.stop />
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in sortedRows" :key="r.stakeholderId" class="hover:bg-brand-50/70 transition-colors">
              <td class="px-3 py-1.5">
                <NameCell
                  :name="r.name"
                  :source="r.type === 'proposed' ? 'proposed' : r.type === 'idea' ? 'idea' : null"
                  :linked="r.aliasNames.length"
                  :linked-names="r.aliasNames"
                  :title="r.aliasNames.length ? `Includes: ${r.aliasNames.join(', ')}` : r.name"
                />
              </td>

              <!-- ---- Shares group: Pre / Δ / Post ---- -->
              <td class="px-3 py-1.5 pl-6 text-right text-ink-700">{{ fmtShares(r.preShares) }}</td>
              <td class="px-3 py-1.5 text-right font-semibold" :class="deltaColor(r.deltaShares)"><UiCalcTip :formula="fDeltaSharesRow(r)">{{ fmtDeltaShares(r.deltaShares) }}</UiCalcTip></td>
              <td class="px-3 py-1.5 text-right text-ink-900 font-medium">{{ fmtShares(r.postShares) }}</td>

              <!-- ---- Ownership % group: Pre / Δ / Post ---- -->
              <td class="px-3 py-1.5 pl-6 text-right text-ink-700"><UiCalcTip :formula="fPreRow(r)">{{ fmtPct(r.prePct, 2) }}</UiCalcTip></td>
              <td class="px-3 py-1.5 text-right font-semibold" :class="deltaColor(r.deltaPct)"><UiCalcTip :formula="fDeltaPctRow(r)">{{ fmtDeltaPct(r.deltaPct) }}</UiCalcTip></td>
              <td class="px-3 py-1.5 text-right text-ink-900 font-medium"><UiCalcTip :formula="fPostRow(r)">{{ fmtPct(r.postPct, 2) }}</UiCalcTip></td>

              <!-- ---- Value ($) group: Pre / Δ / Post ---- -->
              <td class="px-3 py-1.5 pl-6 text-right text-ink-700"><UiCalcTip :formula="pps > 0 ? fPreVal(r) : null">{{ pps > 0 ? fmtUSD(r.preValue) : '—' }}</UiCalcTip></td>
              <td class="px-3 py-1.5 text-right font-semibold" :class="deltaColor(r.deltaValue)"><UiCalcTip :formula="pps > 0 ? fDeltaValRow(r) : null">{{ pps > 0 ? fmtDeltaUSD(r.deltaValue) : '—' }}</UiCalcTip></td>
              <td class="px-3 py-1.5 text-right text-ink-900 font-medium"><UiCalcTip :formula="pps > 0 ? fPostVal(r) : null">{{ pps > 0 ? fmtUSD(r.postValue) : '—' }}</UiCalcTip></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <ImportPreferredHoldersModal
      :company-id="id"
      :open="importOpen"
      @close="importOpen = false"
      @imported="onImported"
    />
  </div>
</template>
