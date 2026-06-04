<script setup lang="ts">
// Sortable table header cell. Wraps the existing useSortableTable instance:
// click toggles sort on `col`, and the active column shows a direction arrow.
// `thClass` carries the per-column styling the host table already uses (align,
// padding, width) so headers keep their layout.
import { ArrowUp, ArrowDown } from 'lucide-vue-next'

defineProps<{
  table: { sort: { key: string; dir: 'asc' | 'desc' }; toggleSort: (k: string) => void }
  col: string
  align?: 'left' | 'right' | 'center'
  thClass?: string
}>()
</script>

<template>
  <th :class="thClass || (align === 'right' ? 'text-right font-medium px-3 py-2' : align === 'center' ? 'text-center font-medium px-3 py-2' : 'text-left font-medium px-3 py-2')">
    <button
      type="button"
      class="inline-flex items-center gap-1 hover:text-ink-900 select-none"
      :class="align === 'right' ? 'flex-row-reverse' : align === 'center' ? 'justify-center w-full' : ''"
      @click="table.toggleSort(col)"
    >
      <slot />
      <component
        :is="table.sort.key === col ? (table.sort.dir === 'asc' ? ArrowUp : ArrowDown) : null"
        :size="11"
        class="text-brand-600 shrink-0"
      />
    </button>
  </th>
</template>
