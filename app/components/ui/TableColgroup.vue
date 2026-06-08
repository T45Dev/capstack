<script setup lang="ts">
// Reusable <colgroup> for a resizable table: one <col> per useSortableTable
// column, width-bound to the column's reactive width so drag-resize (via
// SortTh / the resize-handle) actually moves the column. Pair with a
// minWidth = Σ widths on the <table> (and table-layout:fixed when you want
// columns to shrink as well as grow).
//
// `leading` / `trailing` add fixed-width <col>s before/after the data columns
// for non-sortable columns the cols array doesn't include (a leading checkbox,
// a trailing actions/delete column, etc.) so every column still lines up.
import type { SortableCol } from '~/composables/useSortableTable'

defineProps<{
  cols: Pick<SortableCol, 'key' | 'width'>[]
  leading?: number[]
  trailing?: number[]
}>()
</script>

<template>
  <colgroup>
    <col v-for="(w, i) in (leading || [])" :key="`l${i}`" :style="{ width: w + 'px' }" />
    <col v-for="c in cols" :key="c.key" :style="{ width: c.width + 'px' }" />
    <col v-for="(w, i) in (trailing || [])" :key="`t${i}`" :style="{ width: w + 'px' }" />
  </colgroup>
</template>
