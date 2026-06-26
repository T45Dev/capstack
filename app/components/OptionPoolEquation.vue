<script setup lang="ts">
// The Option-Pool identity, as one reusable artifact so the Pool Impact and
// Option Grants pages (and anything else) render the SAME equation — no more
// re-creating the formula per page and watching it drift.
//
//   Authorized − Issued(= Outstanding + Exercised + Forfeited/Expired)
//     + Forfeited/Expired = Available − Proposed [− Ideas] = Future Available
//
// The arithmetic is computed once by shared/capTableModel.poolEquation(); this
// component is purely the aligned, collapsible presentation of those figures
// and builds its own calc-tooltips from them.
//
// Every term and operator carries identical vertical metrics (transparent
// border + py-1 + leading-none) so items-end lines all figures on one baseline;
// the Issued box just swaps its transparent border for a visible one when
// expanded, so collapsing/expanding it never nudges the row.
//
// Two in-equation collapses (persisted per `storagePrefix`):
//   • Issued       — fold the breakdown to a single figure.
//   • Proposed+Ideas — combine the two future deductions (only when showIdeas).
import { ChevronRight, ChevronDown } from 'lucide-vue-next'
import { fmtShares } from '~/utils/format'
import type { PoolEquationFigures } from '~/utils/capTable'

interface Props {
  figures: PoolEquationFigures
  // Render (and treat as deducted) the Ideas term. When false, only Proposed
  // shows and the Proposed+Ideas combine is hidden. Default true.
  showIdeas?: boolean
  // localStorage namespace for the per-term collapse state (e.g. 'capstack:pool').
  storagePrefix: string
}
const props = withDefaults(defineProps<Props>(), { showIdeas: true })

// Per-term collapse state. Default expanded (breakdown visible); collapsing is
// opt-in and persisted so the operator's choice sticks.
const issuedCollapsed = ref(false)
const extrasCollapsed = ref(false)
function persist(key: string, v: boolean) {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(key, String(v)) } catch { /* ignore */ }
}
onMounted(() => {
  try { const v = localStorage.getItem(`${props.storagePrefix}:issued-collapsed`); if (v != null) issuedCollapsed.value = v === 'true' } catch { /* ignore */ }
  try { const v = localStorage.getItem(`${props.storagePrefix}:extras-collapsed`); if (v != null) extrasCollapsed.value = v === 'true' } catch { /* ignore */ }
})
watch(issuedCollapsed, v => persist(`${props.storagePrefix}:issued-collapsed`, v))
watch(extrasCollapsed, v => persist(`${props.storagePrefix}:extras-collapsed`, v))

const f = computed(() => props.figures)
const proposedPlusIdeas = computed(() => f.value.proposed + f.value.ideas)

// Calc-tooltip strings, built from the figures so they always match the cells.
const fIssued = computed(() => `Outstanding ${fmtShares(f.value.outstanding)} + exercised ${fmtShares(f.value.exercised)} + forfeited/expired ${fmtShares(f.value.forfeitedOrExpired)} = ${fmtShares(f.value.issued)}`)
const fOutstanding = computed(() => `Issued ${fmtShares(f.value.issued)} − exercised ${fmtShares(f.value.exercised)} − forfeited/expired ${fmtShares(f.value.forfeitedOrExpired)} = ${fmtShares(f.value.outstanding)}`)
const fAvailable = computed(() => `Authorized ${fmtShares(f.value.authorized)} − outstanding ${fmtShares(f.value.outstanding)} − exercised ${fmtShares(f.value.exercised)} = ${fmtShares(f.value.available)}`)
const fProposedIdeas = computed(() => `Committed ${fmtShares(f.value.proposed)} + proposed ${fmtShares(f.value.ideas)} = ${fmtShares(proposedPlusIdeas.value)}`)
const fFutureAvailable = computed(() => {
  const parts = [`Available ${fmtShares(f.value.available)}`, `− committed ${fmtShares(f.value.proposed)}`]
  if (props.showIdeas) parts.push(`− proposed ${fmtShares(f.value.ideas)}`)
  return `${parts.join(' ')} = ${fmtShares(f.value.futureAvailable)}`
})
</script>

<template>
  <div class="flex flex-wrap items-end gap-1.5 text-ink-900 num">
    <div class="flex flex-col items-start rounded-md border border-transparent px-2 py-1">
      <span class="text-[10px] uppercase tracking-wider text-ink-500">Authorized</span>
      <span class="text-2xl font-semibold leading-none text-ink-800">{{ fmtShares(f.authorized) }}</span>
    </div>
    <span class="text-2xl text-ink-400 leading-none border border-transparent py-1">−</span>
    <!-- Issued — collapses to a single figure, or expands into where every
         granted option went. The bordered group equals Issued (Outstanding
         + Exercised + Forfeited/Expired). Forfeited/Expired is then added
         back outside because those shares return to the pool, so the two
         F/E terms cancel — leaving Authorized − Outstanding − Exercised. -->
    <div class="flex items-end gap-2 rounded-md border px-2 py-1" :class="issuedCollapsed ? 'border-transparent' : 'border-ink-200 bg-ink-50'">
      <div class="flex flex-col items-start">
        <span class="text-[10px] uppercase tracking-wider text-ink-500 inline-flex items-center gap-1" title="Every option ever granted out of the pool.">
          Issued
          <button
            type="button"
            class="text-ink-400 hover:text-ink-700"
            :title="issuedCollapsed ? 'Show Issued breakdown' : 'Collapse Issued to one number'"
            @click="issuedCollapsed = !issuedCollapsed"
          >
            <ChevronRight v-if="issuedCollapsed" :size="11" />
            <ChevronDown v-else :size="11" />
          </button>
        </span>
        <span class="text-2xl font-semibold leading-none text-ink-800"><UiCalcTip :formula="fIssued">{{ fmtShares(f.issued) }}</UiCalcTip></span>
      </div>
      <template v-if="!issuedCollapsed">
        <span class="text-2xl text-ink-400 leading-none">=</span>
        <span class="text-2xl text-ink-400 leading-none">(</span>
        <div class="flex flex-col items-start">
          <span class="text-[10px] uppercase tracking-wider text-ink-500" title="Options currently held (granted, not yet exercised, forfeited, or expired).">Outstanding</span>
          <span class="text-2xl font-semibold leading-none text-ink-800"><UiCalcTip :formula="fOutstanding">{{ fmtShares(f.outstanding) }}</UiCalcTip></span>
        </div>
        <span class="text-2xl text-ink-400 leading-none">+</span>
        <div class="flex flex-col items-start">
          <span class="text-[10px] uppercase tracking-wider text-ink-500" title="Exercised options converted to Common stock and permanently left the pool.">Exercised</span>
          <span class="text-2xl font-semibold leading-none" :class="f.exercised > 0 ? 'text-ink-800' : 'text-ink-400'">{{ fmtShares(f.exercised) }}</span>
        </div>
        <span class="text-2xl text-ink-400 leading-none">+</span>
        <div class="flex flex-col items-start">
          <span class="text-[10px] uppercase tracking-wider text-ink-500" title="Forfeited or expired grants — part of Issued, then returned to the pool below.">Forfeited/Expired</span>
          <span class="text-2xl font-semibold leading-none" :class="f.forfeitedOrExpired > 0 ? 'text-ink-800' : 'text-ink-400'">{{ fmtShares(f.forfeitedOrExpired) }}</span>
        </div>
        <span class="text-2xl text-ink-400 leading-none">)</span>
      </template>
    </div>
    <span class="text-2xl text-ink-400 leading-none border border-transparent py-1">+</span>
    <div class="flex flex-col items-start rounded-md border border-transparent px-2 py-1">
      <span class="text-[10px] uppercase tracking-wider text-ink-500" title="Forfeited/expired shares return to the pool, cancelling their inclusion in Issued.">Forfeited/Expired</span>
      <span class="text-2xl font-semibold leading-none" :class="f.forfeitedOrExpired > 0 ? 'text-ink-800' : 'text-ink-400'">{{ fmtShares(f.forfeitedOrExpired) }}</span>
    </div>
    <span class="text-2xl text-ink-400 leading-none border border-transparent py-1">=</span>
    <div class="flex flex-col items-start rounded-md border border-transparent px-2 py-1">
      <span class="text-[10px] uppercase tracking-wider text-ink-500">Available</span>
      <span class="text-2xl font-semibold leading-none" :class="f.available < 0 ? 'text-red-700' : 'text-ok'"><UiCalcTip :formula="fAvailable">{{ fmtShares(f.available) }}</UiCalcTip></span>
    </div>
    <!-- Proposed and Ideas — the future deductions. When ideas are shown they
         can fold into one "Proposed + Ideas" figure; otherwise just Proposed. -->
    <template v-if="showIdeas && extrasCollapsed">
      <span class="text-2xl text-ink-400 leading-none border border-transparent py-1">−</span>
      <div class="flex flex-col items-start rounded-md border border-transparent px-2 py-1">
        <span class="text-[10px] uppercase tracking-wider text-ink-500 inline-flex items-center gap-1">
          Committed + Proposed
          <button type="button" class="text-ink-400 hover:text-ink-700" title="Show Committed and Proposed separately" @click="extrasCollapsed = false">
            <ChevronRight :size="11" />
          </button>
        </span>
        <span class="text-2xl font-semibold leading-none text-warn"><UiCalcTip :formula="fProposedIdeas">{{ fmtShares(proposedPlusIdeas) }}</UiCalcTip></span>
      </div>
    </template>
    <template v-else>
      <span class="text-2xl text-ink-400 leading-none border border-transparent py-1">−</span>
      <div class="flex flex-col items-start rounded-md border border-transparent px-2 py-1">
        <span class="text-[10px] uppercase tracking-wider text-ink-500 inline-flex items-center gap-1">
          Committed
          <button v-if="showIdeas" type="button" class="text-ink-400 hover:text-ink-700" title="Combine Committed and Proposed into one number" @click="extrasCollapsed = true">
            <ChevronDown :size="11" />
          </button>
        </span>
        <span class="text-2xl font-semibold leading-none text-warn">{{ fmtShares(f.proposed) }}</span>
      </div>
      <template v-if="showIdeas">
        <span class="text-2xl text-ink-400 leading-none border border-transparent py-1">−</span>
        <div class="flex flex-col items-start rounded-md border border-transparent px-2 py-1">
          <span class="text-[10px] uppercase tracking-wider text-ink-500">Proposed</span>
          <span class="text-2xl font-semibold leading-none text-amber-500">{{ fmtShares(f.ideas) }}</span>
        </div>
      </template>
    </template>
    <span class="text-2xl text-ink-400 leading-none border border-transparent py-1">=</span>
    <div class="flex flex-col items-start rounded-md border border-transparent px-2 py-1">
      <span class="text-[10px] uppercase tracking-wider text-ink-500">Future Available</span>
      <span class="text-2xl font-semibold leading-none" :class="f.futureAvailable < 0 ? 'text-red-700' : 'text-ok'"><UiCalcTip :formula="fFutureAvailable">{{ fmtShares(f.futureAvailable) }}</UiCalcTip></span>
    </div>
  </div>
</template>
