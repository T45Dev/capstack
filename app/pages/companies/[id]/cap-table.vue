<script setup lang="ts">
import { Upload } from 'lucide-vue-next'
import type { TabKey } from '~/components/FinancingsPageHeader.vue'

const route = useRoute()
const router = useRouter()
const id = computed(() => route.params.id as string)

interface ShareClassRow { id: string; code: string; name: string; kind: string; authorized: number | null; issue_price: number | null }
interface Stakeholder { id: string; name: string; type: string | null }
interface Holding { stakeholder_id: string; share_class_id: string; shares: number }
interface Grant { id: string; stakeholder_id: string | null; recipient_name: string; quantity: number; status: string }

const { data } = await useFetch<{ share_classes: ShareClassRow[]; stakeholders: Stakeholder[]; holdings: Holding[]; grants: Grant[]; pools: any[]; current_pps: number }>(() => `/api/companies/${id.value}/cap-table`, { watch: [id], default: () => ({ share_classes: [], stakeholders: [], holdings: [], grants: [], pools: [], current_pps: 0 } as any) })

// Round summary still drives the open-round card and the Investors tab.
// The CN reconciliation banner was dropped from this page.
interface RoundColumn {
  round_id: string
  code: string
  name: string | null
  kind: 'formation' | 'closed' | 'open'
  close_date: string | null
}
const { data: roundSummary, refresh: refreshRoundSummary } = await useFetch<{ rounds: RoundColumn[] }>(() => `/api/companies/${id.value}/round-summary`, {
  watch: [id],
  default: () => ({ rounds: [] }),
})
const roundCols = computed<RoundColumn[]>(() => roundSummary.value?.rounds || [])

// Saving-indicator state. Both cards bubble their in-flight save count
// up; the page header sums them into one "Saving…" / "Saved Xs ago" pill.
const prevSaving = ref(0)
const openSaving = ref(0)
const savingCount = computed(() => prevSaving.value + openSaving.value)

const lastSavedAt = ref<number | null>(null)
const nowTick = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { nowTimer = setInterval(() => { nowTick.value = Date.now() }, 30_000) })
onBeforeUnmount(() => { if (nowTimer) clearInterval(nowTimer) })

watch(savingCount, (n, prev) => {
  if (prev > 0 && n === 0) lastSavedAt.value = Date.now()
})

const lastSavedAgo = computed<string | null>(() => {
  if (lastSavedAt.value == null) return null
  const ms = nowTick.value - lastSavedAt.value
  if (ms < 5_000) return 'just now'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
})

const openRoundName = computed<string | null>(() => {
  const open = roundCols.value.find(r => r.kind === 'open')
  return open ? (open.name || open.code) : null
})

// Active sub-tab — only 'financings' and 'investors' now; the
// 'notes' tab was removed when CNs became user-managed off-page.
const activeTab = computed<TabKey>({
  get: () => {
    const t = route.query.tab
    if (t === 'investors') return 'investors'
    return 'financings'
  },
  set: (v) => {
    void router.replace({ query: { ...route.query, tab: v === 'financings' ? undefined : v } })
  },
})

function addRound() {
  // Re-fire round-summary so the open-round card picks up a freshly
  // created row from its internal createOpenRound() call.
  refreshRoundSummary()
}
function exportCsv() { /* No-op on the simplified layout. Kept on the page header so the button doesn't disappear; we can wire it to a JSON dump of the two cards if it becomes useful. */ }
</script>

<template>
  <div v-if="data">
    <FinancingsPageHeader
      :open-round-name="openRoundName"
      :saving-count="savingCount"
      :last-saved-ago="lastSavedAgo"
      :company-id="id"
      :active-tab="activeTab"
      @add-round="addRound"
      @export="exportCsv"
      @update:active-tab="(v) => activeTab = v"
    />

    <UiEmpty
      v-if="!data.stakeholders.length && !roundCols.length"
      title="No cap table yet"
      description="Drop a Carta export to load option grants and stakeholders, or scroll down and start typing your Previous-Round aggregate."
    >
      <NuxtLink :to="`/companies/${id}/import`"><UiButton variant="primary"><Upload :size="14" /> Import Carta export</UiButton></NuxtLink>
    </UiEmpty>

    <!-- Rounds tab: Previous-Round aggregate + Open-Round modeled card,
         side-by-side on wide screens, stacked on narrow. -->
    <div v-show="activeTab === 'financings'" class="grid lg:grid-cols-2 gap-4">
      <PreviousRoundCard :company-id="id" @update:saving-count="(n: number) => prevSaving = n" />
      <OpenRoundCard :company-id="id" @update:saving-count="(n: number) => openSaving = n" @refreshed="refreshRoundSummary" />
    </div>
    <!-- Round history (FDS timeline): dated FDS/price/pool per historical
         round. Latest row sets the Previous-Round base. -->
    <div v-show="activeTab === 'financings'" class="mt-4">
      <FdsTimelineCard :company-id="id" />
    </div>

    <!-- Preferred investors tab unchanged. -->
    <div v-show="activeTab === 'investors'">
      <div v-if="!roundCols.length" class="px-4 py-10 text-center text-sm text-ink-500 border border-dashed border-ink-300 rounded-lg bg-white">
        Start an open round first — the investor matrix needs a column to populate.
      </div>
      <InvestorMatrix v-else :company-id="id" @refreshed="refreshRoundSummary" />
    </div>
  </div>
</template>
