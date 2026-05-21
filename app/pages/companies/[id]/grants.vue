<script setup lang="ts">
import { Plus, Trash2, Edit3, Award, ChevronUp, ChevronDown } from 'lucide-vue-next'
import { fmtShares, fmtPct, fmtDate, fmtPricePerShare } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

interface Grant {
  id: string
  recipient_name: string
  recipient_type: string | null
  round: string | null
  quantity: number
  strike: number | null
  issue_date: string | null
  vesting_start: string | null
  vest_months: number | null
  cliff_months: number | null
  status: 'outstanding' | 'proposed' | 'cancelled'
  notes: string | null
  linked_stakeholder: string | null
}
interface Pool { id: string; name: string; authorized: number }

const { data, refresh } = await useFetch<{ grants: Grant[]; pools: Pool[] }>(() => `/api/companies/${id.value}/grants`, { watch: [id], default: () => ({ grants: [], pools: [] } as any) })

const outstanding = computed(() => data.value!.grants.filter(g => g.status === 'outstanding'))
const proposed = computed(() => data.value!.grants.filter(g => g.status === 'proposed'))

const totalOutstanding = computed(() => outstanding.value.reduce((a, g) => a + g.quantity, 0))
const totalProposed = computed(() => proposed.value.reduce((a, g) => a + g.quantity, 0))
const poolAuthorized = computed(() => data.value!.pools.reduce((a, p) => a + p.authorized, 0))
const poolAvailable = computed(() => Math.max(0, poolAuthorized.value - totalOutstanding.value - totalProposed.value))

const { format: fmtShare, compareValue } = useShareUnit()

// Sortable tables
const outstandingTable = useSortableTable({
  key: 'capstack:grants:outstanding',
  defaultSort: { key: 'quantity', dir: 'desc' },
  columns: [
    { key: 'recipient_name', label: 'Recipient', width: 200, sortable: true, align: 'left' },
    { key: 'recipient_type', label: 'Type', width: 110, sortable: true, align: 'left' },
    { key: 'round', label: 'Round', width: 140, sortable: true, align: 'left' },
    { key: 'quantity', label: 'Quantity', width: 120, sortable: true, align: 'right' },
    { key: 'strike', label: 'Strike', width: 100, sortable: true, align: 'right' },
    { key: 'issue_date', label: 'Issued', width: 120, sortable: true, align: 'left' },
    { key: 'vest', label: 'Vest', width: 140, sortable: true, align: 'right' },
    { key: 'actions', label: '', width: 80, sortable: false, align: 'right' },
  ],
})
const proposedTable = useSortableTable({
  key: 'capstack:grants:proposed',
  defaultSort: { key: 'quantity', dir: 'desc' },
  columns: [
    { key: 'recipient_name', label: 'Recipient', width: 200, sortable: true, align: 'left' },
    { key: 'recipient_type', label: 'Type', width: 110, sortable: true, align: 'left' },
    { key: 'quantity', label: 'Quantity', width: 120, sortable: true, align: 'right' },
    { key: 'poolPct', label: '% of available', width: 130, sortable: true, align: 'right' },
    { key: 'actions', label: '', width: 200, sortable: false, align: 'right' },
  ],
})

const sortedOutstanding = computed(() => {
  const rows = outstanding.value.map(g => ({ ...g }))
  const k = outstandingTable.sort.key
  const sign = outstandingTable.sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av: any = k === 'quantity' ? compareValue(a.quantity, poolAuthorized.value, a.strike || 0) : (a as any)[k]
    const bv: any = k === 'quantity' ? compareValue(b.quantity, poolAuthorized.value, b.strike || 0) : (b as any)[k]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign
    return String(av).localeCompare(String(bv), 'en', { numeric: true }) * sign
  })
})
const sortedProposed = computed(() => {
  const rows = proposed.value.map(g => ({ ...g, poolPct: poolAvailable.value ? g.quantity / poolAvailable.value : 0 }))
  return proposedTable.applySort(rows)
})

function sortIconFor(table: ReturnType<typeof useSortableTable>, key: string) {
  if (table.sort.key !== key) return null
  return table.sort.dir
}

// ----- form state -----
const showCreate = ref(false)
const editing = ref<Grant | null>(null)
const form = reactive({
  recipient_name: '',
  recipient_type: 'Employee',
  round: 'Post-A4 / Pre-B',
  quantity: 0,
  strike: null as number | null,
  issue_date: new Date().toISOString().slice(0, 10),
  vesting_start: new Date().toISOString().slice(0, 10),
  vest_months: 48,
  cliff_months: 12,
  status: 'proposed' as 'outstanding' | 'proposed',
  notes: '',
})

function reset() {
  form.recipient_name = ''
  form.recipient_type = 'Employee'
  form.round = 'Post-A4 / Pre-B'
  form.quantity = 0
  form.strike = null
  form.issue_date = new Date().toISOString().slice(0, 10)
  form.vesting_start = new Date().toISOString().slice(0, 10)
  form.vest_months = 48
  form.cliff_months = 12
  form.status = 'proposed'
  form.notes = ''
  editing.value = null
}

function startEdit(g: Grant) {
  editing.value = g
  form.recipient_name = g.recipient_name
  form.recipient_type = g.recipient_type || 'Employee'
  form.round = g.round || 'Post-A4 / Pre-B'
  form.quantity = g.quantity
  form.strike = g.strike
  form.issue_date = g.issue_date || ''
  form.vesting_start = g.vesting_start || ''
  form.vest_months = g.vest_months ?? 48
  form.cliff_months = g.cliff_months ?? 12
  form.status = (g.status === 'cancelled' ? 'proposed' : g.status) as any
  form.notes = g.notes || ''
  showCreate.value = true
}

const saving = ref(false)
async function save() {
  if (!form.recipient_name.trim() || form.quantity <= 0 || saving.value) return
  saving.value = true
  try {
    if (editing.value) {
      await $fetch(`/api/grants/${editing.value.id}`, { method: 'PATCH', body: form })
    } else {
      await $fetch(`/api/companies/${id.value}/grants`, { method: 'POST', body: form })
    }
    showCreate.value = false
    reset()
    await refresh()
  } finally {
    saving.value = false
  }
}

async function cancel(g: Grant) {
  if (!confirm(`Cancel grant of ${g.quantity} to ${g.recipient_name}?`)) return
  await $fetch(`/api/grants/${g.id}`, { method: 'PATCH', body: { status: 'cancelled' } })
  await refresh()
}

async function promote(g: Grant) {
  await $fetch(`/api/grants/${g.id}`, { method: 'PATCH', body: { status: 'outstanding' } })
  await refresh()
}

async function destroy(g: Grant) {
  if (!confirm(`Permanently delete grant for ${g.recipient_name}? (history will not be retained)`)) return
  await $fetch(`/api/grants/${g.id}`, { method: 'DELETE' })
  await refresh()
}
</script>

<template>
  <div v-if="data">
    <div class="flex items-end justify-between mb-5 gap-3 flex-wrap">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight text-ink-900">Option grants</h1>
        <p class="text-sm text-ink-600 mt-1">Outstanding grants from the cap table, plus any proposed grants you're modelling.</p>
      </div>
      <UiButton variant="primary" @click="reset(); showCreate = true"><Plus :size="14" /> Propose grant</UiButton>
    </div>

    <!-- Pool stats -->
    <div class="flex flex-wrap gap-3 mb-6">
      <UiStat label="Pool authorized" :value="fmtShares(poolAuthorized)" class="flex-1 min-w-[150px]" />
      <UiStat label="Outstanding" :value="fmtShares(totalOutstanding)" class="flex-1 min-w-[150px]" />
      <UiStat label="Proposed" :value="fmtShares(totalProposed)" class="flex-1 min-w-[150px]" />
      <UiStat label="Available" :value="fmtShares(poolAvailable)" emphasis class="flex-1 min-w-[150px]" />
    </div>

    <!-- Outstanding + Proposed side by side on wide screens, stacked on narrow -->
    <div class="grid grid-cols-1 2xl:grid-cols-2 gap-5">
      <UiCard :title="`Outstanding (${outstanding.length})`" subtitle="Live grants on the cap table" :padded="false">
        <div v-if="!outstanding.length" class="text-sm text-ink-500 px-4 py-6 text-center">No outstanding grants.</div>
        <div v-else class="overflow-x-auto">
          <table class="text-sm border-separate w-full" style="border-spacing: 0; table-layout: fixed;">
            <colgroup>
              <col v-for="c in outstandingTable.cols" :key="c.key" :style="{ width: c.width + 'px' }" />
            </colgroup>
            <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide bg-ink-100">
              <tr>
                <th
                  v-for="c in outstandingTable.cols"
                  :key="c.key"
                  class="relative px-3 py-2 border-b border-ink-300 select-none font-semibold"
                  :class="[c.align === 'right' ? 'text-right' : 'text-left', c.sortable ? 'cursor-pointer hover:text-ink-900' : '']"
                  @click="c.sortable ? outstandingTable.toggleSort(c.key) : null"
                >
                  <span class="inline-flex items-center gap-1" :class="c.align === 'right' ? 'flex-row-reverse' : ''">
                    {{ c.label }}
                    <ChevronUp v-if="sortIconFor(outstandingTable, c.key) === 'asc'" :size="12" class="text-accent-600" />
                    <ChevronDown v-if="sortIconFor(outstandingTable, c.key) === 'desc'" :size="12" class="text-accent-600" />
                  </span>
                  <span class="resize-handle" @mousedown.prevent.stop="outstandingTable.startResize($event, c.key)" @click.stop />
                </th>
              </tr>
            </thead>
            <tbody class="num">
              <tr v-for="g in sortedOutstanding" :key="g.id" class="hover:bg-accent-50/40 transition-colors">
                <td class="px-3 py-2 font-medium text-ink-900 border-b border-ink-200 truncate" :title="g.recipient_name">
                  {{ g.recipient_name }}
                  <span v-if="!g.linked_stakeholder" class="ml-1 text-[10px] uppercase tracking-wide text-amber-700">unlinked</span>
                </td>
                <td class="px-3 py-2 text-ink-700 border-b border-ink-200">{{ g.recipient_type || '—' }}</td>
                <td class="px-3 py-2 text-ink-700 border-b border-ink-200 truncate">{{ g.round || '—' }}</td>
                <td class="px-3 py-2 text-right border-b border-ink-200">{{ fmtShare(g.quantity, poolAuthorized, g.strike || 0) }}</td>
                <td class="px-3 py-2 text-right text-ink-700 border-b border-ink-200">{{ fmtPricePerShare(g.strike) }}</td>
                <td class="px-3 py-2 text-ink-600 border-b border-ink-200">{{ fmtDate(g.issue_date) }}</td>
                <td class="px-3 py-2 text-right text-ink-600 border-b border-ink-200">{{ g.vest_months ? `${g.vest_months}m / ${g.cliff_months}m` : '—' }}</td>
                <td class="px-3 py-2 text-right border-b border-ink-200 whitespace-nowrap">
                  <button class="text-ink-500 hover:text-accent-600 px-1.5 py-1 rounded" @click="startEdit(g)" title="Edit"><Edit3 :size="14" /></button>
                  <button class="text-ink-500 hover:text-amber-600 px-1.5 py-1 rounded" @click="cancel(g)" title="Cancel"><Trash2 :size="14" /></button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>

      <UiCard :title="`Proposed (${proposed.length})`" subtitle="Draft grants — promote to make them live" :padded="false">
        <div v-if="!proposed.length" class="text-sm text-ink-500 px-4 py-6 text-center">No proposed grants. Click "Propose grant" to draft one.</div>
        <div v-else class="overflow-x-auto">
          <table class="text-sm border-separate w-full" style="border-spacing: 0; table-layout: fixed;">
            <colgroup>
              <col v-for="c in proposedTable.cols" :key="c.key" :style="{ width: c.width + 'px' }" />
            </colgroup>
            <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide bg-ink-100">
              <tr>
                <th
                  v-for="c in proposedTable.cols"
                  :key="c.key"
                  class="relative px-3 py-2 border-b border-ink-300 select-none font-semibold"
                  :class="[c.align === 'right' ? 'text-right' : 'text-left', c.sortable ? 'cursor-pointer hover:text-ink-900' : '']"
                  @click="c.sortable ? proposedTable.toggleSort(c.key) : null"
                >
                  <span class="inline-flex items-center gap-1" :class="c.align === 'right' ? 'flex-row-reverse' : ''">
                    {{ c.label }}
                    <ChevronUp v-if="sortIconFor(proposedTable, c.key) === 'asc'" :size="12" class="text-accent-600" />
                    <ChevronDown v-if="sortIconFor(proposedTable, c.key) === 'desc'" :size="12" class="text-accent-600" />
                  </span>
                  <span class="resize-handle" @mousedown.prevent.stop="proposedTable.startResize($event, c.key)" @click.stop />
                </th>
              </tr>
            </thead>
            <tbody class="num">
              <tr v-for="g in sortedProposed" :key="g.id" class="hover:bg-accent-50/40 transition-colors">
                <td class="px-3 py-2 font-medium text-ink-900 border-b border-ink-200 truncate" :title="g.recipient_name">{{ g.recipient_name }}</td>
                <td class="px-3 py-2 text-ink-700 border-b border-ink-200">{{ g.recipient_type || '—' }}</td>
                <td class="px-3 py-2 text-right border-b border-ink-200">{{ fmtShare(g.quantity, poolAvailable, g.strike || 0) }}</td>
                <td class="px-3 py-2 text-right text-ink-600 border-b border-ink-200">{{ fmtPct(g.poolPct, 1) }}</td>
                <td class="px-3 py-2 text-right border-b border-ink-200 whitespace-nowrap space-x-1">
                  <UiButton size="sm" @click="startEdit(g)"><Edit3 :size="12" /> Edit</UiButton>
                  <UiButton size="sm" variant="primary" @click="promote(g)">Promote</UiButton>
                  <UiButton size="sm" variant="ghost" @click="destroy(g)"><Trash2 :size="12" /></UiButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>
    </div>

    <!-- Modal -->
    <div v-if="showCreate" class="fixed inset-0 z-40 bg-ink-900/40 backdrop-blur-sm grid place-items-center p-4" @click.self="showCreate = false">
      <div class="w-full max-w-lg rounded-lg border border-ink-300 bg-white p-5 shadow-card-hover">
        <h2 class="text-base font-semibold text-ink-900">{{ editing ? 'Edit grant' : 'Propose grant' }}</h2>
        <div class="mt-4 grid grid-cols-2 gap-3">
          <UiInput v-model="form.recipient_name" label="Recipient" placeholder="Marwan Berrada" class="col-span-2" />
          <label class="block col-span-1">
            <span class="block text-xs font-medium text-ink-700 mb-1">Type</span>
            <select v-model="form.recipient_type" class="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500">
              <option>Employee</option>
              <option>Board Member</option>
              <option>Consultant</option>
              <option>SAB</option>
              <option>Advisor</option>
            </select>
          </label>
          <UiInput v-model="form.round" label="Round / batch" placeholder="Post-A4 / Pre-B" />
          <UiInput v-model="form.quantity" type="number" label="Quantity (shares)" step="100" />
          <UiInput v-model="form.strike" type="number" label="Strike (PPS)" prefix="$" step="0.01" />
          <UiInput v-model="form.issue_date" type="date" label="Issue date" />
          <UiInput v-model="form.vesting_start" type="date" label="Vest start" />
          <UiInput v-model="form.vest_months" type="number" label="Vest months" />
          <UiInput v-model="form.cliff_months" type="number" label="Cliff months" />
          <label class="block col-span-2">
            <span class="block text-xs font-medium text-ink-700 mb-1">Status</span>
            <select v-model="form.status" class="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500">
              <option value="proposed">Proposed (draft)</option>
              <option value="outstanding">Outstanding (live)</option>
            </select>
          </label>
          <label class="block col-span-2">
            <span class="block text-xs font-medium text-ink-700 mb-1">Notes</span>
            <textarea v-model="form.notes" rows="2" class="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500" />
          </label>
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <UiButton variant="ghost" @click="showCreate = false">Cancel</UiButton>
          <UiButton variant="primary" :disabled="!form.recipient_name.trim() || form.quantity <= 0 || saving" @click="save">
            <Award :size="14" /> {{ saving ? 'Saving…' : 'Save grant' }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
