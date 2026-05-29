<script setup lang="ts">
// Shareholders page: every stakeholder rolled up with their preferred /
// common / options share counts. Operator can link two stakeholders so
// the app treats them as one (e.g., "Ingenuity Medical LLC" and "Marwan
// Berrada" merge under whichever the operator picks as primary). Aliases
// render indented under their primary; their counts sum into the
// primary's totals on the same row.
import { Users, Link2, Link2Off, Search, ChevronDown, ChevronRight } from 'lucide-vue-next'
import { fmtShares } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

interface Alias {
  id: string
  name: string
  type: string | null
  preferred_shares: number
  common_shares: number
  options_outstanding: number
  total_shares: number
}
interface Primary {
  id: string
  name: string
  type: string | null
  preferred_shares: number
  common_shares: number
  options_outstanding: number
  total_shares: number
  self: { preferred_shares: number; common_shares: number; options_outstanding: number }
  aliases: Alias[]
}

const { data, refresh } = await useFetch<{ stakeholders: Primary[] }>(
  () => `/api/companies/${id.value}/shareholders`,
  { watch: [id], default: () => ({ stakeholders: [] }) },
)

const query = ref('')
const filtered = computed<Primary[]>(() => {
  const q = query.value.trim().toLowerCase()
  const rows = data.value?.stakeholders || []
  if (!q) return rows
  // Match a primary OR any of its aliases.
  return rows.filter(p => {
    if (p.name.toLowerCase().includes(q)) return true
    return p.aliases.some(a => a.name.toLowerCase().includes(q))
  })
})

const totals = computed(() => {
  const rows = data.value?.stakeholders || []
  const stakeholdersCount = rows.length + rows.reduce((s, p) => s + p.aliases.length, 0)
  const linkedCount = rows.reduce((s, p) => s + p.aliases.length, 0)
  return {
    primaries: rows.length,
    aliases: linkedCount,
    stakeholders: stakeholdersCount,
    preferred:    rows.reduce((s, p) => s + p.preferred_shares, 0),
    common:       rows.reduce((s, p) => s + p.common_shares, 0),
    options:      rows.reduce((s, p) => s + p.options_outstanding, 0),
  }
})

// Expand/collapse the per-primary aliases row(s). Default: collapsed
// when there are aliases (the primary's totals already include them);
// the operator opens a row to break out individual contributions.
const expanded = ref<Record<string, boolean>>({})
function toggleExpand(pid: string) { expanded.value[pid] = !expanded.value[pid] }

// ---- Link picker ----
const pickerOpen = ref(false)
const pickerForId = ref<string | null>(null)
function openPicker(stakeholderId: string) {
  pickerForId.value = stakeholderId
  pickerOpen.value = true
}
async function onPick(target: { id: string }) {
  const src = pickerForId.value
  pickerOpen.value = false
  pickerForId.value = null
  if (!src) return
  try {
    await $fetch(`/api/stakeholders/${src}/link`, {
      method: 'POST',
      body: { linked_to: target.id },
    })
    await refresh()
  } catch (e: any) {
    alert(`Couldn't link: ${e?.data?.message || e?.message || e}`)
  }
}

async function unlinkAlias(aliasId: string) {
  if (!confirm('Unlink this alias? Its shares will appear as a separate stakeholder again.')) return
  try {
    await $fetch(`/api/stakeholders/${aliasId}/link`, {
      method: 'POST',
      body: { linked_to: null },
    })
    await refresh()
  } catch (e: any) {
    alert(`Couldn't unlink: ${e?.data?.message || e?.message || e}`)
  }
}

// Picker candidates: top-level rows only (linking an alias to another
// alias would just flatten via the API, but operators expect "pick a
// primary," not "pick anyone").
const pickerCandidates = computed(() =>
  (data.value?.stakeholders || []).map(p => ({
    id: p.id,
    name: p.name,
    type: p.type,
    total_shares: p.total_shares,
  })),
)
</script>

<template>
  <div>
    <!-- Page header. Same -mx-6 bleed pattern as other per-company pages. -->
    <div class="border-b border-ink-200 bg-white -mx-6 -mt-6 px-6 pt-5 pb-3 mb-5">
      <div class="flex items-center gap-1.5 text-[12px] text-ink-500 mb-2">
        <span>Cap-table model</span>
        <span class="text-ink-300">/</span>
        <span class="text-ink-700 font-medium">Shareholders</span>
      </div>
      <div class="flex items-end justify-between gap-4 flex-wrap">
        <div class="min-w-0">
          <div class="flex items-center gap-3 flex-wrap">
            <h1 class="text-[22px] font-semibold text-ink-900 tracking-tight flex items-center gap-2"><Users :size="20" /> Shareholders</h1>
            <span v-if="totals.aliases > 0" class="text-[11px] px-2 py-0.5 rounded-full bg-brand-soft text-brand-edge font-medium num">
              {{ totals.primaries }} primary · {{ totals.aliases }} aliased
            </span>
          </div>
          <p class="text-[13px] text-ink-500 mt-1 max-w-2xl">
            Every stakeholder — preferred, common, option-holder — rolled up. Link two rows when they represent the same investor (e.g., a holding-company name and a person's name); the alias's shares fold into the primary across every view.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <div class="flex items-center gap-2 bg-white border border-ink-300 rounded-md px-2 py-1.5">
            <Search :size="13" class="text-ink-400 shrink-0" />
            <input
              v-model="query"
              type="text"
              placeholder="Find a stakeholder…"
              class="bg-transparent text-[12.5px] outline-none border-0 w-52 text-left"
            />
          </div>
        </div>
      </div>
    </div>

    <div v-if="!totals.stakeholders" class="px-4 py-12 text-center text-sm text-ink-500 border border-dashed border-ink-300 rounded-lg bg-white">
      No stakeholders yet — import a Carta export or add preferred holders from the Dilution page.
    </div>

    <div v-else class="rounded-xl border border-ink-200 bg-white overflow-hidden shadow-[0_1px_0_rgba(16,24,40,0.04)]">
      <table class="w-full text-[13px] border-separate" :style="{ borderSpacing: 0 }">
        <colgroup>
          <col />
          <col style="width: 130px" />
          <col style="width: 130px" />
          <col style="width: 130px" />
          <col style="width: 130px" />
          <col style="width: 140px" />
        </colgroup>
        <thead class="bg-ink-50/60 text-[10.5px] uppercase tracking-[0.06em] text-ink-500 font-semibold">
          <tr>
            <th class="px-3 py-2 border-b border-ink-200 text-left">Stakeholder</th>
            <th class="px-3 py-2 border-b border-ink-200 text-right">Preferred</th>
            <th class="px-3 py-2 border-b border-ink-200 text-right">Common</th>
            <th class="px-3 py-2 border-b border-ink-200 text-right">Options</th>
            <th class="px-3 py-2 border-b border-ink-200 text-right">Total</th>
            <th class="px-3 py-2 border-b border-ink-200 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="p in filtered" :key="p.id">
            <!-- Primary row. -->
            <tr class="hover:bg-ink-50/40 border-b border-ink-100">
              <td class="px-3 py-2">
                <div class="flex items-center gap-2">
                  <button
                    v-if="p.aliases.length"
                    type="button"
                    class="text-ink-400 hover:text-ink-700 -ml-1"
                    :title="expanded[p.id] ? 'Collapse aliases' : 'Show aliases'"
                    @click="toggleExpand(p.id)"
                  >
                    <ChevronDown v-if="expanded[p.id]" :size="14" />
                    <ChevronRight v-else :size="14" />
                  </button>
                  <span v-else class="w-3.5"></span>
                  <span class="text-ink-900 font-medium">{{ p.name }}</span>
                  <span v-if="p.type" class="text-[10px] uppercase tracking-wide text-ink-500 bg-ink-100 border border-ink-200 px-1.5 py-0.5 rounded">{{ p.type }}</span>
                  <span v-if="p.aliases.length" class="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-brand-edge bg-brand-soft border border-brand-200 px-1.5 py-0.5 rounded">
                    <Link2 :size="10" /> {{ p.aliases.length }} alias{{ p.aliases.length === 1 ? '' : 'es' }}
                  </span>
                </div>
              </td>
              <td class="px-3 py-2 text-right num text-ink-700">{{ fmtShares(p.preferred_shares) }}</td>
              <td class="px-3 py-2 text-right num text-ink-700">{{ fmtShares(p.common_shares) }}</td>
              <td class="px-3 py-2 text-right num text-ink-700">{{ fmtShares(p.options_outstanding) }}</td>
              <td class="px-3 py-2 text-right num font-semibold text-ink-900">{{ fmtShares(p.total_shares) }}</td>
              <td class="px-3 py-2 text-right">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 text-[11.5px] text-ink-600 hover:text-brand-edge px-2 py-1 rounded hover:bg-brand-soft/50"
                  title="Mark this row as an alias of another stakeholder"
                  @click="openPicker(p.id)"
                >
                  <Link2 :size="11" /> Link…
                </button>
              </td>
            </tr>
            <!-- Aliases nested under the primary (visible when expanded).
                 Each shows ITS own self counts, not the rolled-up total. -->
            <template v-if="expanded[p.id]">
              <tr v-for="a in p.aliases" :key="a.id" class="bg-brand-soft/15 border-b border-ink-100">
                <td class="px-3 py-1.5 pl-10">
                  <div class="flex items-center gap-2">
                    <Link2 :size="11" class="text-ink-400" />
                    <span class="text-[12.5px] text-ink-700 italic">{{ a.name }}</span>
                    <span v-if="a.type" class="text-[10px] uppercase tracking-wide text-ink-500">{{ a.type }}</span>
                    <span class="text-[10px] uppercase tracking-wide text-brand-edge">→ {{ p.name }}</span>
                  </div>
                </td>
                <td class="px-3 py-1.5 text-right num text-ink-600 text-[12px]">{{ fmtShares(a.preferred_shares) }}</td>
                <td class="px-3 py-1.5 text-right num text-ink-600 text-[12px]">{{ fmtShares(a.common_shares) }}</td>
                <td class="px-3 py-1.5 text-right num text-ink-600 text-[12px]">{{ fmtShares(a.options_outstanding) }}</td>
                <td class="px-3 py-1.5 text-right num text-ink-600 text-[12px]">{{ fmtShares(a.total_shares) }}</td>
                <td class="px-3 py-1.5 text-right">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 text-[11px] text-ink-500 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50"
                    title="Unlink this alias — it'll reappear as a separate stakeholder"
                    @click="unlinkAlias(a.id)"
                  >
                    <Link2Off :size="11" /> Unlink
                  </button>
                </td>
              </tr>
            </template>
          </template>
        </tbody>
        <tfoot class="bg-ink-50/40 text-[12px] num">
          <tr>
            <td class="px-3 py-2 text-right text-[10.5px] uppercase tracking-[0.06em] text-ink-500 font-semibold pr-6">Total</td>
            <td class="px-3 py-2 text-right text-ink-800">{{ fmtShares(totals.preferred) }}</td>
            <td class="px-3 py-2 text-right text-ink-800">{{ fmtShares(totals.common) }}</td>
            <td class="px-3 py-2 text-right text-ink-800">{{ fmtShares(totals.options) }}</td>
            <td class="px-3 py-2 text-right text-ink-900 font-semibold">{{ fmtShares(totals.preferred + totals.common + totals.options) }}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>

    <StakeholderPickerModal
      :open="pickerOpen"
      :candidates="pickerCandidates"
      :hide-id="pickerForId || undefined"
      title="Pick the primary stakeholder"
      @close="pickerOpen = false; pickerForId = null"
      @pick="onPick"
    />
  </div>
</template>
