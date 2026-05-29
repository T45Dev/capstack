<script setup lang="ts">
// Open-Round card: the currently-modeled round. Lives in the existing
// rounds table with kind='open' so the rest of the cap-table logic
// (per-investor allocations, scenarios) keeps working unchanged.
import { Sparkles, Plus, Calculator, Trash2 } from 'lucide-vue-next'
import { fmtShares, fmtUSD, fmtPricePerShare } from '~/utils/format'

interface Props { companyId: string }
const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'update:saving-count', n: number): void
  (e: 'refreshed'): void
}>()

interface OpenRound {
  id: string
  code: string
  name: string | null
  close_date: string | null
  share_price: number | null
  new_money: number | null
  pre_money: number | null
  option_pool_issued: number | null
}

interface Aggregate {
  total_shares_fds: number | null
  option_pool_total: number | null
  pool_attributed: number
}

const { data: roundSummary, refresh: refreshRound } = await useFetch<{ rounds: any[] }>(() => `/api/companies/${props.companyId}/round-summary`, { watch: [() => props.companyId] })
const { data: agg } = await useFetch<Aggregate>(() => `/api/companies/${props.companyId}/aggregate-round`, { watch: [() => props.companyId] })

const round = computed<OpenRound | null>(() => {
  const r = (roundSummary.value?.rounds || []).find((x: any) => x.kind === 'open')
  return r ? {
    id: r.round_id,
    code: r.code,
    name: r.name,
    close_date: r.close_date,
    share_price: r.share_price,
    new_money: r.new_money,
    pre_money: r.pre_money,
    option_pool_issued: r.option_pool_issued,
  } : null
})

// Local editable copy; synced from server data on round changes.
const name              = ref<string>('')
const closeDate         = ref<string | null>(null)
const preMoney          = ref<number | null>(null)
const newMoney          = ref<number | null>(null)
const sharePrice        = ref<number | null>(null)
const optionPoolIssued  = ref<number | null>(null)

watch(round, (r) => {
  if (!r) return
  name.value             = r.name || ''
  closeDate.value        = r.close_date
  preMoney.value         = r.pre_money
  newMoney.value         = r.new_money
  sharePrice.value       = r.share_price
  optionPoolIssued.value = r.option_pool_issued
}, { immediate: true })

const saving = ref(0)
function emitSaving(delta: number) {
  saving.value = Math.max(0, saving.value + delta)
  emit('update:saving-count', saving.value)
}

async function commit(field: string, value: any) {
  if (!round.value) return
  emitSaving(+1)
  try {
    await $fetch(`/api/rounds/${round.value.id}`, {
      method: 'PATCH',
      body: { [field]: value },
    })
    await refreshRound()
    emit('refreshed')
  } catch (e) {
    console.error(`Couldn't save ${field}`, e)
  } finally {
    emitSaving(-1)
  }
}

async function createOpenRound() {
  emitSaving(+1)
  try {
    await $fetch(`/api/companies/${props.companyId}/rounds`, {
      method: 'POST',
      body: {
        kind: 'open',
        close_date: new Date().toISOString().slice(0, 10),
        name: 'Series B',
      },
    })
    await refreshRound()
    emit('refreshed')
  } catch (e) { console.error('Failed to create open round', e) }
  finally { emitSaving(-1) }
}

async function deleteOpenRound() {
  if (!round.value) return
  if (!confirm('Delete the open round? This wipes its allocations too.')) return
  emitSaving(+1)
  try {
    await $fetch(`/api/rounds/${round.value.id}`, { method: 'DELETE' })
    await refreshRound()
    emit('refreshed')
  } catch (e) { console.error('Failed to delete open round', e) }
  finally { emitSaving(-1) }
}

// Derived projections.
const postMoney = computed(() => {
  if (preMoney.value == null && newMoney.value == null) return null
  return (preMoney.value || 0) + (newMoney.value || 0)
})

const newShares = computed(() => {
  if (!newMoney.value || !sharePrice.value) return null
  return Math.floor(newMoney.value / sharePrice.value)
})

const totalSharesFdsPost = computed(() => {
  const base = agg.value?.total_shares_fds ?? 0
  const issued = newShares.value ?? 0
  const pool = optionPoolIssued.value ?? 0
  if (!base && !issued && !pool) return null
  return base + issued + pool
})

const poolAvailablePost = computed(() => {
  const total = (agg.value?.option_pool_total ?? 0) + (optionPoolIssued.value ?? 0)
  const attributed = agg.value?.pool_attributed ?? 0
  if (!total && !attributed) return null
  return total - attributed
})

const ownership = computed(() => {
  // What % of the post-close FDS the new shares represent. Lets the
  // operator see how much dilution this round buys at current terms.
  if (!newShares.value || !totalSharesFdsPost.value) return null
  return newShares.value / totalSharesFdsPost.value
})
</script>

<template>
  <section class="rounded-xl border border-brand-300 bg-white shadow-[0_1px_0_rgba(16,24,40,0.04)]">
    <header class="px-5 py-3 border-b border-ink-100 flex items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <div class="grid place-items-center w-7 h-7 rounded-md bg-brand-soft text-brand-edge">
          <Sparkles :size="14" />
        </div>
        <div>
          <h2 class="text-[14px] font-semibold text-ink-900">Open Round</h2>
          <p class="text-[11px] text-ink-500 leading-tight">Currently raising — iterates as you tweak the terms</p>
        </div>
      </div>
      <button v-if="round" class="text-[11px] text-ink-500 hover:text-red-600 inline-flex items-center gap-1" @click="deleteOpenRound">
        <Trash2 :size="11" /> delete
      </button>
    </header>

    <div v-if="!round" class="px-5 py-10 text-center">
      <p class="text-[13px] text-ink-600">No open round yet.</p>
      <UiButton variant="primary" size="md" class="mt-3" @click="createOpenRound">
        <Plus :size="14" /> Start an open round
      </UiButton>
    </div>

    <template v-else>
      <!-- Row 1: name + close date -->
      <div class="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 border-b border-ink-100">
        <div>
          <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Round name</label>
          <input
            v-model="name"
            type="text"
            class="w-full px-2 py-1.5 text-sm border border-ink-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30"
            placeholder="Series B"
            @blur="commit('name', name)"
          />
        </div>
        <div>
          <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Close date <span class="text-ink-400 font-normal">(target)</span></label>
          <DateInput v-model="closeDate" class="w-full" @blur="commit('close_date', closeDate)" />
        </div>
      </div>

      <!-- Row 2: typed money/share fields -->
      <div class="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
        <div>
          <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Pre-money valuation</label>
          <NumberInput v-model="preMoney" prefix="$" placeholder="0" class="w-full" @blur="commit('pre_money', preMoney)" />
        </div>
        <div>
          <label class="block text-[11.5px] font-medium text-ink-700 mb-1">New money</label>
          <NumberInput v-model="newMoney" prefix="$" placeholder="0" class="w-full" @blur="commit('new_money', newMoney)" />
        </div>
        <div>
          <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Share price</label>
          <NumberInput v-model="sharePrice" prefix="$" :digits="5" placeholder="—" class="w-full" @blur="commit('share_price', sharePrice)" />
        </div>
        <div>
          <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Option pool top-up</label>
          <NumberInput v-model="optionPoolIssued" placeholder="0" class="w-full" @blur="commit('option_pool_issued', optionPoolIssued)" />
        </div>
      </div>

      <!-- Derived footer: live cap-table impact of the open-round terms. -->
      <div class="px-5 py-3 border-t border-ink-100 bg-brand-soft/40 grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-[12px]">
        <div>
          <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium">Post-money</div>
          <div class="num font-semibold text-ink-900">{{ postMoney != null ? fmtUSD(postMoney) : '—' }}</div>
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium">New shares</div>
          <div class="num font-semibold text-ink-900">{{ newShares != null ? fmtShares(newShares) : '—' }}</div>
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium">Total FDS <span class="text-ink-400 font-normal normal-case tracking-normal">post</span></div>
          <div class="num font-semibold text-ink-900">{{ totalSharesFdsPost != null ? fmtShares(totalSharesFdsPost) : '—' }}</div>
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium flex items-center gap-1"><Calculator :size="10" /> Pool available <span class="text-ink-400 font-normal normal-case tracking-normal">post</span></div>
          <div class="num font-semibold" :class="(poolAvailablePost ?? 0) < 0 ? 'text-red-700' : 'text-ok'">{{ poolAvailablePost != null ? fmtShares(poolAvailablePost) : '—' }}</div>
        </div>
      </div>

      <div v-if="ownership != null" class="px-5 py-2 border-t border-ink-100 text-[11px] text-ink-500 num">
        New investors will own ≈ <span class="font-medium text-ink-900">{{ (ownership * 100).toFixed(2) }}%</span> of fully-diluted post-close.
      </div>
    </template>
  </section>
</template>
