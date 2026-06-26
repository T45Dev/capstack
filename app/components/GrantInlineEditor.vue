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
import { Award, X, Ban, Coins } from 'lucide-vue-next'
import { fmtShares, fmtPct } from '~/utils/format'
import { vestedFraction, grantIssued, grantOutstanding } from '~/utils/capTable'

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
  // Lifecycle detail — drives the terminate/exercise actions below.
  quantity_issued?: number | null
  quantity_exercised?: number | null
  quantity_forfeited?: number | null
  quantity_expired?: number | null
  termination_date?: string | null
  exercise_window_days?: number | null
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
  (e: 'terminate', payload: { termination_date: string; exercise_window_days: number }): void
  (e: 'exercise', payload: { shares: number; exercise_date: string }): void
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

// ── Grant lifecycle · terminate / exercise (existing outstanding grants only) ──
const isLiveGrant = computed(() => !!props.grant?.id && props.grant?.status === 'outstanding')
const lcTerminated = computed(() => !!props.grant?.termination_date)
const lcIssued = computed(() => grantIssued((props.grant || {}) as any))
const lcOutstanding = computed(() => grantOutstanding((props.grant || {}) as any))
const lcExercised = computed(() => props.grant?.quantity_exercised || 0)

type LifeMode = 'none' | 'terminate' | 'exercise'
const lifeMode = ref<LifeMode>('none')
const termDate = ref(today)
const windowDays = ref(90)
const exDate = ref(today)
const exShares = ref(0)

function dms(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '')
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Date.now()
}
function addDays(s: string, n: number): string {
  return new Date(dms(s) + n * 86400000).toISOString().slice(0, 10)
}
// Vested-still-held as of a date = vested-of-issued − already-exercised, capped at outstanding.
function vestedHeldAt(asOf: string): number {
  const frac = vestedFraction((props.grant || {}) as any, dms(asOf))
  return Math.max(0, Math.min(lcOutstanding.value, Math.floor(lcIssued.value * frac) - lcExercised.value))
}
const termVestedHeld = computed(() => vestedHeldAt(termDate.value))
const termUnvested = computed(() => Math.max(0, lcOutstanding.value - termVestedHeld.value))
const expiresOn = computed(() => addDays(termDate.value, Math.max(0, Math.floor(windowDays.value || 0))))
// Exercise can be partial — these drive the "leaves N outstanding" preview.
const exNow = computed(() => Math.max(0, Math.min(lcOutstanding.value, Math.floor(exShares.value || 0))))
const exRemaining = computed(() => Math.max(0, lcOutstanding.value - exNow.value))

function openLife(mode: LifeMode) {
  lifeMode.value = lifeMode.value === mode ? 'none' : mode
  if (mode === 'exercise') exShares.value = vestedHeldAt(today) || lcOutstanding.value
  if (mode === 'terminate') { termDate.value = today; windowDays.value = 90 }
}
function confirmTerminate() {
  emit('terminate', { termination_date: termDate.value, exercise_window_days: Math.max(0, Math.floor(windowDays.value || 0)) })
}
function confirmExercise() {
  if (exNow.value < 1) return
  emit('exercise', { shares: exNow.value, exercise_date: exDate.value })
}

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
            <option value="proposed">Committed (draft)</option>
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

    <!-- ── Grant lifecycle · terminate / exercise (existing outstanding grants) ── -->
    <div v-if="isLiveGrant" class="border-t border-brand-200/70 pt-3">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div class="text-[10px] font-semibold uppercase tracking-wider text-ink-400">Grant lifecycle</div>
        <span v-if="lcTerminated" class="text-[11px] font-medium text-red-700 bg-red-50 border border-red-200 rounded px-1.5 py-0.5">Terminated {{ props.grant?.termination_date }}</span>
        <span class="text-[11px] text-ink-500">{{ fmtShares(lcOutstanding) }} outstanding{{ lcExercised ? ` · ${fmtShares(lcExercised)} exercised` : '' }}</span>
        <div class="ml-auto flex gap-2">
          <UiButton variant="ghost" :disabled="lcOutstanding < 1" @click="openLife('exercise')"><Coins :size="14" /> Record exercise</UiButton>
          <UiButton v-if="!lcTerminated" variant="ghost" @click="openLife('terminate')"><Ban :size="14" /> Terminate</UiButton>
        </div>
      </div>

      <!-- Exercise (portion or all) — partial is fine; the rest stays outstanding -->
      <div v-if="lifeMode === 'exercise'" class="mt-3 rounded-md border border-ink-200 bg-white p-3">
        <div class="flex flex-wrap items-end gap-x-4 gap-y-3">
          <UiInput v-model="exShares" type="number" label="Shares to exercise" step="100" class="w-40" />
          <UiInput v-model="exDate" type="date" label="Exercise date" class="w-40" />
          <UiButton variant="primary" class="ml-auto" :disabled="saving || exNow < 1" @click="confirmExercise"><Coins :size="14" /> {{ saving ? 'Working…' : 'Exercise' }}</UiButton>
        </div>
        <p class="mt-2 text-[11px] text-ink-600 leading-snug">
          {{ fmtShares(lcOutstanding) }} held · {{ fmtShares(vestedHeldAt(today)) }} vested today{{ lcExercised ? ` · ${fmtShares(lcExercised)} already exercised` : '' }}.
          Exercising <b>{{ fmtShares(exNow) }}</b> converts to common and leaves <b>{{ fmtShares(exRemaining) }}</b> outstanding — you can exercise the rest later.
        </p>
      </div>

      <!-- Terminate (forfeit unvested, vested exercisable for a window, then expire) -->
      <div v-if="lifeMode === 'terminate'" class="mt-3 rounded-md border border-red-200 bg-red-50/50 p-3">
        <div class="flex flex-wrap items-end gap-x-4 gap-y-3">
          <UiInput v-model="termDate" type="date" label="Termination date" class="w-40" />
          <UiInput v-model="windowDays" type="number" label="Exercise window (days)" step="1" class="w-40" />
          <UiButton variant="primary" class="ml-auto" :disabled="saving" @click="confirmTerminate"><Ban :size="14" /> {{ saving ? 'Working…' : 'Terminate grant' }}</UiButton>
        </div>
        <p class="mt-2 text-[11px] text-ink-600 leading-snug">
          <b>{{ fmtShares(termUnvested) }}</b> unvested forfeit on termination; <b>{{ fmtShares(termVestedHeld) }}</b> vested stay exercisable until <b>{{ expiresOn }}</b>, then expire. Forfeited &amp; expired shares return to the pool.
        </p>
      </div>
    </div>

    <div class="flex justify-end gap-2">
      <UiButton variant="ghost" @click="emit('cancel')"><X :size="14" /> Cancel</UiButton>
      <UiButton variant="primary" :disabled="!canSave" @click="onSave">
        <Award :size="14" /> {{ saving ? 'Saving…' : 'Save grant' }}
      </UiButton>
    </div>
  </div>
</template>
