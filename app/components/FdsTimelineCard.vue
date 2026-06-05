<script setup lang="ts">
// Round-history / FDS timeline editor. Dated cap-table points (one per
// historical round): FDS, price, and any option-pool increase. Drives the
// Grant Fairness hire-basis, the Previous-Round base FDS (when present), and
// the Option Pool Impact timeline. Lives on the Financings page.
const props = defineProps<{ companyId: string }>()
const emit = defineEmits<{ changed: [] }>()

interface Milestone { id: string; as_of_date: string | null; label: string | null; fds: number | null; pps: number | null; option_pool: number | null }
const { data: milestones, refresh } = await useFetch<Milestone[]>(
  () => `/api/companies/${props.companyId}/milestones`,
  { watch: [() => props.companyId], default: () => [] },
)
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
      <table class="text-[13px] num">
        <thead>
          <tr class="text-[11px] uppercase tracking-wider text-ink-500 border-b border-ink-200 bg-ink-100 whitespace-nowrap">
            <th class="text-left font-medium px-4 py-2">As-of date</th>
            <th class="text-left font-medium px-3 py-2">Label</th>
            <th class="text-right font-medium px-3 py-2">Fully-diluted shares</th>
            <th class="text-right font-medium px-3 py-2">Price / share</th>
            <th class="text-right font-medium px-3 py-2">Option pool +</th>
            <th class="px-3 py-2 w-10"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in milestones" :key="m.id" class="even:bg-ink-50/50 border-b border-ink-100 last:border-0">
            <td class="px-4 py-1.5">
              <DateInput variant="bare" no-hint :model-value="m.as_of_date" @update:model-value="(v) => patchMilestone(m, 'as_of_date', v)" />
            </td>
            <td class="px-3 py-1.5">
              <input class="w-full bg-transparent text-[13px] focus:outline-none" :value="m.label || ''" placeholder="e.g. Series A" @change="(ev) => patchMilestone(m, 'label', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-3 py-1.5 text-right">
              <input class="num w-full bg-transparent text-right text-[13px] focus:outline-none" :value="fmtFds(m.fds)" inputmode="numeric" placeholder="—" @change="(ev) => patchMilestone(m, 'fds', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-3 py-1.5 text-right">
              <input class="num w-full bg-transparent text-right text-[13px] focus:outline-none" :value="m.pps ?? ''" inputmode="decimal" placeholder="—" @change="(ev) => patchMilestone(m, 'pps', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-3 py-1.5 text-right">
              <input class="num w-full bg-transparent text-right text-[13px] focus:outline-none" :value="fmtFds(m.option_pool)" inputmode="numeric" placeholder="—" @change="(ev) => patchMilestone(m, 'option_pool', (ev.target as HTMLInputElement).value)">
            </td>
            <td class="px-3 py-1.5 text-center">
              <button type="button" class="text-ink-400 hover:text-red-600" title="Delete" @click="deleteMilestone(m)">×</button>
            </td>
          </tr>
          <tr class="bg-ink-50/30">
            <td class="px-4 py-1.5"><DateInput variant="bare" no-hint :model-value="newMs.as_of_date || null" placeholder="add date" @update:model-value="(v) => newMs.as_of_date = v || ''" /></td>
            <td class="px-3 py-1.5"><input v-model="newMs.label" class="w-full bg-transparent text-[13px] focus:outline-none" placeholder="Series A" @keydown.enter="addMilestone"></td>
            <td class="px-3 py-1.5 text-right"><input v-model="newMs.fds" class="num w-full bg-transparent text-right text-[13px] focus:outline-none" inputmode="numeric" placeholder="FDS" @keydown.enter="addMilestone"></td>
            <td class="px-3 py-1.5 text-right"><input v-model="newMs.pps" class="num w-full bg-transparent text-right text-[13px] focus:outline-none" inputmode="decimal" placeholder="$/sh" @keydown.enter="addMilestone"></td>
            <td class="px-3 py-1.5 text-right"><input v-model="newMs.option_pool" class="num w-full bg-transparent text-right text-[13px] focus:outline-none" inputmode="numeric" placeholder="pool +" @keydown.enter="addMilestone"></td>
            <td class="px-3 py-1.5 text-center"><button type="button" class="text-brand-edge hover:text-brand-deep text-lg leading-none" title="Add" @click="addMilestone">+</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="px-4 py-2 text-[11px] text-ink-500 border-t border-ink-100">
      A start date before the earliest row snaps to that earliest point. Enter a pool increase here <em>or</em> on a round, not both.
    </p>
  </UiCard>
</template>
