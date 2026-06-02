<script setup lang="ts">
// Inline grant editor — replaces the old edit/propose modal. Rendered inside
// a full-width table row (a <td colspan> spanning the whole table) so the
// pencil "opens the row up to edits" in place. Used for both editing an
// existing grant and adding a new proposed one.
//
// Owns its own draft seeded from the `grant` prop; emits `save` with the
// flushed values and `cancel`. The parent handles the PATCH / POST + refresh.
import { Award, X } from 'lucide-vue-next'
import { fmtShares, fmtPct } from '~/utils/format'

interface GrantDraft {
  recipient_name: string
  recipient_type: string
  round: string
  quantity: number
  strike: number | null
  issue_date: string
  vesting_start: string
  vest_months: number
  cliff_months: number
  status: 'outstanding' | 'proposed'
  notes: string
}

// Loose shape of the grant passed in for editing — the cap-table Grant has
// nullable fields, so accept null for everything; seed() normalizes to the
// strict GrantDraft below.
interface GrantInput {
  id?: string
  recipient_name?: string | null
  recipient_type?: string | null
  round?: string | null
  quantity?: number | null
  strike?: number | null
  issue_date?: string | null
  vesting_start?: string | null
  vest_months?: number | null
  cliff_months?: number | null
  status?: string | null
  notes?: string | null
}

const props = withDefaults(defineProps<{
  // The grant being edited, or null when adding a new one.
  grant?: GrantInput | null
  postFds?: number
  postPps?: number
  saving?: boolean
}>(), { grant: null, postFds: 0, postPps: 0, saving: false })

const emit = defineEmits<{
  (e: 'save', form: GrantDraft): void
  (e: 'cancel'): void
}>()

const today = new Date().toISOString().slice(0, 10)

function seed(): GrantDraft {
  const g = props.grant || {}
  return {
    recipient_name: g.recipient_name ?? '',
    recipient_type: g.recipient_type ?? 'Employee',
    round: g.round ?? 'Post-A4 / Pre-B',
    quantity: g.quantity ?? 0,
    strike: g.strike ?? null,
    issue_date: g.issue_date ?? today,
    vesting_start: g.vesting_start ?? today,
    vest_months: g.vest_months ?? 48,
    cliff_months: g.cliff_months ?? 12,
    status: (g.status === 'outstanding' ? 'outstanding' : 'proposed'),
    notes: g.notes ?? '',
  }
}

const form = reactive<GrantDraft>(seed())
// Reseed when the editor is pointed at a different grant (e.g. the operator
// clicks a different row's pencil without closing the first).
watch(() => props.grant && (props.grant as any).id, () => Object.assign(form, seed()))

// Grant-size input mode — shares / % of post-round FDS / $ at round PPS.
// The grant is always stored as a share count; `typedValue` mirrors the
// field in whatever unit the operator picked.
const inputMode = ref<'shares' | 'pct' | 'value'>('shares')
const typedValue = ref(form.quantity)

function sharesToMode(shares: number, mode: 'shares' | 'pct' | 'value'): number {
  if (mode === 'shares') return shares
  if (mode === 'pct') return props.postFds > 0 ? (shares / props.postFds) * 100 : 0
  return shares * props.postPps
}
function modeToShares(v: number, mode: 'shares' | 'pct' | 'value'): number {
  if (mode === 'shares') return Math.round(v)
  if (mode === 'pct') return Math.round((v / 100) * props.postFds)
  return props.postPps > 0 ? Math.round(v / props.postPps) : 0
}
watch(inputMode, (next, prev) => {
  if (next === prev) return
  const shares = modeToShares(typedValue.value, prev)
  form.quantity = shares
  typedValue.value = sharesToMode(shares, next)
})
watch(typedValue, (v) => { form.quantity = modeToShares(v, inputMode.value) })

const canSave = computed(() => form.recipient_name.trim().length > 0 && form.quantity > 0 && !props.saving)
function onSave() {
  if (!canSave.value) return
  emit('save', { ...form })
}
</script>

<template>
  <div class="bg-brand-50/40 border-y border-brand-200 px-4 py-4">
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <UiInput v-model="form.recipient_name" label="Recipient" placeholder="Marwan Berrada" class="col-span-2" />
      <label class="block">
        <span class="block text-xs font-medium text-ink-700 mb-1">Type</span>
        <select v-model="form.recipient_type" class="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500">
          <option>Employee</option>
          <option>Board Member</option>
          <option>Consultant</option>
          <option>SAB</option>
          <option>Advisor</option>
        </select>
      </label>
      <UiInput v-model="form.round" label="Round / batch" placeholder="Post-A4 / Pre-B" />

      <div class="col-span-2">
        <div class="flex items-end gap-2">
          <UiInput
            v-model="typedValue"
            type="number"
            :label="`Grant size (${inputMode === 'shares' ? 'shares' : inputMode === 'pct' ? '% of post-FDS' : '$ at PPS'})`"
            :prefix="inputMode === 'value' ? '$' : ''"
            :suffix="inputMode === 'pct' ? '%' : ''"
            :step="inputMode === 'shares' ? '100' : inputMode === 'pct' ? '0.01' : '1000'"
            class="flex-1 min-w-0"
          />
          <div class="inline-flex rounded-md border border-ink-300 overflow-hidden text-xs">
            <button
              v-for="m in (['shares','pct','value'] as const)"
              :key="m"
              type="button"
              class="px-2.5 py-2 transition-colors"
              :class="inputMode === m ? 'bg-brand-500 text-white' : 'bg-white text-ink-700 hover:bg-ink-100'"
              @click="inputMode = m"
            >{{ m === 'shares' ? 'Shares' : m === 'pct' ? '%' : '$' }}</button>
          </div>
        </div>
        <p class="mt-1 text-[11px] text-ink-500">
          Stored as <span class="num text-ink-700">{{ fmtShares(form.quantity) }}</span> shares.
          <span v-if="inputMode !== 'shares' && postFds > 0">· = <span class="num text-ink-700">{{ fmtPct(form.quantity / postFds, 2) }}</span> of post-FDS</span>
          <span v-if="inputMode !== 'value' && postPps > 0">· ≈ <span class="num text-ink-700">${{ Math.round(form.quantity * postPps).toLocaleString() }}</span> at PPS</span>
        </p>
      </div>
      <UiInput v-model="form.strike" type="number" label="Strike (PPS)" prefix="$" step="0.00001" :digits="5" />

      <UiInput v-model="form.issue_date" type="date" label="Issue date" />
      <UiInput v-model="form.vesting_start" type="date" label="Vesting date" />
      <div class="grid grid-cols-2 gap-3">
        <UiInput v-model="form.vest_months" type="number" label="Vest mo." />
        <UiInput v-model="form.cliff_months" type="number" label="Cliff mo." />
      </div>

      <label class="block">
        <span class="block text-xs font-medium text-ink-700 mb-1">Status</span>
        <select v-model="form.status" class="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500">
          <option value="proposed">Proposed (draft)</option>
          <option value="outstanding">Outstanding (live)</option>
        </select>
      </label>
      <label class="block col-span-2 md:col-span-3">
        <span class="block text-xs font-medium text-ink-700 mb-1">Notes</span>
        <input v-model="form.notes" type="text" class="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500" placeholder="Optional memo" />
      </label>
    </div>

    <div class="mt-3 flex justify-end gap-2">
      <UiButton variant="ghost" @click="emit('cancel')"><X :size="14" /> Cancel</UiButton>
      <UiButton variant="primary" :disabled="!canSave" @click="onSave">
        <Award :size="14" /> {{ saving ? 'Saving…' : 'Save grant' }}
      </UiButton>
    </div>
  </div>
</template>
