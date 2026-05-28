<script setup lang="ts">
// Column header for the Financings matrix. Neutral tone — edit affordance
// is conveyed at the CELL level (typed cells have border chrome, derived
// cells have a dotted underline), not in the header.
interface Props {
  label: string
  kind: 'typed' | 'derived' | 'override'
  hint?: string | null
  align?: 'left' | 'right'
  isFirstInGroup?: boolean
  groupTone?: 'money' | 'shares' | null
}
withDefaults(defineProps<Props>(), { align: 'left', hint: null, isFirstInGroup: false, groupTone: null })
</script>

<template>
  <div
    class="px-2.5 py-2 bg-ink-50/60"
    :class="isFirstInGroup ? 'border-l border-ink-200' : ''"
  >
    <div
      class="text-[10.5px] uppercase tracking-[0.06em] text-ink-500 font-semibold whitespace-nowrap"
      :class="align === 'right' ? 'text-right' : ''"
    >
      {{ label }}
    </div>
    <div
      v-if="hint"
      class="text-[10px] text-ink-400 num mt-0.5 whitespace-nowrap"
      :class="align === 'right' ? 'text-right' : ''"
    >
      {{ hint }}
    </div>
  </div>
</template>
