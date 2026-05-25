<script setup lang="ts">
// Overall Dilution — three grouped categories side by side: Shares,
// Ownership %, Value ($). Each shows Pre / Post / Δ so the operator
// can read the dilution effect in whichever unit makes sense for the
// audience (shares for cap-table folks, % for board narrative,
// $ for portfolio reporting).
//
// Denominators (per user spec):
//   - post% = stakeholder shares ÷ open round's total_shares_fds
//   - pre%  = stakeholder shares ÷ (round IMMEDIATELY BEFORE open)'s
//                                   total_shares_fds
// Both come from the Financings table via round-summary.
//
// $ value uses the open round's price-per-share for both pre and post
// — Δ$ surfaces NEW dollars allocated (typically zero for non-
// participating existing holders, positive for new investors).
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

const openRound = computed(() => roundSummary.value?.rounds.find(r => r.kind === 'open') || null)
const openRoundName = computed(() => openRound.value?.name || openRound.value?.code || 'open round')
const previousRound = computed(() => {
  const rounds = roundSummary.value?.rounds || []
  const openIdx = rounds.findIndex(r => r.kind === 'open')
  if (openIdx <= 0) return null
  return rounds[openIdx - 1] || null
})

const preFDS = computed(() => previousRound.value?.total_shares_fds || 0)
const postFDS = computed(() => openRound.value?.total_shares_fds || 0)
// $ value uses the open round's share price (most-recent valuation).
// Fall back to the compute endpoint's PPS if Financings doesn't have
// share_price set yet.
const pps = computed(() => openRound.value?.share_price || (compute.value?.round?.pricePerShare as number) || 0)

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
  isNewRound: boolean
}

const rows = computed<DilRow[]>(() => {
  const list = (compute.value?.dilution || []) as any[]
  const pre = preFDS.value
  const post = postFDS.value
  const sharePrice = pps.value
  return list.map(d => {
    const preShares = d.preShares || 0
    const postShares = d.postShares || 0
    return {
      stakeholderId: d.stakeholderId,
      name: d.name,
      type: d.type || null,
      preShares,
      postShares,
      prePct: pre > 0 ? preShares / pre : 0,
      postPct: post > 0 ? postShares / post : 0,
      preValue: preShares * sharePrice,
      postValue: postShares * sharePrice,
      isNewRound: String(d.stakeholderId).startsWith('new:') || String(d.stakeholderId).startsWith('idea:'),
    }
  })
})

// Sort by Δ% ascending so most-diluted holders surface first.
const sortedRows = computed(() =>
  [...rows.value].sort((a, b) => (a.postPct - a.prePct) - (b.postPct - b.prePct)),
)

// ---- Δ formatters ----
// Each cell shows the raw post − pre value with a +/− sign and color.
// Zero magnitudes render in muted ink so the eye doesn't get pulled
// toward the unchanged rows.
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
      <h1 class="text-xl font-semibold tracking-tight text-ink-900">Overall Dilution</h1>
      <p class="text-sm text-ink-600 mt-1">
        Comparing <span class="font-medium text-ink-800">pre-{{ openRoundName }}</span> vs.
        <span class="font-medium text-accent-700">post-{{ openRoundName }}</span>.
        Δ = post − pre; red = dilution, green = growth.
      </p>
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
          <span class="ml-0.5 text-ink-400">({{ openRound.name || openRound.code }})</span>
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

    <!-- Table: 3 column groups (Shares / % / $), each with Pre/Post/Δ.
         Thin vertical dividers between groups make scanning easier. -->
    <div class="rounded-lg border border-ink-300 bg-white shadow-card flex flex-col min-h-0 flex-1 overflow-hidden">
      <div v-if="!sortedRows.length" class="px-4 py-12 text-center text-sm text-ink-500">
        No data yet — set a round to "Open" on the Financings page to model dilution against it.
      </div>
      <div v-else class="overflow-auto min-h-0 flex-1">
        <table class="w-full text-[13px] num border-separate" style="border-spacing: 0;">
          <thead class="text-ink-500 text-[10px] uppercase tracking-wider font-semibold bg-ink-100 sticky top-0 z-10">
            <!-- Two-row header: group label on top, per-column labels
                 underneath. Stakeholder spans both rows. -->
            <tr>
              <th rowspan="2" class="px-3 py-2 text-left border-b border-ink-300 align-bottom">Stakeholder</th>
              <th colspan="3" class="px-3 py-1 text-center text-ink-700 border-l border-b border-ink-300">Shares</th>
              <th colspan="3" class="px-3 py-1 text-center text-ink-700 border-l border-b border-ink-300">Ownership %</th>
              <th colspan="3" class="px-3 py-1 text-center text-ink-700 border-l border-b border-ink-300">Value ($)</th>
            </tr>
            <tr>
              <th class="px-3 py-1.5 text-right border-l border-b border-ink-300 w-24">Pre</th>
              <th class="px-3 py-1.5 text-right border-b border-ink-300 w-24 text-accent-700">Post</th>
              <th class="px-3 py-1.5 text-right border-b border-ink-300 w-20">Δ</th>
              <th class="px-3 py-1.5 text-right border-l border-b border-ink-300 w-20">Pre</th>
              <th class="px-3 py-1.5 text-right border-b border-ink-300 w-20 text-accent-700">Post</th>
              <th class="px-3 py-1.5 text-right border-b border-ink-300 w-20">Δ</th>
              <th class="px-3 py-1.5 text-right border-l border-b border-ink-300 w-28">Pre</th>
              <th class="px-3 py-1.5 text-right border-b border-ink-300 w-28 text-accent-700">Post</th>
              <th class="px-3 py-1.5 text-right border-b border-ink-300 w-28">Δ</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in sortedRows" :key="r.stakeholderId" class="hover:bg-accent-50/40">
              <!-- Stakeholder name + type chip -->
              <td class="px-3 py-1.5 border-b border-ink-200">
                <span class="text-ink-900 font-medium" :title="r.name">{{ r.name }}</span>
                <span v-if="r.type" class="ml-1.5 text-[9px] uppercase tracking-wide text-ink-500 bg-ink-100 border border-ink-200 px-1 py-0.5 rounded align-middle">{{ r.type }}</span>
                <span v-if="r.isNewRound" class="ml-1.5 text-[9px] uppercase tracking-wide text-accent-700 bg-accent-50 border border-accent-200 px-1 py-0.5 rounded align-middle">new</span>
              </td>

              <!-- ---- Shares group ---- -->
              <td class="px-3 py-1.5 text-right text-ink-700 border-l border-b border-ink-200">{{ fmtShares(r.preShares) }}</td>
              <td class="px-3 py-1.5 text-right text-ink-900 font-medium border-b border-ink-200">{{ fmtShares(r.postShares) }}</td>
              <td class="px-3 py-1.5 text-right font-semibold border-b border-ink-200"
                  :class="deltaColor(r.postShares - r.preShares)">{{ fmtDeltaShares(r.postShares - r.preShares) }}</td>

              <!-- ---- Ownership % group ---- -->
              <td class="px-3 py-1.5 text-right text-ink-700 border-l border-b border-ink-200">{{ fmtPct(r.prePct, 2) }}</td>
              <td class="px-3 py-1.5 text-right text-ink-900 font-medium border-b border-ink-200">{{ fmtPct(r.postPct, 2) }}</td>
              <td class="px-3 py-1.5 text-right font-semibold border-b border-ink-200"
                  :class="deltaColor(r.postPct - r.prePct)">{{ fmtDeltaPct(r.postPct - r.prePct) }}</td>

              <!-- ---- Value ($) group ---- -->
              <td class="px-3 py-1.5 text-right text-ink-700 border-l border-b border-ink-200">{{ pps > 0 ? fmtUSD(r.preValue) : '—' }}</td>
              <td class="px-3 py-1.5 text-right text-ink-900 font-medium border-b border-ink-200">{{ pps > 0 ? fmtUSD(r.postValue) : '—' }}</td>
              <td class="px-3 py-1.5 text-right font-semibold border-b border-ink-200"
                  :class="deltaColor(r.postValue - r.preValue)">{{ pps > 0 ? fmtDeltaUSD(r.postValue - r.preValue) : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
