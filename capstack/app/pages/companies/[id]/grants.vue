<script setup lang="ts">
import { Plus, Trash2, Edit3, Award } from 'lucide-vue-next'
import { fmtShares, fmtUSD, fmtPct, fmtDate, fmtPricePerShare } from '~/utils/format'

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
const { data: compute } = await useFetch(() => `/api/companies/${id.value}/compute`, { method: 'POST', watch: [id], default: () => null })

const outstanding = computed(() => data.value!.grants.filter(g => g.status === 'outstanding'))
const proposed = computed(() => data.value!.grants.filter(g => g.status === 'proposed'))
const cancelled = computed(() => data.value!.grants.filter(g => g.status === 'cancelled'))

const totalOutstanding = computed(() => outstanding.value.reduce((a, g) => a + g.quantity, 0))
const totalProposed = computed(() => proposed.value.reduce((a, g) => a + g.quantity, 0))
const poolAuthorized = computed(() => data.value!.pools.reduce((a, p) => a + p.authorized, 0))
const poolAvailable = computed(() => Math.max(0, poolAuthorized.value - totalOutstanding.value - totalProposed.value))

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
    <div class="flex items-end justify-between mb-4 gap-3">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight text-ink-100">Option grants</h1>
        <p class="text-sm text-ink-400 mt-1">Outstanding grants from the cap table, plus any proposed grants you're modeling.</p>
      </div>
      <UiButton variant="primary" @click="reset(); showCreate = true"><Plus :size="14" /> Propose grant</UiButton>
    </div>

    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
      <UiStat label="Pool authorized" :value="fmtShares(poolAuthorized)" />
      <UiStat label="Outstanding" :value="fmtShares(totalOutstanding)" />
      <UiStat label="Proposed" :value="fmtShares(totalProposed)" />
      <UiStat label="Available" :value="fmtShares(poolAvailable)" emphasis />
    </div>

    <UiCard padded title="Outstanding" :subtitle="`${outstanding.length} grants`">
      <div v-if="!outstanding.length" class="text-sm text-ink-500 px-1 py-2">No outstanding grants.</div>
      <div v-else class="overflow-x-auto -mx-4">
        <table class="w-full text-sm">
          <thead class="text-left text-ink-400 text-xs uppercase tracking-wide">
            <tr class="border-b border-ink-700">
              <th class="px-4 py-2">Recipient</th>
              <th class="px-3 py-2">Type</th>
              <th class="px-3 py-2">Round</th>
              <th class="px-3 py-2 text-right">Quantity</th>
              <th class="px-3 py-2 text-right">Strike</th>
              <th class="px-3 py-2">Issued</th>
              <th class="px-3 py-2 text-right">Vest</th>
              <th class="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody class="num">
            <tr v-for="g in outstanding" :key="g.id" class="border-b border-ink-800/80">
              <td class="px-4 py-2 font-medium text-ink-100">
                {{ g.recipient_name }}
                <span v-if="!g.linked_stakeholder" class="ml-1 text-[10px] uppercase tracking-wide text-amber-400">unlinked</span>
              </td>
              <td class="px-3 py-2 text-ink-300">{{ g.recipient_type || '—' }}</td>
              <td class="px-3 py-2 text-ink-300">{{ g.round || '—' }}</td>
              <td class="px-3 py-2 text-right">{{ fmtShares(g.quantity) }}</td>
              <td class="px-3 py-2 text-right text-ink-300">{{ fmtPricePerShare(g.strike) }}</td>
              <td class="px-3 py-2 text-ink-400">{{ fmtDate(g.issue_date) }}</td>
              <td class="px-3 py-2 text-right text-ink-400">{{ g.vest_months ? `${g.vest_months}m / ${g.cliff_months}m cliff` : '—' }}</td>
              <td class="px-3 py-2 text-right">
                <button class="text-ink-500 hover:text-ink-100 px-1.5 py-1 rounded" @click="startEdit(g)"><Edit3 :size="14" /></button>
                <button class="text-ink-500 hover:text-amber-400 px-1.5 py-1 rounded" @click="cancel(g)"><Trash2 :size="14" /></button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <UiCard v-if="proposed.length" padded class="mt-4" title="Proposed" :subtitle="`${proposed.length} draft grants`">
      <div class="overflow-x-auto -mx-4">
        <table class="w-full text-sm">
          <thead class="text-left text-ink-400 text-xs uppercase tracking-wide">
            <tr class="border-b border-ink-700">
              <th class="px-4 py-2">Recipient</th>
              <th class="px-3 py-2">Type</th>
              <th class="px-3 py-2 text-right">Quantity</th>
              <th class="px-3 py-2 text-right">% of pool available</th>
              <th class="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody class="num">
            <tr v-for="g in proposed" :key="g.id" class="border-b border-ink-800/80">
              <td class="px-4 py-2 font-medium text-ink-100">{{ g.recipient_name }}</td>
              <td class="px-3 py-2 text-ink-300">{{ g.recipient_type || '—' }}</td>
              <td class="px-3 py-2 text-right">{{ fmtShares(g.quantity) }}</td>
              <td class="px-3 py-2 text-right text-ink-400">{{ poolAvailable ? fmtPct(g.quantity / poolAvailable, 1) : '—' }}</td>
              <td class="px-3 py-2 text-right space-x-1">
                <UiButton size="sm" @click="startEdit(g)"><Edit3 :size="12" /> Edit</UiButton>
                <UiButton size="sm" variant="primary" @click="promote(g)">Promote</UiButton>
                <UiButton size="sm" variant="ghost" @click="destroy(g)"><Trash2 :size="12" /></UiButton>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <!-- Modal -->
    <div v-if="showCreate" class="fixed inset-0 z-40 bg-ink-900/80 backdrop-blur-sm grid place-items-center p-4" @click.self="showCreate = false">
      <div class="w-full max-w-lg rounded-lg border border-ink-700 bg-ink-800 p-5">
        <h2 class="text-base font-semibold text-ink-100">{{ editing ? 'Edit grant' : 'Propose grant' }}</h2>
        <div class="mt-4 grid grid-cols-2 gap-3">
          <UiInput v-model="form.recipient_name" label="Recipient" placeholder="Marwan Berrada" class="col-span-2" />
          <label class="block col-span-1">
            <span class="block text-xs font-medium text-ink-300 mb-1">Type</span>
            <select v-model="form.recipient_type" class="w-full rounded-md border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-ink-100">
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
            <span class="block text-xs font-medium text-ink-300 mb-1">Status</span>
            <select v-model="form.status" class="w-full rounded-md border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-ink-100">
              <option value="proposed">Proposed (draft)</option>
              <option value="outstanding">Outstanding (live)</option>
            </select>
          </label>
          <label class="block col-span-2">
            <span class="block text-xs font-medium text-ink-300 mb-1">Notes</span>
            <textarea v-model="form.notes" rows="2" class="w-full rounded-md border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-ink-100" />
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
