<script setup lang="ts">
// Inline grant editor — replaces the old edit/propose modal. Rendered inside
// a full-width table row (a <td colspan> spanning the whole table) so the
// pencil "opens the row up to edits" in place. Used for both editing an
// existing grant and adding a new proposed one.
//
// Owns its own draft seeded from the `grant` prop; emits `save` with the
// flushed values and `cancel`. The parent handles the PATCH / POST + refresh.
//
// Layout: a compact 12-column grid grouped by intent — Recipient · Grant ·
// Vesting · Notes. Fields are sized to their content (a 2-digit cliff month
// doesn't get a full-width box). The grant-size field carries a live readout
// of its shares / % / $ equivalents as clickable chips: click one to size the
// grant in that unit (it adopts the computed number into the input).
import { Award, X } from 'lucide-vue-next'
import { fmtShares, fmtPct } from '~/utils/format'

interface VestingScheduleOpt {
  id: string
  name: string
  vest_months: number
  cliff_months: number
  cadence?: string
}

interface GrantDraft {
  recipient_name: string
  recipient_type: string
  award_type: string            // '' | 'ISO' | 'NSO' | 'RSU'
  round: string
  quantity: number
  strike: number | null
  issue_date: string
  vesting_start: string
  vesting_schedule_id: string | null
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
  award_type?: string | null
  round?: string | null
  quantity?: number | null
  strike?: number | null
  issue_date?: string | null
  vesting_start?: string | null
  vesting_schedule_id?: string | null
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
  schedules?: VestingScheduleOpt[]
}>(), { grant: null, postFds: 0, postPps: 0, saving: false, schedules: () => [] })

const emit = defineEmits<{
  (e: 'save', form: Record<string, any>): void
  (e: 'cancel'): void
}>()

const today = new Date().toISOString().slice(0, 10)

// The three board-export buckets. Role drives the category each grant is
// summed into on the board-approval workbook (see catOf in board-approval).
const ROLES = ['Employees', 'BOD/Advisors', 'Ex-Employees']

// Shared chrome for the native <select> controls so they match UiInput.
const SELECT_CLASS = 'w-full rounded-md border border-ink-300 bg-white px-2.5 py-2 text-sm text-ink-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500'

function seed(): GrantDraft {
  const g = props.grant || {}
  return {
    recipient_name: g.recipient_name ?? '',
    recipient_type: g.recipient_type ?? 'Employees',
    award_type: g.award_type ?? '',
    round: g.round ?? '',
    quantity: g.quantity ?? 0,
    strike: g.strike ?? null,
    issue_date: g.issue_date ?? today,
    vesting_start: g.vesting_start ?? today,
    vesting_schedule_id: g.vesting_schedule_id ?? null,
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
type SizeMode = 'shares' | 'pct' | 'value'
const inputMode = ref<SizeMode>('shares')
const typedValue = ref(form.quantity)

function sharesToMode(shares: number, mode: SizeMode): number {
  if (mode === 'shares') return shares
  if (mode === 'pct') return props.postFds > 0 ? (shares / props.postFds) * 100 : 0
  return shares * props.postPps
}
function modeToShares(v: number, mode: SizeMode): number {
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

const sizeUnitLabel = computed(() =>
  inputMode.value === 'shares' ? 'shares' : inputMode.value === 'pct' ? '% of post-FDS' : '$ at PPS')

// Live readout of the grant's size in all three units, as chips under the
// input. The active chip is the unit currently being typed; clicking another
// switches the input to that unit — which (via the inputMode watcher) recomputes
// the field to exactly the displayed number. So "click the calc number → it
// lands in the input."
const calcChips = computed<Array<{ mode: SizeMode; label: string }>>(() => {
  const q = form.quantity || 0
  const chips: Array<{ mode: SizeMode; label: string }> = [
    { mode: 'shares', label: `${fmtShares(q)} sh` },
  ]
  if (props.postFds > 0) chips.push({ mode: 'pct', label: `${fmtPct(q / props.postFds, 2)} post-FDS` })
  if (props.postPps > 0) chips.push({ mode: 'value', label: `$${Math.round(q * props.postPps).toLocaleString()} @ PPS` })
  return chips
})
function applyChip(mode: SizeMode) {
  if (inputMode.value !== mode) inputMode.value = mode
}

// Vesting schedule picker. Choosing a named schedule snapshots its month
// values onto the grant; editing the months directly reverts to "Custom".
function onSchedule(e: Event) {
  const sid = (e.target as HTMLSelectElement).value || null
  form.vesting_schedule_id = sid
  if (sid) {
    const s = props.schedules.find(x => x.id === sid)
    if (s) { form.vest_months = s.vest_months; form.cliff_months = s.cliff_months }
  }
}
watch(() => [form.vest_months, form.cliff_months], () => {
  if (!form.vesting_schedule_id) return
  const s = props.schedules.find(x => x.id === form.vesting_schedule_id)
  if (s && (s.vest_months !== form.vest_months || s.cliff_months !== form.cliff_months)) {
    form.vesting_schedule_id = null
  }
})

const canSave = computed(() => form.recipient_name.trim().length > 0 && form.quantity > 0 && !props.saving)
function onSave() {
  if (!canSave.value) return
  // Normalize empties to null so blank Type / schedule clear cleanly.
  emit('save', {
    ...form,
    award_type: form.award_type || null,
    vesting_schedule_id: form.vesting_schedule_id || null,
  })
}
</script>

<template>
  <div class="bg-brand-50/40 border-y border-brand-200 px-4 py-4 space-y-4">
    <!-- ── Recipient · who's getting the grant and how it's classified ──
         Fields are sized to their content (fixed widths that wrap) rather than
         stretched across the full table width. -->
    <div>
      <div class="text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1.5">Recipient</div>
      <div class="flex flex-wrap items-start gap-x-4 gap-y-3">
        <UiInput v-model="form.recipient_name" label="Name" placeholder="Marwan Berrada" class="w-full sm:w-72" />
        <label class="block w-full sm:w-44">
          <span class="block text-xs font-medium text-ink-700 mb-1">Role</span>
          <select v-model="form.recipient_type" :class="SELECT_CLASS">
            <option v-if="form.recipient_type && !ROLES.includes(form.recipient_type)" :value="form.recipient_type">{{ form.recipient_type }} (legacy)</option>
            <option v-for="rr in ROLES" :key="rr" :value="rr">{{ rr }}</option>
          </select>
        </label>
        <label class="block w-full sm:w-28">
          <span class="block text-xs font-medium text-ink-700 mb-1">Type</span>
          <select v-model="form.award_type" :class="SELECT_CLASS">
            <option value="">—</option>
            <option value="ISO">ISO</option>
            <option value="NSO">NSO</option>
            <option value="RSU">RSU</option>
          </select>
        </label>
        <label class="block w-full sm:w-44">
          <span class="block text-xs font-medium text-ink-700 mb-1">Status</span>
          <select v-model="form.status" :class="SELECT_CLASS">
            <option value="proposed">Proposed (draft)</option>
            <option value="outstanding">Outstanding (live)</option>
          </select>
        </label>
      </div>
    </div>

    <!-- ── Grant · size, price, batch ── -->
    <div>
      <div class="text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1.5">Grant</div>
      <div class="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div class="w-full sm:w-80">
          <span class="block text-xs font-medium text-ink-700 mb-1">Grant size <span class="text-ink-400 font-normal normal-case">({{ sizeUnitLabel }})</span></span>
          <div class="flex items-stretch gap-2">
            <UiInput
              v-model="typedValue"
              type="number"
              :prefix="inputMode === 'value' ? '$' : ''"
              :suffix="inputMode === 'pct' ? '%' : ''"
              :step="inputMode === 'shares' ? '100' : inputMode === 'pct' ? '0.01' : '1000'"
              :digits="inputMode === 'pct' ? 2 : 0"
              class="w-36"
            />
            <UiSegmented
              :model-value="inputMode"
              :options="[{ value: 'shares', label: 'Shares' }, { value: 'pct', label: '%' }, { value: 'value', label: '$' }]"
              @update:model-value="(v) => inputMode = v as SizeMode"
            />
          </div>
          <!-- Live equivalents — click a chip to size the grant in that unit. -->
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span class="text-ink-400">=</span>
            <button
              v-for="c in calcChips"
              :key="c.mode"
              type="button"
              class="num rounded px-1.5 py-0.5 border transition-colors"
              :class="c.mode === inputMode
                ? 'border-brand-400 bg-brand-100 text-brand-800 font-medium'
                : 'border-ink-200 bg-white text-ink-600 hover:border-brand-300 hover:text-brand-700 hover:bg-white'"
              :title="c.mode === inputMode ? 'Current input unit' : 'Size the grant in this unit'"
              @click="applyChip(c.mode)"
            >{{ c.label }}</button>
          </div>
        </div>
        <UiInput v-model="form.strike" type="number" label="Strike (PPS)" prefix="$" step="0.00001" :digits="5" class="w-full sm:w-32" />
        <UiInput v-model="form.round" label="Batch" placeholder="Q3 2025 hires" class="w-full sm:w-48" />
      </div>
    </div>

    <!-- ── Vesting · dates and schedule ── -->
    <div>
      <div class="text-[10px] font-semibold uppercase tracking-wider text-ink-400 mb-1.5">Vesting</div>
      <div class="flex flex-wrap items-start gap-x-4 gap-y-3">
        <UiInput v-model="form.issue_date" type="date" label="Issue date" class="w-full sm:w-40" />
        <UiInput v-model="form.vesting_start" type="date" label="Vesting date" class="w-full sm:w-40" />
        <label class="block w-full sm:w-52">
          <span class="block text-xs font-medium text-ink-700 mb-1">Schedule</span>
          <select :value="form.vesting_schedule_id || ''" :class="SELECT_CLASS" @change="onSchedule">
            <option value="">Custom</option>
            <option v-for="s in schedules" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <div class="w-full sm:w-auto">
          <span class="block text-xs font-medium text-ink-700 mb-1">Vest / cliff <span class="text-ink-400 font-normal">(mo.)</span></span>
          <div class="flex gap-2">
            <UiInput v-model="form.vest_months" type="number" placeholder="48" class="w-20" />
            <UiInput v-model="form.cliff_months" type="number" placeholder="12" class="w-20" />
          </div>
        </div>
      </div>
    </div>

    <!-- ── Notes ── -->
    <label class="block w-full sm:max-w-2xl">
      <span class="block text-xs font-medium text-ink-700 mb-1">Notes</span>
      <input v-model="form.notes" type="text" class="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500" placeholder="Optional memo" />
    </label>

    <div class="flex justify-end gap-2">
      <UiButton variant="ghost" @click="emit('cancel')"><X :size="14" /> Cancel</UiButton>
      <UiButton variant="primary" :disabled="!canSave" @click="onSave">
        <Award :size="14" /> {{ saving ? 'Saving…' : 'Save grant' }}
      </UiButton>
    </div>
  </div>
</template>
