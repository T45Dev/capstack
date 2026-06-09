<script setup lang="ts">
// Standard name cell for every people-table. Renders, in order:
//
//   [ISO/NSO]  Name  [PROPOSED|IDEA]  [+N LINKED]
//
// - award:  'ISO' | 'NSO' — leading fixed-width chip. Only set it on rows that
//           represent an option grant; founders / investors / common holders
//           pass null and show no award chip.
// - source: 'proposed' | 'idea' — status chip. Proposed is blue, idea is
//           yellow. 'grant'/null shows nothing.
// - linked: count of alias stakeholders folded into this row (the rollup).
//
// The ISO/NSO chip is a fixed width so the two read identically and every
// row's name starts at the same x. Used everywhere so the format lives in one
// place — don't hand-roll name + chips in a table again.
interface Props {
  name: string
  award?: string | null
  source?: string | null
  linked?: number
  linkedNames?: string[]
  // Tooltip override for the name (defaults to the name itself).
  title?: string | null
}
const props = withDefaults(defineProps<Props>(), { linked: 0 })

const CHIP = 'text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border align-middle shrink-0'
const SOURCE: Record<string, { label: string; cls: string }> = {
  proposed: { label: 'Proposed', cls: 'border-blue-200 bg-blue-50 text-blue-700' },
  idea: { label: 'Idea', cls: 'border-amber-300 bg-amber-50 text-amber-700' },
}
const source = computed(() => (props.source && SOURCE[props.source]) || null)
const linkTitle = computed(() => (props.linkedNames?.length ? `Rolls up: ${props.linkedNames.join(', ')}` : undefined))
</script>

<template>
  <span class="inline-flex items-center gap-1.5 min-w-0 max-w-full">
    <span
      v-if="award"
      class="inline-flex justify-center w-9 border-ink-200 bg-ink-100 text-ink-600"
      :class="CHIP"
    >{{ award }}</span>
    <span class="truncate text-ink-900 font-medium" :title="title || name">{{ name }}</span>
    <span v-if="source" :class="[CHIP, source.cls]">{{ source.label }}</span>
    <span
      v-if="linked > 0"
      class="border-brand-200 bg-brand-soft text-brand-edge"
      :class="CHIP"
      :title="linkTitle"
    >+{{ linked }} linked</span>
  </span>
</template>
