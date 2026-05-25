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
import { Link2, Trash2 } from 'lucide-vue-next'
import { fmtDate } from '~/utils/format'

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
  (e: 'set-kind', v: 'open' | 'closed' | 'formation'): void
  (e: 'commit'): void
  (e: 'delete'): void
}>()

const displayName = computed(() => (props.name ?? '').trim() || props.code)
const isOpen = computed(() => props.status === 'open')
const isChild = computed(() => !!props.parentCode)
const parentRound = computed(() => props.otherRounds.find(r => r.code === props.parentCode))
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
        <span
          v-else-if="status === 'formation'"
          class="text-[9px] uppercase tracking-wider text-ink-700 font-semibold bg-ink-100 px-1.5 py-0.5 rounded"
          title="Foundation snapshot — sets the starting cap structure. All values are user-typed; transaction columns hide."
        >Formation</span>
      </div>

      <!-- Date row. Editable inline; the parser accepts "9/9/24", "Sep 9
           2024", "today" etc. — the bound model is always ISO. -->
      <div class="mt-1 relative">
        <DateInput
          variant="bare"
          :model-value="closeDate"
          placeholder="MM/DD/YYYY"
          @update:model-value="(v) => emit('update-date', v)"
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

      <!-- Kind toggle + delete. Formation is its own kind because it's a
           snapshot, not a transaction — the derived money/preferred/notes
           columns don't apply to it. Closed and Open both behave as
           transaction rounds; only one round can be Open at a time. -->
      <div class="mt-1.5 flex items-center gap-1 flex-wrap">
        <button
          type="button"
          class="text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border transition-colors"
          :class="status === 'formation'
            ? 'bg-ink-700 text-white border-ink-700'
            : 'bg-white text-ink-500 border-ink-200 hover:border-ink-300'"
          title="Formation = the founding snapshot. All values are user-typed; transaction columns (post-money, notes, preferred) hide because they don't apply."
          @click="emit('set-kind', 'formation')"
        >Formation</button>
        <button
          type="button"
          class="text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border transition-colors"
          :class="status === 'closed'
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
