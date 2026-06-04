<script setup lang="ts">
import { Plus, Trash2, Save, Settings as SettingsIcon } from 'lucide-vue-next'

const route = useRoute()
const id = computed(() => route.params.id as string)

// ---- Tabs --------------------------------------------------------------
// Scaffolded as an array so more settings sections can be added later.
const tabs = [
  { key: 'grants', label: 'Option Grants' },
  { key: 'pool', label: 'Option Pool' },
] as const
const activeTab = ref<typeof tabs[number]['key']>('grants')

// ---- Vesting schedules -------------------------------------------------
interface VestingSchedule {
  id: string
  name: string
  vest_months: number
  cliff_months: number
  cadence: 'monthly' | 'quarterly' | 'annual'
}
const { data: schedules, refresh: refreshSchedules } = await useFetch<VestingSchedule[]>(
  () => `/api/companies/${id.value}/vesting-schedules`,
  { watch: [id], default: () => [] },
)

const newSched = reactive({ name: '', vest_months: 48, cliff_months: 12, cadence: 'monthly' as const })
const addingSched = ref(false)
async function addSchedule() {
  if (!newSched.name.trim() || addingSched.value) return
  addingSched.value = true
  try {
    await $fetch(`/api/companies/${id.value}/vesting-schedules`, { method: 'POST', body: { ...newSched } })
    newSched.name = ''; newSched.vest_months = 48; newSched.cliff_months = 12; newSched.cadence = 'monthly'
    await refreshSchedules()
  } finally {
    addingSched.value = false
  }
}
async function patchSchedule(s: VestingSchedule, patch: Partial<VestingSchedule>) {
  await $fetch(`/api/vesting-schedules/${s.id}`, { method: 'PATCH', body: patch })
  await refreshSchedules()
}
async function deleteSchedule(s: VestingSchedule) {
  if (!confirm(`Delete vesting schedule "${s.name}"? Grants using it keep their current month values.`)) return
  await $fetch(`/api/vesting-schedules/${s.id}`, { method: 'DELETE' })
  await refreshSchedules()
}
function cadenceLabel(c: string) {
  return c === 'monthly' ? 'Monthly' : c === 'quarterly' ? 'Quarterly' : 'Annual'
}

// ---- Import template field mapping ------------------------------------
interface CanonicalField { field: string; label: string; defaultHeader: string; mapsTo: string }
const { data: grantSettings, refresh: refreshGrantSettings } = await useFetch<{ fields: CanonicalField[]; mappings: Record<string, string> }>(
  () => `/api/companies/${id.value}/grant-settings`,
  { watch: [id], default: () => ({ fields: [], mappings: {} }) },
)
// Local editable copy of the mappings.
const mappingDraft = reactive<Record<string, string>>({})
watchEffect(() => {
  if (grantSettings.value) {
    for (const f of grantSettings.value.fields) {
      mappingDraft[f.field] = grantSettings.value.mappings[f.field] ?? f.defaultHeader
    }
  }
})
const savingMappings = ref(false)
const mappingsSaved = ref(false)
async function saveMappings() {
  if (savingMappings.value) return
  savingMappings.value = true
  mappingsSaved.value = false
  try {
    await $fetch(`/api/companies/${id.value}/grant-settings`, { method: 'POST', body: { mappings: { ...mappingDraft } } })
    await refreshGrantSettings()
    mappingsSaved.value = true
    setTimeout(() => { mappingsSaved.value = false }, 2500)
  } finally {
    savingMappings.value = false
  }
}
function resetMapping(f: CanonicalField) {
  mappingDraft[f.field] = f.defaultHeader
}

// ---- Ideas (Option Pool) import field mapping -------------------------
const { data: ideaSettings, refresh: refreshIdeaSettings } = await useFetch<{ fields: CanonicalField[]; mappings: Record<string, string> }>(
  () => `/api/companies/${id.value}/idea-settings`,
  { watch: [id], default: () => ({ fields: [], mappings: {} }) },
)
const ideaMappingDraft = reactive<Record<string, string>>({})
watchEffect(() => {
  if (ideaSettings.value) {
    for (const f of ideaSettings.value.fields) {
      ideaMappingDraft[f.field] = ideaSettings.value.mappings[f.field] ?? f.defaultHeader
    }
  }
})
const savingIdeaMappings = ref(false)
const ideaMappingsSaved = ref(false)
async function saveIdeaMappings() {
  if (savingIdeaMappings.value) return
  savingIdeaMappings.value = true
  ideaMappingsSaved.value = false
  try {
    await $fetch(`/api/companies/${id.value}/idea-settings`, { method: 'POST', body: { mappings: { ...ideaMappingDraft } } })
    await refreshIdeaSettings()
    ideaMappingsSaved.value = true
    setTimeout(() => { ideaMappingsSaved.value = false }, 2500)
  } finally {
    savingIdeaMappings.value = false
  }
}
function resetIdeaMapping(f: CanonicalField) {
  ideaMappingDraft[f.field] = f.defaultHeader
}
</script>

<template>
  <div>
    <div class="flex items-end justify-between mb-5 gap-3 flex-wrap">
      <div>
        <h1 class="text-xl font-semibold tracking-tight text-ink-900 flex items-center gap-2">
          <SettingsIcon :size="20" class="text-ink-500" /> Settings
        </h1>
        <p class="text-sm text-ink-600 mt-1">Per-company configuration.</p>
      </div>
    </div>

    <!-- Tab bar -->
    <div class="flex items-center gap-1 border-b border-ink-200 mb-6">
      <button
        v-for="t in tabs"
        :key="t.key"
        type="button"
        class="px-3.5 py-2 text-sm font-medium -mb-px border-b-2 transition-colors"
        :class="activeTab === t.key
          ? 'border-brand-500 text-ink-900'
          : 'border-transparent text-ink-500 hover:text-ink-800'"
        @click="activeTab = t.key"
      >{{ t.label }}</button>
    </div>

    <!-- Option Grants tab -->
    <div v-if="activeTab === 'grants'" class="space-y-6 max-w-4xl">
      <!-- Vesting schedules -->
      <UiCard title="Vesting schedules" subtitle="Named schedules you can apply to grants and reference in imports." :padded="false">
        <div class="overflow-x-auto table-scroll table-sticky-head">
          <table class="w-full text-[13px] border-separate" style="border-spacing: 0;">
            <thead class="text-left text-ink-500 text-[11px] uppercase tracking-wide">
              <tr>
                <th class="px-3 py-2 border-b border-ink-200 font-semibold bg-ink-100">Name</th>
                <th class="px-3 py-2 border-b border-ink-200 font-semibold bg-ink-100 text-right w-32">Total months</th>
                <th class="px-3 py-2 border-b border-ink-200 font-semibold bg-ink-100 text-right w-32">Cliff months</th>
                <th class="px-3 py-2 border-b border-ink-200 font-semibold bg-ink-100 w-36">Cadence</th>
                <th class="px-3 py-2 border-b border-ink-200 font-semibold bg-ink-100 w-12"></th>
              </tr>
            </thead>
            <tbody class="num">
              <tr v-if="!schedules.length">
                <td colspan="5" class="px-3 py-6 text-center text-sm text-ink-500">No vesting schedules yet. Add one below.</td>
              </tr>
              <tr v-for="s in schedules" :key="s.id" class="group hover:bg-ink-50/40">
                <td class="px-3 py-1.5 border-b border-ink-100">
                  <input
                    :value="s.name"
                    class="w-full bg-transparent rounded px-1.5 py-1 hover:bg-white focus:bg-white border border-transparent focus:border-brand-300 focus:outline-none"
                    @change="(e: any) => patchSchedule(s, { name: e.target.value })"
                  />
                </td>
                <td class="px-3 py-1.5 border-b border-ink-100 text-right">
                  <input
                    type="number" min="0" :value="s.vest_months"
                    class="w-24 bg-transparent rounded px-1.5 py-1 text-right hover:bg-white focus:bg-white border border-transparent focus:border-brand-300 focus:outline-none num"
                    @change="(e: any) => patchSchedule(s, { vest_months: Number(e.target.value) })"
                  />
                </td>
                <td class="px-3 py-1.5 border-b border-ink-100 text-right">
                  <input
                    type="number" min="0" :value="s.cliff_months"
                    class="w-24 bg-transparent rounded px-1.5 py-1 text-right hover:bg-white focus:bg-white border border-transparent focus:border-brand-300 focus:outline-none num"
                    @change="(e: any) => patchSchedule(s, { cliff_months: Number(e.target.value) })"
                  />
                </td>
                <td class="px-3 py-1.5 border-b border-ink-100">
                  <select
                    :value="s.cadence"
                    class="w-full bg-transparent rounded px-1.5 py-1 hover:bg-white focus:bg-white border border-transparent focus:border-brand-300 focus:outline-none"
                    @change="(e: any) => patchSchedule(s, { cadence: e.target.value })"
                  >
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="annual">Annual</option>
                  </select>
                </td>
                <td class="px-3 py-1.5 border-b border-ink-100 text-right">
                  <button class="text-ink-400 hover:text-red-600 p-1 rounded" title="Delete" @click="deleteSchedule(s)"><Trash2 :size="14" /></button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- Add row -->
        <div class="flex items-end gap-3 p-3 border-t border-ink-200 bg-ink-50/40 flex-wrap">
          <UiInput v-model="newSched.name" label="Name" placeholder="4yr / 1yr cliff" class="flex-1 min-w-[180px]" />
          <UiInput v-model="newSched.vest_months" type="number" label="Total months" class="w-28" />
          <UiInput v-model="newSched.cliff_months" type="number" label="Cliff months" class="w-28" />
          <label class="block w-36">
            <span class="block text-xs font-medium text-ink-700 mb-1">Cadence</span>
            <select v-model="newSched.cadence" class="w-full rounded-md border border-ink-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500">
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="annual">Annual</option>
            </select>
          </label>
          <UiButton variant="primary" :disabled="!newSched.name.trim() || addingSched" @click="addSchedule">
            <Plus :size="14" /> Add schedule
          </UiButton>
        </div>
      </UiCard>

      <!-- Import template field mapping -->
      <UiCard title="Import template fields" subtitle="The column headers CapStack looks for when importing proposed grants, and the grant field each maps to.">
        <template #header>
          <span v-if="mappingsSaved" class="text-xs text-emerald-700 font-medium">Saved ✓</span>
          <UiButton variant="primary" :disabled="savingMappings" @click="saveMappings">
            <Save :size="14" /> {{ savingMappings ? 'Saving…' : 'Save mapping' }}
          </UiButton>
        </template>
        <p class="text-[12px] text-ink-500 mb-3">
          Set the header text expected in uploaded spreadsheets. Imports match these first, then fall back to smart auto-detection of common synonyms.
        </p>
        <div class="space-y-2">
          <div
            v-for="f in grantSettings.fields"
            :key="f.field"
            class="grid grid-cols-[1fr_auto_1.4fr] items-center gap-3 py-1.5 border-b border-ink-100 last:border-0"
          >
            <div>
              <div class="text-sm font-medium text-ink-800">{{ f.label }}</div>
              <div class="text-[11px] text-ink-400 num">→ grants.{{ f.mapsTo }}</div>
            </div>
            <span class="text-ink-300 text-xs">header</span>
            <div class="flex items-center gap-2">
              <input
                v-model="mappingDraft[f.field]"
                type="text"
                class="w-full rounded-md border border-ink-300 bg-white px-2.5 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                :placeholder="f.defaultHeader"
              />
              <button
                v-if="mappingDraft[f.field] !== f.defaultHeader"
                class="text-[11px] text-ink-500 hover:text-brand-600 whitespace-nowrap"
                title="Reset to default"
                @click="resetMapping(f)"
              >reset</button>
            </div>
          </div>
        </div>
      </UiCard>
    </div>

    <!-- Option Pool tab -->
    <div v-else-if="activeTab === 'pool'" class="space-y-6 max-w-4xl">
      <UiCard title="Ideas import template fields" subtitle="Column headers CapStack looks for when importing option-grant Ideas, and the pool-event field each maps to.">
        <template #header>
          <span v-if="ideaMappingsSaved" class="text-xs text-emerald-700 font-medium">Saved ✓</span>
          <UiButton variant="primary" :disabled="savingIdeaMappings" @click="saveIdeaMappings">
            <Save :size="14" /> {{ savingIdeaMappings ? 'Saving…' : 'Save mapping' }}
          </UiButton>
        </template>
        <p class="text-[12px] text-ink-500 mb-3">
          The Ideas importer only adds <b>Future grant</b> ideas (other event types — top-ups, exercises, forfeits, floors, reserves — stay on the Add idea modal). Imports match these headers first, then fall back to smart auto-detection.
        </p>
        <div class="space-y-2">
          <div
            v-for="f in ideaSettings.fields"
            :key="f.field"
            class="grid grid-cols-[1fr_auto_1.4fr] items-center gap-3 py-1.5 border-b border-ink-100 last:border-0"
          >
            <div>
              <div class="text-sm font-medium text-ink-800">{{ f.label }}</div>
              <div class="text-[11px] text-ink-400 num">→ pool_events.{{ f.mapsTo }}</div>
            </div>
            <span class="text-ink-300 text-xs">header</span>
            <div class="flex items-center gap-2">
              <input
                v-model="ideaMappingDraft[f.field]"
                type="text"
                class="w-full rounded-md border border-ink-300 bg-white px-2.5 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                :placeholder="f.defaultHeader"
              />
              <button
                v-if="ideaMappingDraft[f.field] !== f.defaultHeader"
                class="text-[11px] text-ink-500 hover:text-brand-600 whitespace-nowrap"
                title="Reset to default"
                @click="resetIdeaMapping(f)"
              >reset</button>
            </div>
          </div>
        </div>
      </UiCard>
    </div>
  </div>
</template>
