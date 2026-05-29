<script setup lang="ts">
// Overall Dilution — three grouped categories side by side (Shares,
// Ownership %, Value $), each showing Pre / Post / Δ. All columns
// are sortable and resizable; widths + sort direction persist in
// localStorage via useSortableTable.
//
// Denominator (operator's model): ONE fully-diluted basis — the
// post-round total (aggregate base + the current round's cumulative
// total_shares_fds). BOTH Pre % and Post % divide by it, so a holder
// only moves pre→post when their OWN share count changes (CN
// conversions, proposed grants); the denominator does not grow
// round-over-round. It also does NOT grow with proposed/idea grants —
// those draw from option-pool capacity already inside total_shares_fds.
//
// Toggle: "Include proposed + ideas in post" rolls not-yet-issued
// grants (status='proposed' from the Grants page) and pool Ideas
// (anonymous future grants from the Pool Impact page) into the POST
// NUMERATOR only — per-stakeholder postShares, plus a synthetic
// "Future ideas" row. Pre and the denominator are untouched.
import { ArrowUp, ArrowDown, Upload } from 'lucide-vue-next'
import { fmtUSD, fmtPct, fmtShares } from '~/utils/format'

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

// Previous-Round aggregate — holds the fully-diluted total for the
// state before the current round. Drives the dilution PRE denominator.
const { data: aggregate } = await useFetch<{ total_shares_fds: number | null }>(
  () => `/api/companies/${id.value}/aggregate-round`,
  { watch: [id], default: () => ({ total_shares_fds: null } as any) },
)

// Non-formation rounds in timeline order (the API sorts open rounds last).
const timelineRounds = computed(() => (roundSummary.value?.rounds || []).filter(r => r.kind !== 'formation'))

// Current round being modeled — the open round if one's flagged, else
// the latest round. Mirrors the Financings page's Open Round card, so a
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

// Total proposed shares — for the header chip and per-stakeholder
// numerator augmentation when the toggle is on. These do NOT grow the
// denominator (they draw from pool capacity already in total_shares_fds).
const proposedTotal = computed(() => {
  let total = 0
  for (const p of proposedByStakeholder.value.values()) total += p.shares
  return total
})
// Single fully-diluted basis = the post-round total: aggregate base
// (Previous-Round card's Total FDS) + the current round's cumulative
// total_shares_fds. Per the operator's model BOTH Pre % and Post %
// divide by this same number, so the only pre→post movement comes from
// a holder's own share changes (CN conversions, proposed grants), not a
// moving denominator. (Previously Pre % used the prior round's FDS to
// isolate this round's dilution event — dropped per the operator.)
const fdsBasis = computed(() => {
  const base = aggregate.value?.total_shares_fds || 0
  return base + (currentRound.value?.total_shares_fds || 0)
})
const preFDS = computed(() => fdsBasis.value)
const postFDS = computed(() => fdsBasis.value)

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
      prePct: pre > 0 ? preShares / pre : 0,
      postPct: post > 0 ? postShares / post : 0,
      preValue,
      postValue,
      deltaShares: postShares - preShares,
      deltaPct: (post > 0 ? postShares / post : 0) - (pre > 0 ? preShares / pre : 0),
      deltaValue: postValue - preValue,
      isNewRound: String(d.stakeholderId).startsWith('new:') || String(d.stakeholderId).startsWith('idea:'),
      isFuture: false,
      aliasNames: Array.isArray(d.aliasNames) ? d.aliasNames : [],
      hasOptions: !!d.hasOptions,
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
  key: 'capstack:dilution:v3',
  defaultSort: { key: 'deltaPct', dir: 'asc' },
  columns: [
    { key: 'name',         label: 'Stakeholder',  width: 240, sortable: true, align: 'left' },
    { key: 'preShares',    label: 'Pre shares',   width: 110, sortable: true, align: 'right' },
    { key: 'postShares',   label: 'Post shares',  width: 110, sortable: true, align: 'right' },
    { key: 'deltaShares',  label: 'Δ shares',     width: 100, sortable: true, align: 'right' },
    { key: 'prePct',       label: 'Pre %',        width: 80,  sortable: true, align: 'right' },
    { key: 'postPct',      label: 'Post %',       width: 80,  sortable: true, align: 'right' },
    { key: 'deltaPct',     label: 'Δ %',          width: 80,  sortable: true, align: 'right' },
    { key: 'invested',     label: 'Invested $',   width: 120, sortable: true, align: 'right' },
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
  { label: 'Cost', span: 1 },                   // Invested $
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

// ---- Import modal for preferred shareholders ----
const importOpen = ref(false)
async function onImported() {
  await refreshCompute()
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
            Every holder as a slice of one fully-diluted
            <span class="font-medium text-brand-700">post-{{ currentRoundName }}</span> basis.
            Δ = post − pre tracks each holder's own share changes (note conversions, new grants);
            green = gain, red = drop.
          </p>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <!-- Bulk-import preferred holders so they tie into the pre-side
               of the dilution view (via stakeholders + holdings). -->
          <button
            type="button"
            class="inline-flex items-center gap-1.5 text-xs text-ink-700 bg-white border border-ink-300 rounded-md px-3 py-1.5 hover:border-ink-400 hover:bg-ink-50"
            @click="importOpen = true"
          >
            <Upload :size="12" />
            Import preferred holders
          </button>

          <!-- Toggle: include preferred-only holders. When off, the
               table hides rows whose shares come solely from preferred
               holdings (no options). A linked alias whose primary
               holds options stays visible regardless — see compute.post
               for the hasOptions roll-up. -->
          <label class="inline-flex items-center gap-2 cursor-pointer select-none text-xs text-ink-700 bg-white border border-ink-300 rounded-md px-3 py-1.5 hover:border-ink-400">
            <input type="checkbox" v-model="includePreferred" class="brand-brand-500" />
            <span>Include preferred holders</span>
          </label>

          <!-- Toggle: include proposed + idea grants in the post side.
               Per the operator's spec, future not-yet-issued shares
               should fall under "post" (never "pre"). -->
          <label class="inline-flex items-center gap-2 cursor-pointer select-none text-xs text-ink-700 bg-white border border-ink-300 rounded-md px-3 py-1.5 hover:border-ink-400">
            <input type="checkbox" v-model="includeFuture" class="brand-brand-500" />
            <span>Include proposed + ideas in post</span>
            <span class="text-[10px] text-ink-400 num">
              ({{ fmtShares(proposedTotal) }} prop · {{ fmtShares(ideaConsumingShares) }} ideas)
            </span>
          </label>
        </div>
      </div>
      <div v-if="currentRound" class="mt-2 text-[11px] num text-ink-500 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          <span class="uppercase tracking-wider">FDS basis</span>
          <template v-if="postFDS > 0">
            <span class="ml-1 text-ink-700">{{ fmtShares(postFDS) }}</span>
            <span class="ml-0.5 text-ink-400">(post-{{ currentRoundName }} — pre & post share this)</span>
          </template>
          <span v-else class="ml-1 text-amber-700">0 — set Total FDS on the Previous Round card</span>
        </span>
        <span v-if="pps > 0" class="text-ink-300">·</span>
        <span v-if="pps > 0">
          <span class="uppercase tracking-wider">PPS</span>
          <span class="ml-1 text-ink-700">${{ pps.toFixed(5) }}</span>
        </span>
      </div>
      <div v-else class="mt-2 text-[11px] text-amber-700">
        No round to model yet — add one on the Financings page to compare pre vs post.
      </div>
    </div>

    <!-- Table: sortable + resizable columns, 3 grouped column groups. -->
    <div class="rounded-lg border border-ink-300 bg-white shadow-card flex flex-col min-h-0 flex-1 overflow-hidden">
      <div v-if="!sortedRows.length" class="px-4 py-12 text-center text-sm text-ink-500">
        No data yet — add a round on the Financings page and import or enter holders to model dilution.
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
                    ci === 1 || ci === 4 || ci === 7 || ci === 8 ? 'border-l' : '',
                    ci === 2 || ci === 5 || ci === 9 ? 'text-brand-700' : '',
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
            <tr v-for="r in sortedRows" :key="r.stakeholderId" class="hover:bg-brand-50/40">
              <td class="px-3 py-1.5 border-b border-ink-200">
                <span class="text-ink-900 font-medium" :title="r.aliasNames.length ? `Includes: ${r.aliasNames.join(', ')}` : r.name">{{ r.name }}</span>
                <span v-if="r.type" class="ml-1.5 text-[9px] uppercase tracking-wide text-ink-500 bg-ink-100 border border-ink-200 px-1 py-0.5 rounded align-middle">{{ r.type }}</span>
                <span v-if="r.isFuture" class="ml-1.5 text-[9px] uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 px-1 py-0.5 rounded align-middle">future</span>
                <span v-else-if="r.isNewRound" class="ml-1.5 text-[9px] uppercase tracking-wide text-brand-700 bg-brand-50 border border-brand-200 px-1 py-0.5 rounded align-middle">new</span>
                <span
                  v-if="r.aliasNames.length"
                  class="ml-1.5 text-[9px] uppercase tracking-wide text-brand-edge bg-brand-soft border border-brand-200 px-1 py-0.5 rounded align-middle"
                  :title="`Rolls up: ${r.aliasNames.join(', ')}`"
                >+{{ r.aliasNames.length }} linked</span>
              </td>

              <!-- ---- Shares group ---- -->
              <td class="px-3 py-1.5 text-right text-ink-700 border-l border-b border-ink-200">{{ fmtShares(r.preShares) }}</td>
              <td class="px-3 py-1.5 text-right text-ink-900 font-medium border-b border-ink-200">{{ fmtShares(r.postShares) }}</td>
              <td class="px-3 py-1.5 text-right font-semibold border-b border-ink-200" :class="deltaColor(r.deltaShares)">{{ fmtDeltaShares(r.deltaShares) }}</td>

              <!-- ---- Ownership % group ---- -->
              <td class="px-3 py-1.5 text-right text-ink-700 border-l border-b border-ink-200">{{ fmtPct(r.prePct, 2) }}</td>
              <td class="px-3 py-1.5 text-right text-ink-900 font-medium border-b border-ink-200">{{ fmtPct(r.postPct, 2) }}</td>
              <td class="px-3 py-1.5 text-right font-semibold border-b border-ink-200" :class="deltaColor(r.deltaPct)">{{ fmtDeltaPct(r.deltaPct) }}</td>

              <!-- ---- Cost-basis (Invested $) ---- -->
              <td class="px-3 py-1.5 text-right text-ink-700 border-l border-b border-ink-200"
                  :title="r.avgEntryPPS ? `Avg entry price ~$${r.avgEntryPPS.toFixed(4)}/sh` : ''">
                {{ r.invested > 0 ? fmtUSD(r.invested) : '—' }}
              </td>

              <!-- ---- Value ($) group ---- -->
              <td class="px-3 py-1.5 text-right text-ink-700 border-l border-b border-ink-200">{{ pps > 0 ? fmtUSD(r.preValue) : '—' }}</td>
              <td class="px-3 py-1.5 text-right text-ink-900 font-medium border-b border-ink-200">{{ pps > 0 ? fmtUSD(r.postValue) : '—' }}</td>
              <td class="px-3 py-1.5 text-right font-semibold border-b border-ink-200" :class="deltaColor(r.deltaValue)">{{ pps > 0 ? fmtDeltaUSD(r.deltaValue) : '—' }}</td>
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
