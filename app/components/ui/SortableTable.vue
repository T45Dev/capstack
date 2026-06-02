<script setup lang="ts" generic="T extends Record<string, any>">
import { ChevronUp, ChevronDown } from 'lucide-vue-next'
import type { SortableCol } from '~/composables/useSortableTable'

interface Props {
  // Column definitions. width is initial width in px.
  columns: SortableCol[]
  // Row data. Each row should have a stable `id` (or pass rowKey).
  rows: T[]
  // localStorage namespace for persisted column widths + sort state.
  storageKey: string
  // Initial sort. Defaults to first column ascending.
  defaultSort?: { key: string; dir: 'asc' | 'desc' }
  // Field on each row that uniquely identifies it.
  rowKey?: string
  // Optional precomputed sort overrides per column key, when you need to sort
  // by something other than the raw field (e.g. the active share-unit value).
  sortValue?: (row: T, key: string) => number | string | null | undefined
}

const props = withDefaults(defineProps<Props>(), { rowKey: 'id' })

const table = useSortableTable({
  key: props.storageKey,
  defaultSort: props.defaultSort,
  columns: props.columns,
})

const sortedRows = computed(() => {
  const k = table.sort.key
  const sign = table.sort.dir === 'asc' ? 1 : -1
  const getter = (r: T) => {
    if (props.sortValue) {
      const v = props.sortValue(r, k)
      if (v !== undefined) return v
    }
    return (r as any)[k]
  }
  return [...props.rows].sort((a, b) => {
    const av = getter(a), bv = getter(b)
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign
    return String(av).localeCompare(String(bv), 'en', { numeric: true }) * sign
  })
})

const totalWidth = computed(() => table.cols.reduce((sum, c) => sum + c.width, 0))
</script>

<template>
  <div class="overflow-x-auto table-scroll table-sticky-head">
    <table class="text-sm border-separate" :style="{ borderSpacing: 0, tableLayout: 'fixed', minWidth: totalWidth + 'px' }">
      <colgroup>
        <col v-for="col in table.cols" :key="col.key" :style="{ width: col.width + 'px' }" />
      </colgroup>
      <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide bg-ink-100">
        <tr>
          <th
            v-for="col in table.cols"
            :key="col.key"
            class="relative px-3 py-2 border-b border-ink-300 select-none font-semibold bg-ink-100"
            :class="[
              col.align === 'right' ? 'text-right' : (col.align === 'center' ? 'text-center' : 'text-left'),
              col.sortable ? 'cursor-pointer hover:text-ink-900' : '',
            ]"
            @click="col.sortable ? table.toggleSort(col.key) : null"
          >
            <span class="inline-flex items-center gap-1" :class="col.align === 'right' ? 'flex-row-reverse' : ''">
              <slot :name="`header-${col.key}`" :col="col">{{ col.label }}</slot>
              <ChevronUp v-if="table.sort.key === col.key && table.sort.dir === 'asc'" :size="12" class="text-brand-600" />
              <ChevronDown v-if="table.sort.key === col.key && table.sort.dir === 'desc'" :size="12" class="text-brand-600" />
            </span>
            <span
              class="resize-handle"
              @mousedown.prevent.stop="table.startResize($event, col.key)"
              @click.stop
            />
          </th>
        </tr>
      </thead>
      <tbody class="num">
        <tr
          v-for="(row, idx) in sortedRows"
          :key="(row as any)[rowKey] ?? idx"
          class="hover:bg-brand-50/40 transition-colors"
        >
          <td
            v-for="col in table.cols"
            :key="col.key"
            class="px-3 py-2 border-b border-ink-200 truncate"
            :class="col.align === 'right' ? 'text-right' : (col.align === 'center' ? 'text-center' : 'text-left')"
          >
            <slot :name="`cell-${col.key}`" :row="row" :value="(row as any)[col.key]">
              {{ (row as any)[col.key] }}
            </slot>
          </td>
        </tr>
        <slot name="footer" :rows="sortedRows" />
      </tbody>
    </table>
  </div>
</template>
