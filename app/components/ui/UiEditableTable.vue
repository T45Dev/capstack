<script setup lang="ts" generic="T extends Record<string, any>">
// Reusable inline-edit table per spec §6.
//
//   - Click a row to edit it in place (every editable cell becomes an input).
//   - "Add row" button at the bottom seeds a draft row inline; same edit UI.
//   - Delete button at the end of every user-row (skipped on read-only rows
//     via the `isReadOnly` prop callback).
//   - Sortable, resizable headers via the existing useSortableTable composable.
//
// Cell display in view-mode is read from row[col.key] by default; pass a
// `cell-<key>` slot to customize (e.g. for derived fields, badges, etc.).
//
// The component is intentionally permissive about typing — `T` is the row
// shape; column.type drives the input element used in edit mode. Owners
// decide when to call onCreate / onUpdate / onDelete; the table just bubbles
// the events with the draft payload.
import { ChevronUp, ChevronDown, Plus, Trash2, X, Check } from 'lucide-vue-next'
import type { SortableCol } from '~/composables/useSortableTable'

export type CellType = 'text' | 'number' | 'date' | 'select' | 'usd' | 'pct'

export interface EditableCol extends SortableCol {
  type?: CellType
  editable?: boolean              // default false
  options?: Array<{ value: any; label: string }>  // for type='select'
  placeholder?: string
  step?: string | number
}

interface Props {
  columns: EditableCol[]
  rows: T[]
  storageKey: string
  defaultSort?: { key: string; dir: 'asc' | 'desc' }
  rowKey?: string
  addLabel?: string
  // Seed for a new row when "Add row" is clicked.
  newRowDefaults?: Partial<T>
  // Row-level guard: return true to hide the delete/edit UI for that row.
  isReadOnly?: (row: T) => boolean
  // Custom sort getter — same convention as SortableTable.vue.
  sortValue?: (row: T, key: string) => number | string | null | undefined
  // Total below the rows: bool to enable, optional cells map.
  showAddRow?: boolean
  // Sticky-pin the first column to the left edge so it stays visible
  // while the rest of the table scrolls horizontally.
  stickyFirst?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  rowKey: 'id',
  addLabel: 'Add row',
  showAddRow: true,
  stickyFirst: false,
})

const emit = defineEmits<{
  create: [draft: Partial<T>]
  update: [row: T, patch: Partial<T>]
  delete: [row: T]
}>()

const table = useSortableTable({
  key: props.storageKey,
  defaultSort: props.defaultSort,
  columns: props.columns,
})

// Keep table.cols in sync if the parent reactively changes columns.
watch(() => props.columns, (next) => {
  const widthMap: Record<string, number> = {}
  for (const c of table.cols) widthMap[c.key] = c.width
  const merged = next.map(c => ({ ...c, width: widthMap[c.key] ?? c.width }))
  table.cols.splice(0, table.cols.length, ...(merged as any))
}, { deep: true })

const sortedRows = computed(() => {
  const k = table.sort.key
  const sign = table.sort.dir === 'asc' ? 1 : -1
  const getter = (r: T): any => {
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

const totalWidth = computed(() => table.cols.reduce((sum, c) => sum + c.width, 0) + ACTIONS_WIDTH)
const ACTIONS_WIDTH = 70

// ---- Edit state ----
const editingRowId = ref<string | null>(null)
const draft = reactive<Record<string, any>>({})

function startEdit(row: T) {
  if (props.isReadOnly?.(row)) return
  editingRowId.value = (row as any)[props.rowKey]
  // Copy editable fields into the draft. Non-editable columns stay
  // untouched (we don't emit patches for them).
  for (const c of table.cols) {
    (draft as any)[c.key] = (row as any)[c.key]
  }
}

function cancelEdit() {
  editingRowId.value = null
  for (const k of Object.keys(draft)) delete (draft as any)[k]
  adding.value = false
}

async function saveEdit(row: T) {
  const patch: Partial<T> = {}
  for (const c of table.cols) {
    if (!c.editable) continue
    const cur = (row as any)[c.key]
    const next = (draft as any)[c.key]
    if (cur !== next) (patch as any)[c.key] = next
  }
  if (Object.keys(patch).length > 0) emit('update', row, patch)
  cancelEdit()
}

// ---- Add state ----
const adding = ref(false)
function startAdd() {
  if (editingRowId.value) cancelEdit()
  adding.value = true
  for (const k of Object.keys(draft)) delete (draft as any)[k]
  for (const c of table.cols) {
    (draft as any)[c.key] = (props.newRowDefaults as any)?.[c.key] ?? null
  }
}
function commitAdd() {
  // Only emit defined values to keep the API tidy.
  const payload: Partial<T> = {}
  for (const c of table.cols) {
    const v = (draft as any)[c.key]
    if (v !== null && v !== undefined && v !== '') (payload as any)[c.key] = v
  }
  emit('create', payload)
  cancelEdit()
}

async function onDelete(row: T) {
  if (props.isReadOnly?.(row)) return
  emit('delete', row)
}

function isEditingRow(row: T): boolean {
  return editingRowId.value === (row as any)[props.rowKey]
}
</script>

<template>
  <div class="border border-ink-200 rounded-lg bg-white overflow-hidden shadow-[0_1px_0_rgba(16,24,40,0.04)]">
    <div class="overflow-x-auto table-scroll">
      <table class="text-[13px] border-separate" :style="{ borderSpacing: 0, tableLayout: 'fixed', minWidth: totalWidth + 'px' }">
        <colgroup>
          <col v-for="col in table.cols" :key="col.key" :style="{ width: col.width + 'px' }" />
          <col :style="{ width: ACTIONS_WIDTH + 'px' }" />
        </colgroup>
        <thead class="bg-ink-50/60">
          <tr>
            <th
              v-for="(col, colIdx) in table.cols"
              :key="col.key"
              class="relative px-2.5 py-2 border-b border-ink-200 select-none"
              :class="[
                col.align === 'right' ? 'text-right' : (col.align === 'center' ? 'text-center' : 'text-left'),
                col.sortable ? 'cursor-pointer hover:bg-ink-100' : '',
                stickyFirst && colIdx === 0 ? 'sticky left-0 z-20 bg-ink-50/95 backdrop-blur shadow-[1px_0_0_0_rgb(0_0_0/0.06)]' : '',
              ]"
              @click="col.sortable ? table.toggleSort(col.key) : null"
            >
              <span
                class="inline-flex items-center gap-1 text-[11.5px] text-ink-700 font-medium whitespace-nowrap"
                :class="col.align === 'right' ? 'flex-row-reverse' : ''"
              >
                <slot :name="`header-${col.key}`" :col="col">{{ col.label }}</slot>
                <ChevronUp v-if="table.sort.key === col.key && table.sort.dir === 'asc'" :size="12" class="text-brand" />
                <ChevronDown v-if="table.sort.key === col.key && table.sort.dir === 'desc'" :size="12" class="text-brand" />
              </span>
              <span class="resize-handle" @mousedown.prevent.stop="table.startResize($event, col.key)" @click.stop />
            </th>
            <th class="px-2 py-2 border-b border-ink-200 bg-ink-50/60"></th>
          </tr>
        </thead>
        <tbody class="num">
          <tr
            v-for="row in sortedRows"
            :key="(row as any)[rowKey]"
            class="group transition-colors border-b border-ink-100 last:border-b-0"
            :class="[
              isEditingRow(row) ? 'bg-brand-soft/40' : 'hover:bg-ink-50/40 cursor-pointer',
              isReadOnly?.(row) ? 'opacity-90' : '',
            ]"
            @click="!isEditingRow(row) && startEdit(row)"
          >
            <td
              v-for="(col, colIdx) in table.cols"
              :key="col.key"
              class="px-2.5 py-1.5 align-middle"
              :class="[
                col.align === 'right' ? 'text-right' : (col.align === 'center' ? 'text-center' : 'text-left'),
                stickyFirst && colIdx === 0
                  ? (isEditingRow(row)
                    ? 'sticky left-0 z-10 bg-brand-soft/60 shadow-[1px_0_0_0_rgb(0_0_0/0.06)]'
                    : 'sticky left-0 z-10 bg-white shadow-[1px_0_0_0_rgb(0_0_0/0.06)] group-hover:bg-ink-50/40')
                  : '',
              ]"
              @click.stop="!isEditingRow(row) && startEdit(row)"
            >
              <template v-if="isEditingRow(row) && col.editable">
                <label v-if="col.type === 'date'" class="cell-edit block">
                  <DateInput
                    variant="bare"
                    :model-value="(draft[col.key] as string | null) ?? null"
                    @update:model-value="(v) => draft[col.key] = v"
                  />
                </label>
                <label v-else class="cell-edit block">
                  <input
                    v-if="col.type === 'text' || !col.type"
                    v-model="draft[col.key]"
                    type="text"
                    :placeholder="col.placeholder"
                    @keydown.enter="saveEdit(row)"
                    @keydown.esc="cancelEdit"
                  />
                  <input
                    v-else-if="col.type === 'number'"
                    v-model.number="draft[col.key]"
                    type="number"
                    :step="col.step ?? '1'"
                    :placeholder="col.placeholder"
                    class="text-right"
                    @keydown.enter="saveEdit(row)"
                    @keydown.esc="cancelEdit"
                  />
                  <input
                    v-else-if="col.type === 'usd'"
                    v-model.number="draft[col.key]"
                    type="number"
                    :step="col.step ?? '1000'"
                    class="text-right"
                    @keydown.enter="saveEdit(row)"
                    @keydown.esc="cancelEdit"
                  />
                  <input
                    v-else-if="col.type === 'pct'"
                    v-model.number="draft[col.key]"
                    type="number"
                    :step="col.step ?? '0.01'"
                    class="text-right"
                    @keydown.enter="saveEdit(row)"
                    @keydown.esc="cancelEdit"
                  />
                  <select
                    v-else-if="col.type === 'select'"
                    v-model="draft[col.key]"
                    @keydown.enter="saveEdit(row)"
                    @keydown.esc="cancelEdit"
                  >
                    <option :value="null">—</option>
                    <option v-for="o in (col.options || [])" :key="String(o.value)" :value="o.value">{{ o.label }}</option>
                  </select>
                </label>
              </template>
              <template v-else>
                <slot :name="`cell-${col.key}`" :row="row" :value="(row as any)[col.key]">
                  <span class="text-ink-800">{{ (row as any)[col.key] ?? '—' }}</span>
                </slot>
              </template>
            </td>
            <td class="px-2 py-1.5 text-right whitespace-nowrap align-middle" @click.stop>
              <template v-if="isEditingRow(row)">
                <button class="text-ok hover:opacity-80 px-1 py-0.5 rounded" @click="saveEdit(row)" title="Save"><Check :size="14" /></button>
                <button class="text-ink-500 hover:text-ink-900 px-1 py-0.5 rounded" @click="cancelEdit" title="Cancel"><X :size="14" /></button>
              </template>
              <template v-else-if="!isReadOnly?.(row)">
                <button class="text-ink-400 hover:text-red-600 px-1 py-0.5 rounded opacity-0 group-hover:opacity-100" @click="onDelete(row)" title="Delete"><Trash2 :size="13" /></button>
              </template>
            </td>
          </tr>

          <!-- Inline add-row: a draft row at the bottom that becomes editable
               once the user clicks "Add". -->
          <tr v-if="adding" class="bg-brand-soft/40 border-b border-ink-100">
            <td
              v-for="col in table.cols"
              :key="col.key"
              class="px-2.5 py-1.5 align-middle"
              :class="col.align === 'right' ? 'text-right' : (col.align === 'center' ? 'text-center' : 'text-left')"
            >
              <template v-if="col.editable">
                <label v-if="col.type === 'date'" class="cell-edit block">
                  <DateInput
                    variant="bare"
                    :model-value="(draft[col.key] as string | null) ?? null"
                    @update:model-value="(v) => draft[col.key] = v"
                  />
                </label>
                <label v-else class="cell-edit block">
                  <input
                    v-if="col.type === 'text' || !col.type"
                    v-model="draft[col.key]"
                    type="text"
                    :placeholder="col.placeholder"
                    @keydown.enter="commitAdd"
                    @keydown.esc="cancelEdit"
                  />
                  <input
                    v-else-if="col.type === 'number'"
                    v-model.number="draft[col.key]"
                    type="number"
                    :step="col.step ?? '1'"
                    class="text-right"
                    @keydown.enter="commitAdd"
                    @keydown.esc="cancelEdit"
                  />
                  <input
                    v-else-if="col.type === 'usd'"
                    v-model.number="draft[col.key]"
                    type="number"
                    :step="col.step ?? '1000'"
                    class="text-right"
                    @keydown.enter="commitAdd"
                    @keydown.esc="cancelEdit"
                  />
                  <input
                    v-else-if="col.type === 'pct'"
                    v-model.number="draft[col.key]"
                    type="number"
                    :step="col.step ?? '0.01'"
                    class="text-right"
                    @keydown.enter="commitAdd"
                    @keydown.esc="cancelEdit"
                  />
                  <select
                    v-else-if="col.type === 'select'"
                    v-model="draft[col.key]"
                    @keydown.enter="commitAdd"
                    @keydown.esc="cancelEdit"
                  >
                    <option :value="null">—</option>
                    <option v-for="o in (col.options || [])" :key="String(o.value)" :value="o.value">{{ o.label }}</option>
                  </select>
                </label>
              </template>
              <span v-else class="text-ink-400 text-xs">—</span>
            </td>
            <td class="px-2 py-1.5 text-right whitespace-nowrap align-middle">
              <button class="text-ok hover:opacity-80 px-1 py-0.5 rounded" @click="commitAdd" title="Add"><Check :size="14" /></button>
              <button class="text-ink-500 hover:text-ink-900 px-1 py-0.5 rounded" @click="cancelEdit" title="Cancel"><X :size="14" /></button>
            </td>
          </tr>

          <!-- Add-row trigger -->
          <tr v-if="showAddRow && !adding">
            <td :colspan="table.cols.length + 1" class="px-2.5 py-2 text-left bg-ink-50/30">
              <button
                type="button"
                class="inline-flex items-center gap-1 text-[12px] text-ink-500 hover:text-brand-edge hover:bg-brand-soft px-2 py-1 rounded"
                @click="startAdd"
              >
                <Plus :size="12" /> {{ addLabel }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
/* Show the delete button when hovering any cell of the row. Using a sibling
   class on the row would interfere with the cursor:pointer hint, so we just
   toggle the button's own opacity via group-hover. */
tbody tr:hover button[title="Delete"] {
  opacity: 1;
}
</style>
