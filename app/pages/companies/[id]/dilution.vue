<script setup lang="ts">
// Overall Dilution — simple table: per-stakeholder pre/post shares and
// ownership %, plus the Δ% that shows the dilution effect of the open
// round at a glance. Sorted by Δ% ascending (most-diluted at top).
import { fmtPct, fmtShares } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

const computeBody = computed(() => ({}))
const { data: compute } = await useFetch(() => `/api/companies/${id.value}/compute`, {
  method: 'POST',
  body: computeBody,
  watch: [id],
})
const { data: roundSummary } = await useFetch<{ rounds: Array<{ code: string; name: string | null; kind: string }> }>(
  () => `/api/companies/${id.value}/round-summary`,
  { watch: [id], default: () => ({ rounds: [] }) },
)
const openRoundName = computed(() => {
  const r = roundSummary.value?.rounds.find(x => x.kind === 'open')
  return r?.name || r?.code || 'open round'
})

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
  return list.map(d => ({
    stakeholderId: d.stakeholderId,
    name: d.name,
    type: d.type || null,
    preShares: d.preShares || 0,
    postShares: d.postShares || 0,
    prePct: d.prePct || 0,
    postPct: d.postPct || 0,
    isNewRound: String(d.stakeholderId).startsWith('new:') || String(d.stakeholderId).startsWith('idea:'),
  }))
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
