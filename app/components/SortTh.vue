<script setup lang="ts">
// Sortable + resizable table header cell. Wraps a useSortableTable instance:
// click toggles sort on `col`, the active column shows a direction arrow, and
// (when the table exposes startResize) a drag handle on the right edge resizes
// the column. `thClass` carries the per-column styling the host table already
// uses (align, padding) so headers keep their layout.
//
// Resize only takes visible effect when the host <table> is laid out with a
// <colgroup> bound to the same cols' widths and table-layout:fixed — use the
// TableColgroup component for that.
import { ArrowUp, ArrowDown } from 'lucide-vue-next'

const props = defineProps<{
  table: {
    sort: { key: string; dir: 'asc' | 'desc' }
    toggleSort: (k: string) => void
    startResize?: (e: MouseEvent, k: string) => void
  }
  col: string
  align?: 'left' | 'right' | 'center'
  thClass?: string
  // Force-disable the resize handle even when the table supports it.
  resizable?: boolean
}>()

const showResize = computed(() => props.resizable !== false && typeof props.table.startResize === 'function')
</script>

<template>
  <th class="relative whitespace-nowrap" :class="thClass || (align === 'right' ? 'text-right font-medium px-3 py-2' : align === 'center' ? 'text-center font-medium px-3 py-2' : 'text-left font-medium px-3 py-2')">
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
    <span
      v-if="showResize"
      class="resize-handle"
      @mousedown.prevent.stop="table.startResize!($event, col)"
      @click.stop
    />
  </th>
</template>
