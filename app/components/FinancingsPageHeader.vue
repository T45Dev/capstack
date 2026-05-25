<script setup lang="ts">
// Per-page header for the Financings page.
//
// Layout: breadcrumb / title row (H1 + status pill + saving indicator) /
// description / actions. Pre-baseline picker lives in AppTopBar (it serves
// every per-company page, not just this one).
import { Plus, Upload } from 'lucide-vue-next'

interface Props {
  openRoundName: string | null
  savingCount: number
  companyId: string
}

defineProps<Props>()

const emit = defineEmits<{
  (e: 'add-round'): void
}>()
</script>

<template>
  <div class="border-b border-ink-200 bg-white -mx-6 -mt-6 px-6 pt-5 pb-3 mb-6">
    <!-- Breadcrumb. Kept text-only (no chevrons inside links) to match
         the design's restrained density. -->
    <div class="flex items-center gap-1.5 text-[12px] text-ink-500 mb-2">
      <span>Cap-table model</span>
      <span class="text-ink-300">/</span>
      <span class="text-ink-700 font-medium">Financings</span>
    </div>

    <div class="flex items-end justify-between gap-6 flex-wrap">
      <div class="min-w-0">
        <div class="flex items-center gap-3 flex-wrap">
          <h1 class="text-[22px] font-semibold text-ink-900 tracking-tight">Financings</h1>
          <!-- Open round pill. Pulses while a round is flagged Open so the
               operator always sees what's currently being modeled. -->
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
        </div>
        <p class="text-[13px] text-ink-500 mt-1 max-w-2xl">
          Per-round equity inputs and derived cap-stack math. Convertible-note
          attribution per round; ledger below the matrix.
        </p>
      </div>

      <div class="flex items-center gap-2">
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
  </div>
</template>
