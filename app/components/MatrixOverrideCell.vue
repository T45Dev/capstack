<script setup lang="ts">
// Preferred-shares override cell.
//
// Default behavior: render as a derived cell (dotted underline, formula
// tooltip). When the operator manually types a value, that value wins and
// the cell flips to typed-cell chrome — the .cell-edit border + amber dot
// + an "override" pill. Clearing the cell drops back to the formula.
//
// Only the open round is editable; closed rounds render as plain derived.
import { fmtShares } from '~/utils/format'

interface Props {
  derivedValue: number | null
  overrideValue: number | null
  editable: boolean
  title?: string
}
const props = withDefaults(defineProps<Props>(), { title: '' })

const emit = defineEmits<{
  (e: 'update', v: number | null): void
  (e: 'commit'): void
}>()

const isOverride = computed(() => props.overrideValue != null)
const displayValue = computed(() => isOverride.value ? props.overrideValue : props.derivedValue)
</script>

<template>
  <!-- Closed row: plain derived display, no controls. -->
  <div v-if="!editable" class="cell-read flex items-center justify-end gap-1.5" :title="title">
    <span class="num text-[13px] text-ink-700" :class="displayValue != null ? 'derived cursor-help' : 'text-ink-400'">
      {{ displayValue != null ? fmtShares(displayValue) : '—' }}
    </span>
  </div>

  <!-- Open row, formula in effect: derived display + an "override" hover
       pill that on click promotes the cell to a typed input pre-filled
       with the derived value. -->
  <div v-else-if="!isOverride" class="relative group">
    <div class="cell-read flex items-center justify-end gap-1.5" :title="title">
      <span class="num text-[13px] text-ink-700" :class="displayValue != null ? 'derived cursor-help' : 'text-ink-400'">
        {{ displayValue != null ? fmtShares(displayValue) : '—' }}
      </span>
    </div>
    <button
      type="button"
      class="absolute -top-1 right-1 text-[9px] px-1 py-px rounded uppercase tracking-wider bg-white text-ink-500 border border-ink-200 opacity-0 group-hover:opacity-100 hover:text-ink-800 hover:border-ink-300"
      title="Type a value to override the formula"
      @click="emit('update', displayValue)"
    >
      override
    </button>
  </div>

  <!-- Open row, override active: typed-cell chrome with the override value,
       plus an "override" pill (always visible) that on click clears back
       to the formula. -->
  <label v-else class="relative cell-edit block" :title="title">
    <NumberInput
      variant="bare"
      :model-value="overrideValue"
      placeholder="—"
      :input-class="'num text-[13px] bg-transparent text-right'"
      @update:model-value="(v) => emit('update', v)"
      @blur="emit('commit')"
    />
    <button
      type="button"
      class="absolute -top-1 right-1 text-[9px] px-1 py-px rounded uppercase tracking-wider bg-edit text-white"
      title="Clear override — revert to formula"
      @click.stop="emit('update', null); emit('commit')"
    >
      override
    </button>
  </label>
</template>
