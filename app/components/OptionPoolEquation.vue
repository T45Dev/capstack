<script setup lang="ts">
// The Option-Pool identity, as one reusable artifact so the Pool Impact and
// Option Grants pages (and anything else) render the SAME equation — no more
// re-creating the formula per page and watching it drift.
//
//   Authorized(net of exercised) − Attributed/Outstanding
//     = Available − Committed [− Proposed] = Future Available
//
// Two lifecycle states are folded INTO Authorized rather than shown as
// separate equation terms (they'd otherwise read as double counting):
//   • Exercised — converted to common (FDS, not the pool), so netted out of
//     Authorized. Surfaced in the Authorized tooltip.
//   • Forfeited/Expired — returned to the pool, so they fall naturally back
//     into Available (Authorized − Outstanding); no add-back term needed.
// The only thing subtracted from Authorized is Outstanding — the options
// attributed to grantees and still live.
//
// The arithmetic is computed once by shared/capTableModel.poolEquation(); this
// component is purely the aligned, collapsible presentation of those figures
// and builds its own calc-tooltips from them.
//
// Every term and operator carries identical vertical metrics (transparent
// border + py-1 + leading-none) so items-end lines all figures on one baseline.
//
// One in-equation collapse (persisted per `storagePrefix`):
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

// Per-term collapse state. Default expanded; collapsing is opt-in and persisted
// so the operator's choice sticks.
const extrasCollapsed = ref(false)
function persist(key: string, v: boolean) {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(key, String(v)) } catch { /* ignore */ }
}
onMounted(() => {
  try { const v = localStorage.getItem(`${props.storagePrefix}:extras-collapsed`); if (v != null) extrasCollapsed.value = v === 'true' } catch { /* ignore */ }
})
watch(extrasCollapsed, v => persist(`${props.storagePrefix}:extras-collapsed`, v))

const f = computed(() => props.figures)
const proposedPlusIdeas = computed(() => f.value.proposed + f.value.ideas)

// Calc-tooltip strings, built from the figures so they always match the cells.
// Exercised options converted to common (they're FDS, not the option pool), so
// they're removed from Authorized — not from Available.
const fAuthorized = computed(() => f.value.exercised > 0
  ? `Reserve ${fmtShares(f.value.authorizedGross)} − exercised ${fmtShares(f.value.exercised)} (→ common) = ${fmtShares(f.value.authorized)}`
  : `${fmtShares(f.value.authorized)} authorized`)
const fOutstanding = computed(() => f.value.forfeitedOrExpired > 0
  ? `Options attributed to grantees and still outstanding (${fmtShares(f.value.outstanding)}). Forfeited/expired ${fmtShares(f.value.forfeitedOrExpired)} returned to the pool, so they sit in Available.`
  : `Options attributed to grantees and still outstanding (${fmtShares(f.value.outstanding)}).`)
const fAvailable = computed(() => `Authorized ${fmtShares(f.value.authorized)} − outstanding ${fmtShares(f.value.outstanding)} = ${fmtShares(f.value.available)}`)
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
      <span class="text-[10px] uppercase tracking-wider text-ink-500" :title="f.exercised > 0 ? 'Reserve net of exercised options (those converted to common — now FDS, not the pool).' : 'Authorized option pool.'">Authorized</span>
      <span class="text-2xl font-semibold leading-none text-ink-800"><UiCalcTip :formula="fAuthorized">{{ fmtShares(f.authorized) }}</UiCalcTip></span>
    </div>
    <span class="text-2xl text-ink-400 leading-none border border-transparent py-1">−</span>
    <!-- Attributed / Outstanding — options granted out of the pool and still
         live. Exercised (→ common) is netted out of Authorized above, and
         forfeited/expired (→ returned to pool) falls back into Available, so
         neither appears as its own equation term. -->
    <div class="flex flex-col items-start rounded-md border border-transparent px-2 py-1">
      <span class="text-[10px] uppercase tracking-wider text-ink-500" title="Options attributed to grantees and still outstanding (granted, not yet exercised, forfeited, or expired).">Attributed / Outstanding</span>
      <span class="text-2xl font-semibold leading-none text-ink-800"><UiCalcTip :formula="fOutstanding">{{ fmtShares(f.outstanding) }}</UiCalcTip></span>
    </div>
    <span class="text-2xl text-ink-400 leading-none border border-transparent py-1">=</span>
    <div class="flex flex-col items-start rounded-md border border-transparent px-2 py-1">
      <span class="text-[10px] uppercase tracking-wider text-ink-500">Available</span>
      <span class="text-2xl font-semibold leading-none" :class="f.available < 0 ? 'text-red-700' : 'text-ok'"><UiCalcTip :formula="fAvailable">{{ fmtShares(f.available) }}</UiCalcTip></span>
    </div>
    <!-- Proposed and Ideas — the future deductions. When ideas are shown they
         can fold into one "Committed + Proposed" figure; otherwise just Committed. -->
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
