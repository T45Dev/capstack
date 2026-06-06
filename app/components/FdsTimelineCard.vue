<script setup lang="ts">
// Round-history / FDS timeline editor. Dated cap-table points (one per
// historical round): FDS, price, and any option-pool increase. Drives the
// Grant Fairness hire-basis, the Previous-Round base FDS (when present), and
// the Option Pool Impact timeline. Lives on the Financings page.
//
// Columns are width-persisted and drag-resizable via useSortableTable (the
// same handle pattern UiEditableTable uses). We only borrow its width/resize
// machinery — rows stay in the server's chronological order, so sorting is
// disabled. table-fixed + a <colgroup> let the <col> widths drive the layout
// so a wide figure can't blow a column open.
const props = defineProps<{ companyId: string }>()
const emit = defineEmits<{ changed: [] }>()

interface Milestone { id: string; as_of_date: string | null; label: string | null; fds: number | null; pps: number | null; option_pool: number | null }
const { data: milestones, refresh } = await useFetch<Milestone[]>(
  () => `/api/companies/${props.companyId}/milestones`,
  { watch: [() => props.companyId], default: () => [] },
)

const table = useSortableTable({
  key: 'capstack:fds-timeline',
  columns: [
    { key: 'as_of_date',  label: 'As-of date',          width: 130 },
    { key: 'label',       label: 'Label',               width: 150 },
    { key: 'fds',         label: 'Fully-diluted shares', width: 165 },
    { key: 'pps',         label: 'Price / share',       width: 125 },
    { key: 'option_pool', label: 'Option pool +',       width: 130 },
  ],
})
const ACTIONS_WIDTH = 44
const totalWidth = computed(() => table.cols.reduce((sum, c) => sum + c.width, 0) + ACTIONS_WIDTH)

const fresh = () => ({ as_of_date: '', label: '', fds: '', pps: '', option_pool: '' })
const newMs = reactive(fresh())
const fmtFds = (n: number | null) => n != null ? Number(n).toLocaleString() : ''

async function addMilestone() {
  if (!newMs.as_of_date) return
  await $fetch(`/api/companies/${props.companyId}/milestones`, { method: 'POST', body: { ...newMs } })
  Object.assign(newMs, fresh())
  await refresh(); emit('changed')
}
async function patchMilestone(m: Milestone, field: 'as_of_date' | 'label' | 'fds' | 'pps' | 'option_pool', value: any) {
  await $fetch(`/api/milestones/${m.id}`, { method: 'PATCH', body: { [field]: value } })
  await refresh(); emit('changed')
}
async function deleteMilestone(m: Milestone) {
  await $fetch(`/api/milestones/${m.id}`, { method: 'DELETE' })
  await refresh(); emit('changed')
}
</script>

<template>
  <UiCard title="Round history (FDS timeline)" subtitle="One row per historical round — date · FDS · price · pool increase. The latest row sets the Previous-Round base; rows feed the Fairness hire-basis and dated Option Pool top-ups. Only the open round needs full economics (above)." :padded="false">
    <div class="overflow-x-auto">
      <table class="text-[13px] num" :style="{ tableLayout: 'fixed', minWidth: totalWidth + 'px' }">
        <colgroup>
          <col v-for="col in table.cols" :key="col.key" :style="{ width: col.width + 'px' }" />
          <col :style="{ width: ACTIONS_WIDTH + 'px' }" />
        </colgroup>
        <thead>
          <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200 bg-ink-100 whitespace-nowrap">
            <th
              v-for="col in table.cols"
              :key="col.key"
              class="relative text-left font-medium px-3 py-2 select-none first:pl-4"
            >
              {{ col.label }}
              <span class="resize-handle" @mousedown.prevent.stop="table.startResize($event, col.key)" @click.stop />
            </th>
            <th class="px-2 py-2"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in milestones" :key="m.id" class="even:bg-ink-50/50 border-b border-ink-100 last:border-0">
            <td class="px-3 py-1.5 pl-4">
              <DateInput variant="bare" no-hint :model-value="m.as_of_date" @update:model-value="(v) => patchMilestone(m, 'as_of_date', v)" />
            </td>
            <td class="px-3 py-1.5">
              <input class="w-full bg-transparent text-left text-[13px] focus:outline-none" :value="m.label || ''" placeholder="e.g. Series A" @change="(ev) => patchMilestone(m, 'label', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-3 py-1.5">
              <input class="num w-full bg-transparent text-left text-[13px] focus:outline-none" :value="fmtFds(m.fds)" inputmode="numeric" placeholder="—" @change="(ev) => patchMilestone(m, 'fds', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-3 py-1.5">
              <input class="num w-full bg-transparent text-left text-[13px] focus:outline-none" :value="m.pps ?? ''" inputmode="decimal" placeholder="—" @change="(ev) => patchMilestone(m, 'pps', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-3 py-1.5">
              <input class="num w-full bg-transparent text-left text-[13px] focus:outline-none" :value="fmtFds(m.option_pool)" inputmode="numeric" placeholder="—" @change="(ev) => patchMilestone(m, 'option_pool', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-2 py-1.5 text-center">
              <button type="button" class="text-ink-400 hover:text-red-600" title="Delete" @click="deleteMilestone(m)">×</button>
            </td>
          </tr>
          <tr class="bg-ink-50/30">
            <td class="px-3 py-1.5 pl-4"><DateInput variant="bare" no-hint :model-value="newMs.as_of_date || null" placeholder="add date" @update:model-value="(v) => newMs.as_of_date = v || ''" /></td>
            <td class="px-3 py-1.5"><input v-model="newMs.label" class="w-full bg-transparent text-left text-[13px] focus:outline-none" placeholder="Series A" @keydown.enter="addMilestone"></td>
            <td class="px-3 py-1.5"><input v-model="newMs.fds" class="num w-full bg-transparent text-left text-[13px] focus:outline-none" inputmode="numeric" placeholder="FDS" @keydown.enter="addMilestone"></td>
            <td class="px-3 py-1.5"><input v-model="newMs.pps" class="num w-full bg-transparent text-left text-[13px] focus:outline-none" inputmode="decimal" placeholder="$/sh" @keydown.enter="addMilestone"></td>
            <td class="px-3 py-1.5"><input v-model="newMs.option_pool" class="num w-full bg-transparent text-left text-[13px] focus:outline-none" inputmode="numeric" placeholder="pool +" @keydown.enter="addMilestone"></td>
            <td class="px-2 py-1.5 text-center"><button type="button" class="text-brand-edge hover:text-brand-deep text-lg leading-none" title="Add" @click="addMilestone">+</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="px-4 py-2 text-[11px] text-ink-500 border-t border-ink-100">
      A start date before the earliest row snaps to that earliest point. Enter a pool increase here <em>or</em> on a round, not both. Drag a column edge to resize.
    </p>
  </UiCard>
</template>
