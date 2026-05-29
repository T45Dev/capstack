<script setup lang="ts">
// Per-page header for the Financings page.
//
// Layout: breadcrumb / title row (H1 + status pill + auto-saved + saving)
// / description / actions / sub-tabs.
// Pre-baseline picker lives in AppTopBar (serves every per-company page).
import { Plus, Upload, Download, Camera } from 'lucide-vue-next'

export type TabKey = 'financings' | 'investors'

interface Props {
  openRoundName: string | null
  savingCount: number
  lastSavedAgo: string | null
  companyId: string
  activeTab: TabKey
}

defineProps<Props>()

const emit = defineEmits<{
  (e: 'add-round'): void
  (e: 'export'): void
  (e: 'snapshot'): void
  (e: 'update:active-tab', v: TabKey): void
}>()

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: 'financings', label: 'Financings' },
  { key: 'investors',  label: 'Preferred investors' },
]
</script>

<template>
  <div class="border-b border-ink-200 bg-white -mx-6 -mt-6 px-6 pt-5 mb-6">
    <!-- Breadcrumb. -->
    <div class="flex items-center gap-1.5 text-[12px] text-ink-500 mb-2">
      <span>Cap-table model</span>
      <span class="text-ink-300">/</span>
      <span class="text-ink-700 font-medium">Financings</span>
    </div>

    <div class="flex items-end justify-between gap-6 flex-wrap pb-3">
      <div class="min-w-0">
        <div class="flex items-center gap-3 flex-wrap">
          <h1 class="text-[22px] font-semibold text-ink-900 tracking-tight">Financings</h1>
          <span
            v-if="openRoundName"
            class="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full bg-brand-soft text-brand-edge font-medium"
          >
            <span class="w-1.5 h-1.5 rounded-full bg-brand open-dot"></span>
            {{ openRoundName }} — open
          </span>
          <span
            v-else
            class="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full bg-ink-100 text-ink-600 font-medium"
          >
            <span class="w-1.5 h-1.5 rounded-full bg-ink-300"></span>
            no open round
          </span>
          <span v-if="savingCount > 0" class="text-[12px] text-ink-500 italic">Saving…</span>
          <span v-else-if="lastSavedAgo" class="text-[12px] text-ink-500">· Auto-saved {{ lastSavedAgo }}</span>
        </div>
        <p class="text-[13px] text-ink-500 mt-1 max-w-2xl">
          Previous-round aggregate and the open round you're modeling.
          All financings, share classes, and convertibles are manually entered.
        </p>
      </div>

      <div class="flex items-center gap-2">
        <button
          class="h-8 px-2.5 inline-flex items-center gap-1.5 text-[12px] text-ink-700 border border-ink-200 rounded-md hover:bg-ink-50"
          title="Export the financings matrix as CSV"
          @click="emit('export')"
        >
          <Download :size="13" /> Export
        </button>
        <button
          class="h-8 px-2.5 inline-flex items-center gap-1.5 text-[12px] text-ink-700 border border-ink-200 rounded-md hover:bg-ink-50 disabled:opacity-60 disabled:cursor-not-allowed"
          title="Snapshot the current scenario (coming soon)"
          disabled
        >
          <Camera :size="13" /> Snapshot
        </button>

        <NuxtLink :to="`/companies/${companyId}/import`">
          <button class="h-8 px-2.5 inline-flex items-center gap-1.5 text-[12px] text-ink-700 border border-ink-200 rounded-md hover:bg-ink-50">
            <Upload :size="13" /> Re-import
          </button>
        </NuxtLink>

        <button
          class="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-white bg-ink-900 hover:bg-ink-800 rounded-md"
          @click="emit('add-round')"
        >
          <Plus :size="13" /> Add round
        </button>
      </div>
    </div>

    <!-- Sub-tabs: switch the page body between the matrix and the CN ledger.
         Active tab is underlined with the design's border-b-2 ink-900 line;
         inactive tabs are muted and hover to ink-800. -->
    <div class="flex items-center gap-0 -mb-px">
      <button
        v-for="t in tabs"
        :key="t.key"
        type="button"
        class="px-3 h-9 text-[12.5px] border-b-2 transition-colors"
        :class="activeTab === t.key
          ? 'border-ink-900 text-ink-900 font-semibold'
          : 'border-transparent text-ink-500 hover:text-ink-800'"
        @click="emit('update:active-tab', t.key)"
      >
        {{ t.label }}
      </button>
    </div>
  </div>
</template>
