<script setup lang="ts">
// Previous-Round card: the typed aggregate covering everything before
// the current round. Edits buffer locally; the operator clicks Save to
// commit. Cmd+S works too. Discard rolls back to the last server state.
//
// Per-field blur-commit was racy: a refresh fired by saving field A
// would clobber field B if the user moved between them quickly. Batch
// save sidesteps that and makes "did this stick?" obvious.
import { Layers, Calculator, Save, Undo2, Check } from 'lucide-vue-next'
import { fmtShares, fmtUSD, fmtPricePerShare } from '~/utils/format'

interface Props { companyId: string }
const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'update:saving-count', n: number): void }>()

interface AggregateRound {
  pre_money: number | null
  new_money: number | null
  share_price: number | null
  cumulated_financing: number | null
  total_shares_fds: number | null
  option_pool_total: number | null
  pool_attributed: number
  pool_available: number
  grants_breakdown: { outstanding: number; exercised: number; forfeited: number; expired: number }
  updated_at: string | null
}

const { data, refresh } = await useFetch<AggregateRound>(() => `/api/companies/${props.companyId}/aggregate-round`, { watch: [() => props.companyId] })

// Local editable copy. Bound directly via v-model. Resynced from
// server data when the operator isn't dirty (so an external refresh
// doesn't blow away in-progress edits).
const preMoney         = ref<number | null>(null)
const newMoney         = ref<number | null>(null)
const sharePrice       = ref<number | null>(null)
const cumulFinancing   = ref<number | null>(null)
const totalSharesFds   = ref<number | null>(null)
const optionPoolTotal  = ref<number | null>(null)

function syncFromServer(d: AggregateRound | null) {
  if (!d) return
  preMoney.value         = d.pre_money
  newMoney.value         = d.new_money
  sharePrice.value       = d.share_price
  cumulFinancing.value   = d.cumulated_financing
  totalSharesFds.value   = d.total_shares_fds
  optionPoolTotal.value  = d.option_pool_total
}

// Comparison helper: NumberInput emits null for empty fields, so null
// and undefined both mean "no value." Treat them as equal.
function eq(a: number | null | undefined, b: number | null | undefined) {
  if (a == null && b == null) return true
  return a === b
}

const dirty = computed(() => {
  const d = data.value
  if (!d) return false
  return !eq(preMoney.value,        d.pre_money)
      || !eq(newMoney.value,        d.new_money)
      || !eq(sharePrice.value,      d.share_price)
      || !eq(cumulFinancing.value,  d.cumulated_financing)
      || !eq(totalSharesFds.value,  d.total_shares_fds)
      || !eq(optionPoolTotal.value, d.option_pool_total)
})

// First server payload always syncs (local refs start null, so the
// dirty check would otherwise fire on an empty/server mismatch and we'd
// never seed the fields). After that, refreshes skip when the operator
// has unsaved edits — that's the whole point of the Save button.
let hasSyncedOnce = false
watch(data, (d) => {
  if (!d) return
  if (hasSyncedOnce && dirty.value) return
  syncFromServer(d)
  hasSyncedOnce = true
}, { immediate: true })

const saving = ref(false)
const justSaved = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | null = null

async function save() {
  if (!dirty.value || saving.value) return
  saving.value = true
  emit('update:saving-count', 1)
  try {
    await $fetch(`/api/companies/${props.companyId}/aggregate-round`, {
      method: 'POST',
      body: {
        pre_money:           preMoney.value,
        new_money:           newMoney.value,
        share_price:         sharePrice.value,
        cumulated_financing: cumulFinancing.value,
        total_shares_fds:    totalSharesFds.value,
        option_pool_total:   optionPoolTotal.value,
      },
    })
    await refresh()
    justSaved.value = true
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => { justSaved.value = false }, 2000)
  } catch (e) {
    console.error('Save failed', e)
  } finally {
    saving.value = false
    emit('update:saving-count', 0)
  }
}

function discard() {
  syncFromServer(data.value ?? null)
}

// Cmd+S / Ctrl+S = save while focus is anywhere inside the card.
const cardEl = ref<HTMLElement | null>(null)
function onKeyDown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    if (cardEl.value?.contains(document.activeElement)) {
      e.preventDefault()
      void save()
    }
  }
}
onMounted(() => { window.addEventListener('keydown', onKeyDown) })
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  if (savedTimer) clearTimeout(savedTimer)
})

// Derived live values (from local refs so they react as you type).
const postMoney = computed(() => {
  if (preMoney.value == null && newMoney.value == null) return null
  return (preMoney.value || 0) + (newMoney.value || 0)
})
const poolAvailable = computed(() => {
  if (optionPoolTotal.value == null) return null
  return optionPoolTotal.value - (data.value?.pool_attributed ?? 0)
})
</script>

<template>
  <section ref="cardEl" class="rounded-xl border bg-white shadow-[0_1px_0_rgba(16,24,40,0.04)]" :class="dirty ? 'border-amber-300' : 'border-ink-200'">
    <header class="px-5 py-3 border-b border-ink-100 flex items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <div class="grid place-items-center w-7 h-7 rounded-md bg-ink-100 text-ink-600">
          <Layers :size="14" />
        </div>
        <div>
          <h2 class="text-[14px] font-semibold text-ink-900">Previous Round</h2>
          <p class="text-[11px] text-ink-500 leading-tight">All closed rounds, rolled up</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span v-if="dirty" class="text-[11px] text-amber-700 font-medium">Unsaved changes</span>
        <span v-else-if="justSaved" class="text-[11px] text-ok inline-flex items-center gap-1 font-medium"><Check :size="11" /> Saved</span>
        <button
          v-if="dirty"
          type="button"
          class="inline-flex items-center gap-1 text-[11.5px] text-ink-600 hover:text-ink-900 px-2 py-1 rounded hover:bg-ink-100"
          @click="discard"
        ><Undo2 :size="11" /> Discard</button>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-md transition-colors"
          :class="dirty && !saving
            ? 'bg-brand text-white hover:bg-brand-deep'
            : 'bg-ink-100 text-ink-400 cursor-not-allowed'"
          :disabled="!dirty || saving"
          :title="dirty ? 'Save changes (⌘S)' : 'Nothing to save'"
          @click="save"
        ><Save :size="12" /> {{ saving ? 'Saving…' : 'Save' }}</button>
      </div>
    </header>

    <div class="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
      <div>
        <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Pre-money valuation</label>
        <NumberInput v-model="preMoney" prefix="$" placeholder="0" class="w-full" />
      </div>
      <div>
        <label class="block text-[11.5px] font-medium text-ink-700 mb-1">New money</label>
        <NumberInput v-model="newMoney" prefix="$" placeholder="0" class="w-full" />
      </div>

      <div>
        <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Share price</label>
        <NumberInput v-model="sharePrice" prefix="$" :digits="5" placeholder="—" class="w-full" />
      </div>
      <div>
        <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Cumulative financing <span class="text-ink-400 font-normal">to date</span></label>
        <NumberInput v-model="cumulFinancing" prefix="$" placeholder="0" class="w-full" />
      </div>

      <div>
        <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Total fully-diluted shares <span class="text-ink-400 font-normal">to date</span></label>
        <NumberInput v-model="totalSharesFds" placeholder="0" class="w-full" />
      </div>
      <div>
        <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Total option pool</label>
        <NumberInput v-model="optionPoolTotal" placeholder="0" class="w-full" />
      </div>
    </div>

    <!-- Derived footer: post-money + pool attribution math. -->
    <div class="px-5 py-3 border-t border-ink-100 bg-ink-50/40 grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-[12px]">
      <div>
        <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium">Post-money</div>
        <div class="num font-semibold text-ink-900">{{ postMoney != null ? fmtUSD(postMoney) : '—' }}</div>
      </div>
      <div>
        <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium">Pool attributed</div>
        <div class="num font-semibold text-ink-900" :title="`Outstanding ${fmtShares(data?.grants_breakdown.outstanding || 0)} + Exercised ${fmtShares(data?.grants_breakdown.exercised || 0)}`">
          {{ data ? fmtShares(data.pool_attributed) : '—' }}
        </div>
      </div>
      <div>
        <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium flex items-center gap-1"><Calculator :size="10" /> Available</div>
        <div class="num font-semibold" :class="(poolAvailable ?? 0) < 0 ? 'text-red-700' : 'text-ok'">
          {{ poolAvailable != null ? fmtShares(poolAvailable) : '—' }}
        </div>
      </div>
      <div v-if="sharePrice">
        <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium">Share price</div>
        <div class="num text-ink-700">{{ fmtPricePerShare(sharePrice) }}</div>
      </div>
    </div>
  </section>
</template>
