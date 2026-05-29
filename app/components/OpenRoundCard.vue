<script setup lang="ts">
// Open-Round card: the currently-modeled round. Lives in the existing
// rounds table with kind='open' so the rest of the cap-table logic
// (per-investor allocations, scenarios) keeps working unchanged.
//
// Edits to the typed fields buffer locally; the operator clicks Save
// (or hits ⌘S) to commit all changes in a single PATCH. Status toggle,
// delete, and "Start an open round" still commit immediately — they're
// discrete actions, not field edits.
import { Sparkles, Plus, Trash2, Save, Undo2, Check } from 'lucide-vue-next'
import { fmtShares, fmtUSD } from '~/utils/format'

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
  kind: 'formation' | 'closed' | 'open'
  close_date: string | null
  share_price: number | null
  new_money: number | null
  pre_money: number | null
  option_pool_issued: number | null
  notes_converted: number | null           // effective: override if set, else Σ CN-attributed shares
  notes_converted_override: number | null  // null = derive from CN attributions
}

interface Aggregate {
  total_shares_fds: number | null
}

const { data: roundSummary, refresh: refreshRound } = await useFetch<{ rounds: any[] }>(() => `/api/companies/${props.companyId}/round-summary`, { watch: [() => props.companyId] })
const { data: agg } = await useFetch<Aggregate>(() => `/api/companies/${props.companyId}/aggregate-round`, { watch: [() => props.companyId] })

const round = computed<OpenRound | null>(() => {
  const rounds = roundSummary.value?.rounds || []
  // Prefer the open round, but fall back to the latest non-formation
  // round so the pre/post model stays visible after the round is
  // flipped to "closed" — closing it shouldn't hide the modeling.
  const open = rounds.find((x: any) => x.kind === 'open')
  const latest = [...rounds].reverse().find((x: any) => x.kind !== 'formation')
  const r = open || latest
  return r ? {
    id: r.round_id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    close_date: r.close_date,
    share_price: r.share_price,
    new_money: r.new_money,
    pre_money: r.pre_money,
    option_pool_issued: r.option_pool_issued,
    notes_converted: r.notes_converted,
    notes_converted_override: r.notes_converted_override,
  } : null
})

const isOpen = computed(() => round.value?.kind === 'open')

// Local editable copy. Resynced from the server only when the operator
// isn't dirty — otherwise a refresh fired by an unrelated action could
// blow away in-progress edits.
const name              = ref<string>('')
const closeDate         = ref<string | null>(null)
const preMoney          = ref<number | null>(null)
const newMoney          = ref<number | null>(null)
const sharePrice        = ref<number | null>(null)
const optionPoolIssued  = ref<number | null>(null)
// Notes converted = CN-converted shares that roll into total FDS. Null
// means "derive from CN attributions"; a typed value pins
// notes_converted_override and wins over the engine's per-note math.
const notesConverted    = ref<number | null>(null)

function syncFromServer(r: OpenRound | null) {
  if (!r) return
  name.value             = r.name || ''
  closeDate.value        = r.close_date
  preMoney.value         = r.pre_money
  newMoney.value         = r.new_money
  sharePrice.value       = r.share_price
  optionPoolIssued.value = r.option_pool_issued
  notesConverted.value   = r.notes_converted_override
}

function eqN(a: number | null | undefined, b: number | null | undefined) {
  if (a == null && b == null) return true
  return a === b
}
function eqS(a: string | null | undefined, b: string | null | undefined) {
  const aa = a == null || a === '' ? null : a
  const bb = b == null || b === '' ? null : b
  return aa === bb
}

const dirty = computed(() => {
  const r = round.value
  if (!r) return false
  return !eqS(name.value,            r.name)
      || !eqS(closeDate.value,       r.close_date)
      || !eqN(preMoney.value,        r.pre_money)
      || !eqN(newMoney.value,        r.new_money)
      || !eqN(sharePrice.value,      r.share_price)
      || !eqN(optionPoolIssued.value, r.option_pool_issued)
      || !eqN(notesConverted.value,  r.notes_converted_override)
})

// First server payload always syncs (local refs start uninitialized, so
// the dirty check would otherwise fire on an empty/server mismatch and
// we'd never seed the fields). After that, refreshes skip when the
// operator has unsaved edits — that's the whole point of the Save button.
let hasSyncedOnce = false
watch(round, (r) => {
  if (!r) return
  if (hasSyncedOnce && dirty.value) return
  syncFromServer(r)
  hasSyncedOnce = true
}, { immediate: true })

const saving = ref(false)
const justSaved = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | null = null

function bumpSaving(delta: number) {
  emit('update:saving-count', delta > 0 ? 1 : 0)
}

async function save() {
  if (!round.value || !dirty.value || saving.value) return
  saving.value = true
  bumpSaving(+1)
  try {
    await $fetch(`/api/rounds/${round.value.id}`, {
      method: 'PATCH',
      body: {
        name: name.value,
        close_date: closeDate.value,
        pre_money: preMoney.value,
        new_money: newMoney.value,
        share_price: sharePrice.value,
        option_pool_issued: optionPoolIssued.value,
        notes_converted_override: notesConverted.value,
      },
    })
    await refreshRound()
    emit('refreshed')
    justSaved.value = true
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => { justSaved.value = false }, 2000)
  } catch (e) {
    console.error('Save failed', e)
  } finally {
    saving.value = false
    bumpSaving(-1)
  }
}

function discard() {
  syncFromServer(round.value)
}

// Discrete actions: status toggle, delete, create. Commit immediately
// (no draft buffer) since they don't share a save button with the
// typed fields.
async function commitField(field: string, value: any) {
  if (!round.value) return
  bumpSaving(+1)
  try {
    await $fetch(`/api/rounds/${round.value.id}`, { method: 'PATCH', body: { [field]: value } })
    await refreshRound()
    emit('refreshed')
  } catch (e) { console.error(`Couldn't save ${field}`, e) }
  finally { bumpSaving(-1) }
}

async function createOpenRound() {
  bumpSaving(+1)
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
  finally { bumpSaving(-1) }
}

async function setKind(kind: 'open' | 'closed') {
  if (!round.value || round.value.kind === kind) return
  await commitField('kind', kind)
}

async function deleteOpenRound() {
  if (!round.value) return
  if (!confirm('Delete this round? This wipes its allocations too.')) return
  bumpSaving(+1)
  try {
    await $fetch(`/api/rounds/${round.value.id}`, { method: 'DELETE' })
    await refreshRound()
    emit('refreshed')
  } catch (e) { console.error('Failed to delete open round', e) }
  finally { bumpSaving(-1) }
}

// ⌘S / Ctrl+S = save while focus is inside the card.
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

// Derived projections — read off the local refs so the model reacts
// as the operator types (and resets cleanly when they Discard).
const postMoney = computed(() => {
  if (preMoney.value == null && newMoney.value == null) return null
  return (preMoney.value || 0) + (newMoney.value || 0)
})
const newShares = computed(() => {
  if (!newMoney.value || !sharePrice.value) return null
  return Math.floor(newMoney.value / sharePrice.value)
})
// Effective notes-converted for the live preview: the operator's typed
// override wins; otherwise fall back to the server's CN-derived count.
const effNotesConverted = computed(() => {
  if (notesConverted.value != null) return notesConverted.value
  return round.value?.notes_converted ?? 0
})
const totalSharesFdsPost = computed(() => {
  const base = agg.value?.total_shares_fds ?? 0
  const issued = newShares.value ?? 0
  const pool = optionPoolIssued.value ?? 0
  const notes = effNotesConverted.value ?? 0
  if (!base && !issued && !pool && !notes) return null
  return base + issued + pool + notes
})
const ownership = computed(() => {
  if (!newShares.value || !totalSharesFdsPost.value) return null
  return newShares.value / totalSharesFdsPost.value
})
</script>

<template>
  <section
    ref="cardEl"
    class="rounded-xl border bg-white shadow-[0_1px_0_rgba(16,24,40,0.04)]"
    :class="dirty ? 'border-amber-300' : (isOpen ? 'border-brand-300' : 'border-ink-200')"
  >
    <header class="px-5 py-3 border-b border-ink-100 flex items-center justify-between gap-3 flex-wrap">
      <div class="flex items-center gap-2">
        <div class="grid place-items-center w-7 h-7 rounded-md" :class="isOpen ? 'bg-brand-soft text-brand-edge' : 'bg-ink-100 text-ink-600'">
          <Sparkles :size="14" />
        </div>
        <div>
          <h2 class="text-[14px] font-semibold text-ink-900">Open Round</h2>
          <p class="text-[11px] text-ink-500 leading-tight">{{ isOpen ? 'Currently raising — iterates as you tweak the terms' : 'Closed — pre/post model kept for reference' }}</p>
        </div>
      </div>
      <div v-if="round" class="flex items-center gap-2 flex-wrap">
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

        <div class="w-px h-5 bg-ink-200 mx-1" />

        <!-- Status toggle. Closing the round keeps the model below
             visible; it just clears the "open round" pill in the header.
             Commits immediately — it's a status flip, not a field edit. -->
        <div class="inline-flex rounded-md border border-ink-200 overflow-hidden text-[11px]">
          <button type="button" class="px-2.5 py-1" :class="isOpen ? 'bg-brand text-white' : 'bg-white text-ink-600 hover:bg-ink-50'" @click="setKind('open')">Open</button>
          <button type="button" class="px-2.5 py-1 border-l border-ink-200" :class="!isOpen ? 'bg-ink-700 text-white' : 'bg-white text-ink-600 hover:bg-ink-50'" @click="setKind('closed')">Closed</button>
        </div>
        <button class="text-[11px] text-ink-500 hover:text-red-600 inline-flex items-center gap-1" @click="deleteOpenRound">
          <Trash2 :size="11" /> delete
        </button>
      </div>
    </header>

    <div v-if="!round" class="px-5 py-10 text-center">
      <p class="text-[13px] text-ink-600">No round to model yet.</p>
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
            class="w-full text-left px-2 py-1.5 text-sm border border-ink-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30"
            placeholder="Series B"
          />
        </div>
        <div>
          <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Close date <span class="text-ink-400 font-normal">{{ isOpen ? '(target)' : '' }}</span></label>
          <DateInput v-model="closeDate" class="w-full" />
        </div>
      </div>

      <!-- Row 2: typed money/share fields -->
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
          <label class="block text-[11.5px] font-medium text-ink-700 mb-1">Option pool top-up</label>
          <NumberInput v-model="optionPoolIssued" placeholder="0" class="w-full" />
        </div>
        <div>
          <label class="block text-[11.5px] font-medium text-ink-700 mb-1">
            Notes converted <span class="text-ink-400 font-normal">(CN shares → FDS)</span>
          </label>
          <NumberInput
            v-model="notesConverted"
            :placeholder="(round?.notes_converted ?? 0) > 0 ? fmtShares(round?.notes_converted ?? 0) : '0'"
            class="w-full"
          />
          <p class="mt-1 text-[10px] text-ink-400 leading-tight">
            <template v-if="notesConverted != null">
              Manual override ·
              <button type="button" class="text-brand-edge hover:underline" @click="notesConverted = null">revert to auto</button>
            </template>
            <template v-else>Auto-derived from note attributions</template>
          </p>
        </div>
      </div>

      <!-- Derived footer: live cap-table impact of the round's terms.
           Shown whether the round is open or closed. -->
      <div class="px-5 py-3 border-t border-ink-100 grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-2 text-[12px]" :class="isOpen ? 'bg-brand-soft/40' : 'bg-ink-50/50'">
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
      </div>

      <div v-if="ownership != null" class="px-5 py-2 border-t border-ink-100 text-[11px] text-ink-500 num">
        New investors will own ≈ <span class="font-medium text-ink-900">{{ (ownership * 100).toFixed(2) }}%</span> of fully-diluted post-close.
      </div>
    </template>
  </section>
</template>
