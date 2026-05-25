<script setup lang="ts">
// Sticky left round-name cell.
//
// Top: status dot (pulsing brand-blue if open, neutral if closed) + the
// round name (semibold, brand-edge color when open) + an "OPEN" micro-tag
// when open.
// Middle: a calendar icon + the close date (editable native date input;
// the .cell-edit chrome only appears around the input when the row is open).
// Bottom: tranche pill — either "↳ tranche of B-1" (child) or "has tranche"
// (parent). Hidden when the round is standalone.
//
// Right-edge of the row gets the row-resize handle (lives outside this cell,
// in the parent <td>, so it spans the full row height).
import { Calendar, Link2, Trash2 } from 'lucide-vue-next'
import { fmtDate, normalizeDate } from '~/utils/format'

interface Props {
  roundId: string
  name: string | null
  code: string
  closeDate: string | null
  status: 'open' | 'closed' | 'formation'
  parentCode: string | null
  isParent: boolean
  // Other rounds for the tranche-of dropdown
  otherRounds: Array<{ id: string; code: string; label: string }>
  // Whether anything else is editable (we always allow renaming + tranche-of
  // even on closed rows so the user can clean up labels post-hoc, but date
  // and kind toggles are limited to open).
  rowEditable: boolean
}
const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update-name', v: string): void
  (e: 'update-date', v: string | null): void
  (e: 'update-parent', v: string | null): void
  (e: 'set-kind', v: 'open' | 'closed'): void
  (e: 'commit'): void
  (e: 'delete'): void
}>()

const displayName = computed(() => (props.name ?? '').trim() || props.code)
const isOpen = computed(() => props.status === 'open')
const isChild = computed(() => !!props.parentCode)
const parentRound = computed(() => props.otherRounds.find(r => r.code === props.parentCode))

function onDateChange(e: Event) {
  const v = (e.target as HTMLInputElement).value || null
  emit('update-date', v ? normalizeDate(v) : null)
}
</script>

<template>
  <div class="flex items-start gap-2 py-1">
    <!-- Status dot -->
    <div class="pt-1.5 shrink-0">
      <span v-if="isOpen" class="block w-2 h-2 rounded-full bg-brand open-dot"></span>
      <span v-else class="block w-2 h-2 rounded-full bg-ink-300"></span>
    </div>

    <div class="min-w-0 flex-1">
      <!-- Name row: editable inline. Closed rounds keep edit affordance so
           the user can rename historical rounds without flipping them open. -->
      <div class="flex items-center gap-1.5">
        <input
          type="text"
          :value="displayName"
          class="min-w-0 flex-1 bg-transparent text-[13.5px] font-semibold border border-transparent hover:border-ink-200 focus:border-brand focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand/15 rounded px-1 py-0.5"
          :class="isOpen ? 'text-brand-edge' : 'text-ink-900'"
          @input="emit('update-name', ($event.target as HTMLInputElement).value)"
          @blur="emit('commit')"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
        />
        <span v-if="isOpen" class="text-[9px] uppercase tracking-wider text-brand-edge font-semibold">Open</span>
      </div>

      <!-- Date + open/closed toggle. Date is editable; the kind toggle is
           a two-button segment that flips the round between open/closed. -->
      <div class="mt-1 flex items-center gap-1.5">
        <Calendar :size="11" class="text-ink-400 shrink-0" />
        <input
          type="date"
          :value="closeDate || ''"
          class="bg-transparent text-[11px] text-ink-500 num border border-transparent hover:border-ink-200 focus:border-brand focus:bg-white focus:outline-none rounded px-1 py-0.5"
          @change="onDateChange"
          @blur="emit('commit')"
          :title="fmtDate(closeDate)"
        />
      </div>

      <!-- Tranche row. Child rounds show '↳ tranche of {parent}'; parents
           show 'has tranche'. The dropdown lives behind an edit click so
           the row stays uncluttered. -->
      <div class="mt-1 flex items-center gap-1.5">
        <select
          :value="parentCode || ''"
          class="bg-transparent text-[10px] text-ink-500 border border-transparent hover:border-ink-200 focus:border-brand focus:bg-white focus:outline-none rounded px-1 py-0.5 max-w-[160px]"
          :title="isChild ? `Tranche of: ${parentRound?.label || parentCode}. CN cap math uses the parent's preFDS.` : 'Mark this round as a tranche of an earlier QF — affects CN cap math.'"
          @change="emit('update-parent', ($event.target as HTMLSelectElement).value || null); emit('commit')"
        >
          <option value="">— standalone</option>
          <option v-for="o in otherRounds" :key="o.id" :value="o.code">{{ o.label }}</option>
        </select>
        <span
          v-if="isChild && parentRound"
          class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded tag-tranche text-[10px] font-medium"
        >
          <Link2 :size="9" /> tranche of <strong class="ml-0.5">{{ parentRound.label }}</strong>
        </span>
        <span
          v-else-if="isParent"
          class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded tag-tranche text-[10px] font-medium"
        >
          <Link2 :size="9" /> has tranche
        </span>
      </div>

      <!-- Kind toggle + delete. Lives at the bottom so the row's visual
           focus stays on name/date/tranche above. -->
      <div class="mt-1.5 flex items-center gap-1">
        <button
          type="button"
          class="text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border transition-colors"
          :class="status === 'closed' || status === 'formation'
            ? 'bg-ink-200 text-ink-800 border-ink-300'
            : 'bg-white text-ink-500 border-ink-200 hover:border-ink-300'"
          @click="emit('set-kind', 'closed')"
        >Closed</button>
        <button
          type="button"
          class="text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border transition-colors"
          :class="isOpen
            ? 'bg-brand text-white border-brand'
            : 'bg-white text-ink-500 border-ink-200 hover:border-ink-300'"
          @click="emit('set-kind', 'open')"
        >Open</button>
        <span class="flex-1" />
        <button
          type="button"
          class="text-ink-400 hover:text-red-600 p-0.5 rounded hover:bg-red-50 transition-colors"
          title="Delete round"
          aria-label="Delete round"
          @click="emit('delete')"
        >
          <Trash2 :size="12" />
        </button>
      </div>
    </div>
  </div>
</template>
