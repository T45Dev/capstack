<script setup lang="ts">
// Overall Dilution — simple table: per-stakeholder pre/post shares and
// ownership %, plus the Δ% that shows the dilution effect of the open
// round at a glance. Sorted by Δ% ascending (most-diluted at top).
//
// Denominators (per user spec):
//   - post% denominator = the open round's total FDS (from Financings)
//   - pre%  denominator = the round IMMEDIATELY BEFORE the open round's
//                         total FDS (from Financings)
// This is what produces visible dilution: most existing holders'
// share counts don't change in a new round, but the denominator
// grows, so their % drops.
import { fmtPct, fmtShares } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

const computeBody = computed(() => ({}))
const { data: compute } = await useFetch(() => `/api/companies/${id.value}/compute`, {
  method: 'POST',
  body: computeBody,
  watch: [id],
})
const { data: roundSummary } = await useFetch<{ rounds: Array<{ code: string; name: string | null; kind: string; total_shares_fds: number }> }>(
  () => `/api/companies/${id.value}/round-summary`,
  { watch: [id], default: () => ({ rounds: [] }) },
)

// Identify the open round and the round immediately before it in the
// chronological round list. roundSummary returns rounds sorted with
// the open round last (closed rounds first by close_date), so the
// "previous" round is the one at openIndex - 1.
const openRound = computed(() => roundSummary.value?.rounds.find(r => r.kind === 'open') || null)
const openRoundName = computed(() => openRound.value?.name || openRound.value?.code || 'open round')
const previousRound = computed(() => {
  const rounds = roundSummary.value?.rounds || []
  const openIdx = rounds.findIndex(r => r.kind === 'open')
  if (openIdx <= 0) return null
  return rounds[openIdx - 1] || null
})

// Denominators from the Financings table.
const preFDS = computed(() => previousRound.value?.total_shares_fds || 0)
const postFDS = computed(() => openRound.value?.total_shares_fds || 0)

interface DilRow {
  stakeholderId: string
  name: string
  type: string | null
  preShares: number
  postShares: number
  prePct: number
  postPct: number
  isNewRound: boolean
}

const rows = computed<DilRow[]>(() => {
  const list = (compute.value?.dilution || []) as any[]
  const pre = preFDS.value
  const post = postFDS.value
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
      isNewRound: String(d.stakeholderId).startsWith('new:') || String(d.stakeholderId).startsWith('idea:'),
    }
  })
})

// Sort by Δ% ascending — most-diluted (largest negative Δ) at the
// top is what the operator usually wants to see first.
const sortedRows = computed(() =>
  [...rows.value].sort((a, b) => (a.postPct - a.prePct) - (b.postPct - b.prePct)),
)

// Visual bar scale: clamp by the largest post-% across all rows so a
// single dominant holder doesn't squash everyone else's bar.
const maxPct = computed(() =>
  Math.max(0.001, ...rows.value.map(r => Math.max(r.prePct, r.postPct))),
)
function barWidth(pct: number): string {
  return `${Math.max(0, Math.min(100, (pct / maxPct.value) * 100))}%`
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
        Δ% = post − pre; red = dilution, green = growth.
      </p>
      <!-- Surface the two denominators so the math reads honestly:
           pre% uses the round-before-open's total FDS, post% uses the
           open round's total FDS. Both come from the Financings table
           (round-summary endpoint). -->
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
      </div>
      <div v-else class="mt-2 text-[11px] text-amber-700">
        No round is flagged as "Open" on the Financings page — set one to model dilution against it.
      </div>
    </div>

    <!-- Table -->
    <div class="rounded-lg border border-ink-300 bg-white shadow-card flex flex-col min-h-0 flex-1 overflow-hidden">
      <div v-if="!sortedRows.length" class="px-4 py-12 text-center text-sm text-ink-500">
        No data yet — set a round to "Open" on the Financings page to model dilution against it.
      </div>
      <div v-else class="overflow-y-auto min-h-0 flex-1">
        <table class="w-full text-[13px] num">
          <thead class="text-left text-ink-500 text-[10px] uppercase tracking-wider font-semibold bg-ink-100 sticky top-0 z-10">
            <tr>
              <th class="px-3 py-2">Stakeholder</th>
              <th class="px-3 py-2 text-right w-28">Pre shares</th>
              <th class="px-3 py-2 text-right w-20">Pre %</th>
              <th class="px-3 py-2 text-right w-28 text-accent-700">Post shares</th>
              <th class="px-3 py-2 text-right w-20 text-accent-700">Post %</th>
              <th class="px-3 py-2 text-right w-20">Δ %</th>
              <th class="px-3 py-2 w-[28%]">Pre vs post</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in sortedRows" :key="r.stakeholderId" class="hover:bg-accent-50/40 border-b border-ink-200">
              <td class="px-3 py-1.5">
                <span class="text-ink-900 font-medium" :title="r.name">{{ r.name }}</span>
                <span v-if="r.type" class="ml-1.5 text-[9px] uppercase tracking-wide text-ink-500 bg-ink-100 border border-ink-200 px-1 py-0.5 rounded align-middle">{{ r.type }}</span>
                <span v-if="r.isNewRound" class="ml-1.5 text-[9px] uppercase tracking-wide text-accent-700 bg-accent-50 border border-accent-200 px-1 py-0.5 rounded align-middle">new</span>
              </td>
              <td class="px-3 py-1.5 text-right text-ink-700">{{ fmtShares(r.preShares) }}</td>
              <td class="px-3 py-1.5 text-right text-ink-700">{{ fmtPct(r.prePct, 2) }}</td>
              <td class="px-3 py-1.5 text-right text-ink-900 font-medium">{{ fmtShares(r.postShares) }}</td>
              <td class="px-3 py-1.5 text-right text-ink-900 font-medium">{{ fmtPct(r.postPct, 2) }}</td>
              <td
                class="px-3 py-1.5 text-right font-semibold"
                :class="(r.postPct - r.prePct) > 0.000001 ? 'text-emerald-700' : (r.postPct - r.prePct) < -0.000001 ? 'text-red-600' : 'text-ink-400'"
              >{{ r.postPct === r.prePct ? '0.00%' : ((r.postPct - r.prePct) > 0 ? '+' : '') + fmtPct(r.postPct - r.prePct, 2) }}</td>
              <td class="px-3 py-1.5">
                <!-- Visual: pre% as a gray track, post% as colored
                     overlay (green if grew, red if diluted). -->
                <div class="relative h-2.5 rounded bg-ink-100 overflow-hidden">
                  <div class="absolute inset-y-0 left-0 bg-ink-300/70" :style="{ width: barWidth(r.prePct) }" :title="`Pre: ${fmtPct(r.prePct, 2)}`" />
                  <div
                    class="absolute inset-y-0 left-0"
                    :class="r.postPct >= r.prePct ? 'bg-emerald-400/70' : 'bg-red-400/70'"
                    :style="{ width: barWidth(r.postPct) }"
                    :title="`Post: ${fmtPct(r.postPct, 2)}`"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
