<script setup lang="ts">
import { Plus, FlaskConical, Copy, Trash2, Play } from 'lucide-vue-next'
import { fmtUSD, fmtPct, fmtShares, fmtPricePerShare } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

interface Scenario {
  id: string
  name: string
  description: string | null
  round_name: string
  new_money: number
  pre_money: number
  pool_top_up_shares: number
  exit_values: string | null
  created_at: string
}

const { data: scenarios, refresh } = await useFetch<Scenario[]>(() => `/api/companies/${id.value}/scenarios`, { watch: [id], default: () => [] })
const { data: assumptions } = await useFetch(() => `/api/companies/${id.value}/assumptions`, { watch: [id] })

const showCreate = ref(false)
const form = reactive({
  name: '',
  description: '',
  new_money: 0,
  pre_money: 0,
  pool_top_up_shares: 0,
  exit_low: 100_000_000,
  exit_mid: 250_000_000,
  exit_high: 500_000_000,
})

function startCreate(cloneFrom?: Scenario) {
  if (cloneFrom) {
    form.name = `${cloneFrom.name} (copy)`
    form.description = cloneFrom.description || ''
    form.new_money = cloneFrom.new_money
    form.pre_money = cloneFrom.pre_money
    form.pool_top_up_shares = cloneFrom.pool_top_up_shares
    const ev = (() => { try { return cloneFrom.exit_values ? JSON.parse(cloneFrom.exit_values) : null } catch { return null } })()
    if (Array.isArray(ev) && ev.length >= 3) {
      form.exit_low = ev[0]
      form.exit_mid = ev[1]
      form.exit_high = ev[2]
    }
  } else {
    form.name = `Scenario ${(scenarios.value?.length || 0) + 1}`
    form.description = ''
    form.new_money = (assumptions.value as any)?.new_money || 0
    form.pre_money = (assumptions.value as any)?.pre_money || 0
    form.pool_top_up_shares = (assumptions.value as any)?.pool_top_up_shares || 0
    form.exit_low = 100_000_000
    form.exit_mid = 250_000_000
    form.exit_high = 500_000_000
  }
  showCreate.value = true
}

const saving = ref(false)
async function create() {
  if (!form.name.trim() || saving.value) return
  saving.value = true
  try {
    const s = await $fetch<Scenario>(`/api/companies/${id.value}/scenarios`, {
      method: 'POST',
      body: {
        name: form.name,
        description: form.description,
        new_money: form.new_money,
        pre_money: form.pre_money,
        pool_top_up_shares: form.pool_top_up_shares,
        exit_values: [form.exit_low, form.exit_mid, form.exit_high],
      },
    })
    showCreate.value = false
    await refresh()
    selected.value = s.id
  } finally {
    saving.value = false
  }
}

async function destroy(s: Scenario) {
  if (!confirm(`Delete scenario "${s.name}"?`)) return
  await $fetch(`/api/scenarios/${s.id}`, { method: 'DELETE' })
  if (selected.value === s.id) selected.value = null
  await refresh()
}

const selected = ref<string | null>(null)
watch(scenarios, (arr) => {
  if (!selected.value && arr?.length) selected.value = arr[0].id
}, { immediate: true })

const { data: result, refresh: refreshResult } = await useFetch(() => selected.value ? `/api/scenarios/${selected.value}/compute` : null, {
  method: 'POST',
  watch: [selected],
  default: () => null,
})
</script>

<template>
  <div>
    <div class="flex items-end justify-between mb-4 gap-3">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight text-ink-100">Scenarios</h1>
        <p class="text-sm text-ink-400 mt-1">Clone the current cap table state and vary raise / pre-money / pool. Compare exit payouts.</p>
      </div>
      <UiButton variant="primary" @click="startCreate()"><Plus :size="14" /> New scenario</UiButton>
    </div>

    <UiEmpty
      v-if="!scenarios?.length"
      title="No scenarios yet"
      description="Scenarios are immutable what-ifs: change the raise, pre-money, or pool top-up and see how it changes dilution and exit payouts."
    >
      <UiButton variant="primary" @click="startCreate()"><Plus :size="14" /> Create scenario</UiButton>
    </UiEmpty>

    <div v-else class="grid grid-cols-12 gap-4">
      <aside class="col-span-12 md:col-span-3 space-y-2">
        <button
          v-for="s in scenarios"
          :key="s.id"
          class="group w-full text-left rounded-md border p-3 transition-colors"
          :class="selected === s.id ? 'border-accent-500 bg-accent-900/20' : 'border-ink-700 bg-ink-800/40 hover:bg-ink-800/70'"
          @click="selected = s.id"
        >
          <div class="flex items-center justify-between">
            <span class="font-medium text-ink-100 text-sm">{{ s.name }}</span>
            <span class="text-[10px] uppercase tracking-wide text-ink-500">{{ s.round_name }}</span>
          </div>
          <div class="mt-1 grid grid-cols-2 gap-1 text-[11px] text-ink-400 num">
            <span>Raise {{ fmtUSD(s.new_money) }}</span>
            <span>Pre {{ fmtUSD(s.pre_money) }}</span>
          </div>
          <div class="mt-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <button class="text-[11px] text-ink-400 hover:text-ink-100 inline-flex items-center gap-1" @click.stop="startCreate(s)"><Copy :size="11" /> clone</button>
            <button class="text-[11px] text-ink-400 hover:text-red-400 inline-flex items-center gap-1" @click.stop="destroy(s)"><Trash2 :size="11" /> delete</button>
          </div>
        </button>
      </aside>

      <section class="col-span-12 md:col-span-9 space-y-4">
        <div v-if="!result" class="rounded-md border border-ink-700 bg-ink-800/40 p-6 text-sm text-ink-400">Select a scenario to view results.</div>
        <template v-else>
          <UiCard :title="result.scenario.name" :subtitle="result.scenario.description || result.scenario.round_name">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
              <UiStat label="Pre-money" :value="fmtUSD(result.round.preMoney)" />
              <UiStat label="New money" :value="fmtUSD(result.round.newMoney)" />
              <UiStat label="Post-money" :value="fmtUSD(result.round.postMoney)" emphasis />
              <UiStat label="Price per share" :value="fmtPricePerShare(result.round.pricePerShare)" emphasis />
              <UiStat label="Pre-round FDS" :value="fmtShares(result.round.preRoundFDS)" />
              <UiStat label="Pool top-up" :value="fmtShares(result.round.newPoolShares)" />
              <UiStat label="New preferred" :value="fmtShares(result.round.newPreferredShares)" />
              <UiStat label="Post-round FDS" :value="fmtShares(result.round.postRoundFDS)" emphasis />
            </div>
          </UiCard>

          <UiCard title="Exit payouts" :subtitle="'Per stakeholder, by exit valuation'">
            <div class="overflow-x-auto -mx-4">
              <table class="w-full text-sm">
                <thead class="text-left text-ink-400 text-xs uppercase tracking-wide">
                  <tr class="border-b border-ink-700">
                    <th class="px-4 py-2">Stakeholder</th>
                    <th class="px-3 py-2 text-right">Post shares</th>
                    <th class="px-3 py-2 text-right">% Post-FDS</th>
                    <th v-for="(ev, i) in result.exitValues" :key="i" class="px-3 py-2 text-right">
                      Exit @ {{ fmtUSD(ev) }}
                    </th>
                  </tr>
                </thead>
                <tbody class="num">
                  <tr v-for="r in result.dilution" :key="r.stakeholderId" class="border-b border-ink-800/80 hover:bg-ink-800/40">
                    <td class="px-4 py-2 font-medium text-ink-100">{{ r.name }}</td>
                    <td class="px-3 py-2 text-right">{{ fmtShares(r.postShares) }}</td>
                    <td class="px-3 py-2 text-right text-ink-400">{{ fmtPct(r.postPct, 2) }}</td>
                    <td v-for="(ev, i) in r.exits" :key="i" class="px-3 py-2 text-right">{{ fmtUSD(ev) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </UiCard>
        </template>
      </section>
    </div>

    <!-- Create modal -->
    <div v-if="showCreate" class="fixed inset-0 z-40 bg-ink-900/80 backdrop-blur-sm grid place-items-center p-4" @click.self="showCreate = false">
      <div class="w-full max-w-lg rounded-lg border border-ink-700 bg-ink-800 p-5">
        <h2 class="text-base font-semibold text-ink-100">New scenario</h2>
        <div class="mt-4 grid grid-cols-2 gap-3">
          <UiInput v-model="form.name" label="Name" placeholder="Bridge + 18.5M B" class="col-span-2" />
          <UiInput v-model="form.description" label="Description" class="col-span-2" />
          <UiInput v-model="form.pre_money" type="number" label="Pre-money" prefix="$" step="100000" />
          <UiInput v-model="form.new_money" type="number" label="New money" prefix="$" step="100000" />
          <UiInput v-model="form.pool_top_up_shares" type="number" label="Pool top-up shares" class="col-span-2" />
          <div class="col-span-2 grid grid-cols-3 gap-2">
            <UiInput v-model="form.exit_low" type="number" label="Exit (low)" prefix="$" step="10000000" />
            <UiInput v-model="form.exit_mid" type="number" label="Exit (mid)" prefix="$" step="10000000" />
            <UiInput v-model="form.exit_high" type="number" label="Exit (high)" prefix="$" step="10000000" />
          </div>
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <UiButton variant="ghost" @click="showCreate = false">Cancel</UiButton>
          <UiButton variant="primary" :disabled="!form.name.trim() || saving" @click="create">
            <FlaskConical :size="14" /> {{ saving ? 'Creating…' : 'Create scenario' }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
