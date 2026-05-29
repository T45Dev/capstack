<script setup lang="ts">
import { UploadCloud, CheckCircle2, AlertTriangle, ArrowRight, Sparkles, RefreshCcw } from 'lucide-vue-next'
import { fmtShares, fmtDate, fmtPricePerShare } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

interface CompanyRow { id: string; name: string; ticker: string | null; setup_completed_at: string | null }
const { data: company } = await useFetch<CompanyRow>(() => `/api/companies/${id.value}`, { watch: [id] })

// NULL setup_completed_at = first-run; the import endpoint sets it on
// successful import, so subsequent visits to this page get the
// "Re-import" framing.
const firstRun = computed(() => !company.value?.setup_completed_at)

interface SampleStakeholder { name: string; externalId?: string | null }
interface SampleGrant { recipientName: string; quantity: number; strike?: number | null; issueDate?: string | null; awardType?: string | null }
interface Preview {
  filename: string
  companyName: string | null
  asOfDate: string | null
  sheets: { optionPlan: string | null; summaryCapTable: string | null }
  counts: { stakeholders: number; grants: number }
  samples: { stakeholders: SampleStakeholder[]; grants: SampleGrant[] }
  poolAuthorized: number
  warnings: string[]
}

const file = ref<File | null>(null)
const dragging = ref(false)
const uploading = ref(false)
const previewing = ref(false)
const preview = ref<Preview | null>(null)
const previewError = ref<string | null>(null)
const result = ref<{ ok: boolean; counts: Record<string, number>; poolAuthorized?: number; warnings: string[] } | null>(null)
const error = ref<string | null>(null)

async function runPreview(f: File) {
  previewing.value = true
  preview.value = null
  previewError.value = null
  try {
    const fd = new FormData()
    fd.append('file', f)
    preview.value = await $fetch<Preview>(`/api/companies/${id.value}/import-preview`, { method: 'POST', body: fd })
  } catch (e: any) {
    previewError.value = e?.data?.message || e?.message || 'Could not read this file'
  } finally {
    previewing.value = false
  }
}

watch(file, (f) => { if (f) runPreview(f) })

function onPick(e: Event) {
  const t = e.target as HTMLInputElement
  if (t.files?.[0]) file.value = t.files[0]
}
function onDrop(e: DragEvent) {
  dragging.value = false
  if (e.dataTransfer?.files?.[0]) file.value = e.dataTransfer.files[0]
}
function clearFile() {
  file.value = null
  preview.value = null
  previewError.value = null
}

async function upload() {
  if (!file.value || uploading.value) return
  uploading.value = true
  result.value = null
  error.value = null
  try {
    const fd = new FormData()
    fd.append('file', file.value)
    fd.append('replace', 'true')
    result.value = await $fetch(`/api/companies/${id.value}/import`, { method: 'POST', body: fd })
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || 'Upload failed'
  } finally {
    uploading.value = false
  }
}

function done() {
  // Financings + rounds + CNs are all manually entered on the cap-table
  // page, so post-import always goes there (the setup wizard has nothing
  // left to do).
  navigateTo(`/companies/${id.value}/cap-table`)
}

function fileSizeLabel(f: File): string {
  const kb = f.size / 1024
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`
}

const sheetList = computed(() => {
  if (!preview.value) return []
  const s = preview.value.sheets
  const out: Array<{ name: string; role: string }> = []
  if (s.optionPlan)      out.push({ name: s.optionPlan,      role: 'option grants' })
  if (s.summaryCapTable) out.push({ name: s.summaryCapTable, role: 'option pool' })
  return out
})
</script>

<template>
  <div class="max-w-3xl mx-auto">
    <!-- Page header. Same -mx-6 bleed pattern as the Financings page. -->
    <div class="border-b border-ink-200 bg-white -mx-6 -mt-6 px-6 pt-5 pb-3 mb-6">
      <div class="flex items-center gap-1.5 text-[12px] text-ink-500 mb-2">
        <NuxtLink :to="`/companies/${id}`" class="hover:text-ink-700">Cap-table model</NuxtLink>
        <span class="text-ink-300">/</span>
        <span class="text-ink-700 font-medium">Import</span>
      </div>
      <div class="flex items-end justify-between gap-6 flex-wrap">
        <div class="min-w-0">
          <div class="flex items-center gap-3 flex-wrap">
            <h1 class="text-[22px] font-semibold text-ink-900 tracking-tight">
              {{ firstRun ? 'Welcome — let\'s load your option grants' : 'Re-import option grants' }}
            </h1>
            <span class="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full bg-ink-100 text-ink-600 font-medium">
              <span class="w-1.5 h-1.5 rounded-full bg-ink-300"></span>
              {{ company?.name || '—' }}
            </span>
          </div>
          <p class="text-[13px] text-ink-500 mt-1 max-w-2xl">
            Drop a Carta pro-forma <code class="text-ink-700 bg-ink-100 px-1 py-px rounded text-[12px] num">.xlsx</code>. We'll pull in
            <span class="text-ink-700 font-medium">option grants</span>,
            <span class="text-ink-700 font-medium">the people who hold them</span>, and
            <span class="text-ink-700 font-medium">the option-pool size</span>. Rounds, share classes, holdings, and convertible notes stay manual on the Rounds page.
          </p>
        </div>
        <NuxtLink :to="`/companies/${id}/cap-table`">
          <UiButton variant="ghost" size="sm">Cancel</UiButton>
        </NuxtLink>
      </div>
    </div>

    <!-- Drop zone -->
    <section
      class="rounded-xl border border-ink-200 bg-white shadow-[0_1px_0_rgba(16,24,40,0.04)] overflow-hidden"
    >
      <div
        class="m-4 rounded-lg border-2 border-dashed transition-colors px-6 py-12 text-center"
        :class="dragging ? 'border-brand-500 bg-brand-50' : (file ? 'border-ok/40 bg-ok-soft/40' : 'border-ink-300 bg-ink-50/40')"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <template v-if="!file">
          <div class="grid place-items-center w-12 h-12 rounded-full bg-brand-50 text-brand-600 mx-auto mb-3">
            <UploadCloud :size="22" />
          </div>
          <p class="text-[14px] text-ink-800 font-medium">Drop your Carta export here</p>
          <p class="text-[12px] text-ink-500 mt-1">
            or
            <label class="text-brand-600 hover:text-brand-700 cursor-pointer underline font-medium">
              browse for a file
              <input type="file" accept=".xlsx,.xlsm" class="hidden" @change="onPick" />
            </label>
          </p>
          <p class="text-[11px] text-ink-400 mt-3 num">.xlsx or .xlsm · pro-forma cap-table export</p>
        </template>
        <template v-else>
          <div class="grid place-items-center w-12 h-12 rounded-full bg-ok-soft text-ok mx-auto mb-3">
            <CheckCircle2 :size="22" />
          </div>
          <p class="text-[14px]">
            <span class="font-medium num text-ink-900">{{ file.name }}</span>
            <span class="text-ink-500 ml-1.5 num">({{ fileSizeLabel(file) }})</span>
          </p>
          <p class="mt-2">
            <label class="text-[12px] text-ink-500 hover:text-ink-700 cursor-pointer inline-flex items-center gap-1">
              <RefreshCcw :size="11" /> choose a different file
              <input type="file" accept=".xlsx,.xlsm" class="hidden" @change="onPick" />
            </label>
          </p>
        </template>
      </div>

      <!-- Preview pane appears after file selection. -->
      <div v-if="file" class="border-t border-ink-100">
        <div v-if="previewing" class="px-5 py-6 text-center text-[13px] text-ink-500 inline-flex items-center justify-center gap-2 w-full">
          <Sparkles :size="14" class="text-brand-500 animate-pulse" />
          Reading the workbook…
        </div>

        <div v-else-if="previewError" class="m-4 rounded-md border border-warn/30 bg-warn-soft text-warn px-3 py-2.5 text-[12.5px] num">
          {{ previewError }}
          <button class="block mt-1.5 underline text-warn hover:text-warn-dark" @click="clearFile">Pick a different file</button>
        </div>

        <div v-else-if="preview" class="px-5 pt-4 pb-5">
          <!-- File summary -->
          <div class="flex items-start gap-3 pb-3 border-b border-ink-100">
            <div class="grid place-items-center w-8 h-8 rounded-md bg-brand-50 text-brand-600 shrink-0">
              <Sparkles :size="15" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-[13px] text-ink-900">
                <span class="font-semibold">Ready to import</span>
                <span v-if="preview.companyName" class="text-ink-500"> · {{ preview.companyName }}</span>
                <span v-if="preview.asOfDate" class="text-ink-500"> · as of {{ fmtDate(preview.asOfDate) }}</span>
              </div>
              <div class="text-[11.5px] text-ink-500 mt-0.5">
                {{ preview.counts.grants }} option grants ·
                {{ preview.counts.stakeholders }} stakeholders<span v-if="preview.poolAuthorized"> · {{ fmtShares(preview.poolAuthorized) }}-share option pool</span>
              </div>
            </div>
          </div>

          <!-- Counts grid — just the three things we actually import -->
          <div class="grid grid-cols-3 gap-2 mt-4">
            <div class="rounded-md border border-ink-100 bg-ink-50/60 px-3 py-2.5">
              <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium">Option grants</div>
              <div class="num text-[18px] font-semibold text-ink-900 mt-0.5">{{ fmtShares(preview.counts.grants) }}</div>
            </div>
            <div class="rounded-md border border-ink-100 bg-ink-50/60 px-3 py-2.5">
              <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium">Stakeholders</div>
              <div class="num text-[18px] font-semibold text-ink-900 mt-0.5">{{ fmtShares(preview.counts.stakeholders) }}</div>
            </div>
            <div class="rounded-md border border-ink-100 bg-ink-50/60 px-3 py-2.5">
              <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium">Option pool</div>
              <div class="num text-[18px] font-semibold text-ink-900 mt-0.5">{{ preview.poolAuthorized ? fmtShares(preview.poolAuthorized) : '—' }}</div>
            </div>
          </div>

          <!-- Sample rows -->
          <div class="mt-5 space-y-4">
            <div v-if="preview.samples.grants.length">
              <h4 class="text-[10.5px] uppercase tracking-[0.08em] text-ink-500 font-semibold mb-1.5">Option grants <span class="text-ink-400 font-normal normal-case tracking-normal">— first {{ preview.samples.grants.length }}</span></h4>
              <table class="w-full text-[12px] num">
                <tbody class="divide-y divide-ink-100">
                  <tr v-for="(g, i) in preview.samples.grants" :key="i">
                    <td class="py-1 pr-2 text-ink-900 truncate max-w-[40%]">{{ g.recipientName }}</td>
                    <td class="py-1 pr-2 text-ink-500 w-12">{{ g.awardType || '—' }}</td>
                    <td class="py-1 pr-2 text-right text-ink-700">{{ fmtShares(g.quantity) }}</td>
                    <td class="py-1 pr-2 text-right text-ink-500 w-20">{{ g.strike != null ? fmtPricePerShare(g.strike) : '—' }}</td>
                    <td class="py-1 text-right text-ink-500 w-24">{{ g.issueDate ? fmtDate(g.issueDate) : '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-if="preview.samples.stakeholders.length">
              <h4 class="text-[10.5px] uppercase tracking-[0.08em] text-ink-500 font-semibold mb-1.5">Stakeholders <span class="text-ink-400 font-normal normal-case tracking-normal">— first {{ preview.samples.stakeholders.length }}</span></h4>
              <div class="flex flex-wrap gap-1.5">
                <span v-for="sh in preview.samples.stakeholders" :key="sh.name" class="inline-flex items-center text-[12px] px-2 py-0.5 rounded bg-ink-100 text-ink-700 num">{{ sh.name }}</span>
                <span v-if="preview.counts.stakeholders > preview.samples.stakeholders.length" class="inline-flex items-center text-[12px] px-2 py-0.5 rounded text-ink-500 num">+{{ preview.counts.stakeholders - preview.samples.stakeholders.length }} more</span>
              </div>
            </div>
          </div>

          <!-- Sheet attribution -->
          <div v-if="sheetList.length" class="mt-5 pt-3 border-t border-ink-100 text-[11px] text-ink-500">
            <span class="font-medium text-ink-600">Sheets:</span>
            <span v-for="(s, i) in sheetList" :key="s.name" class="ml-1.5">
              <span v-if="i > 0" class="text-ink-300">·</span>
              <span class="num text-ink-700 ml-1.5">{{ s.name }}</span>
              <span class="ml-1">({{ s.role }})</span>
            </span>
          </div>

          <!-- Parser warnings -->
          <div v-if="preview.warnings.length" class="mt-3 rounded-md border border-warn/25 bg-warn-soft/50 px-3 py-2 text-[11.5px] text-warn">
            <div class="font-semibold mb-1 inline-flex items-center gap-1.5"><AlertTriangle :size="12" /> {{ preview.warnings.length }} note{{ preview.warnings.length === 1 ? '' : 's' }} from the parser</div>
            <ul class="space-y-0.5 num">
              <li v-for="(w, i) in preview.warnings.slice(0, 5)" :key="i">— {{ w }}</li>
              <li v-if="preview.warnings.length > 5" class="text-warn/70 italic">…and {{ preview.warnings.length - 5 }} more</li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <!-- Action row -->
    <div class="mt-5 flex items-center justify-end gap-3">
      <span v-if="!file" class="text-[12px] text-ink-400">Pick a file to continue</span>
      <UiButton
        variant="primary"
        size="lg"
        :disabled="!file || uploading || previewing || !!previewError"
        @click="upload"
      >
        <UploadCloud :size="14" />
        {{ uploading ? 'Importing…' : (firstRun ? 'Import grants' : 'Re-import grants') }}
      </UiButton>
    </div>

    <!-- Result panel (post-import) -->
    <section v-if="result" class="mt-6 rounded-lg border border-ink-200 bg-white shadow-[0_1px_0_rgba(16,24,40,0.04)]">
      <header class="px-4 py-3 border-b border-ink-200 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <CheckCircle2 v-if="result.ok" :size="16" class="text-ok" />
          <AlertTriangle v-else :size="16" class="text-warn" />
          <h2 class="text-[13px] font-semibold text-ink-900">{{ result.ok ? 'Import complete' : 'Import finished with issues' }}</h2>
        </div>
        <UiButton variant="primary" size="sm" @click="done">
          Go to Rounds <ArrowRight :size="13" />
        </UiButton>
      </header>

      <div class="px-4 py-3 grid grid-cols-3 gap-x-4 gap-y-2 border-b border-ink-100">
        <div>
          <div class="text-[10.5px] uppercase tracking-[0.06em] text-ink-500 font-medium">Option grants</div>
          <div class="num text-[15px] font-semibold text-ink-900 mt-0.5">{{ result.counts.grants }}</div>
        </div>
        <div class="border-l border-ink-100 pl-3">
          <div class="text-[10.5px] uppercase tracking-[0.06em] text-ink-500 font-medium">Stakeholders</div>
          <div class="num text-[15px] font-semibold text-ink-900 mt-0.5">{{ result.counts.stakeholders }}</div>
        </div>
        <div class="border-l border-ink-100 pl-3">
          <div class="text-[10.5px] uppercase tracking-[0.06em] text-ink-500 font-medium">Option pool</div>
          <div class="num text-[15px] font-semibold text-ink-900 mt-0.5">{{ result.poolAuthorized ? fmtShares(result.poolAuthorized) : '—' }}</div>
        </div>
      </div>

      <div v-if="result.warnings?.length" class="px-4 py-3">
        <h4 class="text-[10.5px] uppercase tracking-[0.08em] text-ink-500 font-semibold mb-2">Notes</h4>
        <ul class="space-y-1 text-[12px] text-ink-700 num">
          <li v-for="(w, i) in result.warnings" :key="i" class="leading-relaxed">— {{ w }}</li>
        </ul>
      </div>
    </section>

    <div
      v-if="error"
      class="mt-4 rounded-md border border-warn/30 bg-warn-soft text-warn px-4 py-3 text-[13px] num"
    >
      {{ error }}
    </div>
  </div>
</template>
