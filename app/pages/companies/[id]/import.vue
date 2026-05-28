<script setup lang="ts">
import { UploadCloud, CheckCircle2, AlertTriangle, ShieldCheck, ArrowRight, Sparkles, RefreshCcw } from 'lucide-vue-next'
import { fmtShares, fmtUSD, fmtDate, fmtPricePerShare, fmtPct } from '~/utils/format'

const route = useRoute()
const id = computed(() => route.params.id as string)

interface CompanyRow { id: string; name: string; ticker: string | null; setup_completed_at: string | null }
const { data: company } = await useFetch<CompanyRow>(() => `/api/companies/${id.value}`, { watch: [id] })

// The Financings page sets setup_completed_at once the operator has
// confirmed rounds. NULL = first-run; this is the user's first Carta
// import for the company, so the page leads with a welcome instead
// of the re-import framing.
const firstRun = computed(() => !company.value?.setup_completed_at)

interface SampleShareClass { code: string; name: string; kind: string; authorized?: number | null; issuePrice?: number | null }
interface SampleStakeholder { name: string; externalId?: string | null }
interface SampleHolding { stakeholderName: string; shareClassCode: string; shares: number }
interface SampleGrant { recipientName: string; quantity: number; strike?: number | null; issueDate?: string | null; awardType?: string | null }
interface SampleConvertible { stakeholderName: string; principal: number; interestRate: number; valuationCap?: number | null; conversionDiscount?: number; issueDate?: string | null }
interface PreviewSheets { detailedCapTable: string | null; optionPlan: string | null; convertibleNotes: string | null; summaryCapTable: string | null }
interface Preview {
  filename: string
  companyName: string | null
  asOfDate: string | null
  sheets: PreviewSheets
  counts: { shareClasses: number; stakeholders: number; holdings: number; grants: number; convertibles: number }
  samples: {
    shareClasses: SampleShareClass[]
    stakeholders: SampleStakeholder[]
    holdings: SampleHolding[]
    grants: SampleGrant[]
    convertibles: SampleConvertible[]
  }
  poolAuthorized: number
  warnings: string[]
}

const file = ref<File | null>(null)
const dragging = ref(false)
const uploading = ref(false)
const previewing = ref(false)
const preview = ref<Preview | null>(null)
const previewError = ref<string | null>(null)
const result = ref<{ ok: boolean; counts: Record<string, number>; warnings: string[] } | null>(null)
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
    // The redesigned page imports everything and replaces existing rows
    // — the per-category opt-outs are gone in favour of a simpler flow.
    // Server defaults already match these, but pass them explicitly so
    // behavior doesn't drift if defaults change.
    fd.append('replace', 'true')
    for (const k of ['share_classes', 'stakeholders', 'holdings', 'grants', 'convertibles', 'option_pools']) {
      fd.append(`include_${k}`, 'true')
    }
    result.value = await $fetch(`/api/companies/${id.value}/import`, { method: 'POST', body: fd })
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || 'Upload failed'
  } finally {
    uploading.value = false
  }
}

function done() {
  // After the first import, the setup wizard owns next steps. After
  // re-imports on an established company, the operator wants the cap
  // table back.
  navigateTo(firstRun.value ? `/companies/${id.value}/setup` : `/companies/${id.value}/cap-table`)
}

function fileSizeLabel(f: File): string {
  const kb = f.size / 1024
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`
}

const totalRows = computed(() => {
  if (!preview.value) return 0
  const c = preview.value.counts
  return c.shareClasses + c.stakeholders + c.holdings + c.grants + c.convertibles
})

const sheetList = computed(() => {
  if (!preview.value) return []
  const s = preview.value.sheets
  const seen = new Set<string>()
  const out: Array<{ name: string; role: string }> = []
  function push(name: string | null, role: string) {
    if (!name) return
    if (seen.has(name)) {
      // Same sheet drove multiple roles (e.g. Detailed Cap Table also
      // sourced holdings + stakeholders) — annotate the existing entry
      // rather than listing it twice.
      const existing = out.find((o) => o.name === name)
      if (existing) existing.role += ` · ${role}`
      return
    }
    seen.add(name)
    out.push({ name, role })
  }
  push(s.detailedCapTable, 'cap table')
  push(s.optionPlan,       'option grants')
  push(s.convertibleNotes, 'convertibles')
  push(s.summaryCapTable,  'totals')
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
              {{ firstRun ? 'Welcome — let\'s load your cap table' : 'Re-import cap table' }}
            </h1>
            <span class="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full bg-ink-100 text-ink-600 font-medium">
              <span class="w-1.5 h-1.5 rounded-full bg-ink-300"></span>
              {{ company?.name || '—' }}
            </span>
          </div>
          <p class="text-[13px] text-ink-500 mt-1 max-w-2xl">
            <template v-if="firstRun">
              Drop your Carta pro-forma export and we'll show you exactly what we found. Nothing's committed until you click <span class="text-ink-700 font-medium">Import</span>.
            </template>
            <template v-else>
              Drop a fresh Carta <code class="text-ink-700 bg-ink-100 px-1 py-px rounded text-[12px] num">.xlsx</code> export. Your Financings table, allocations, and assumptions stay untouched.
            </template>
          </p>
        </div>
        <NuxtLink :to="firstRun ? `/companies/${id}/setup` : `/companies/${id}/cap-table`">
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

      <!-- Preview pane appears after file selection. While the parser runs
           we show a slim placeholder so the layout doesn't jump. -->
      <div v-if="file" class="border-t border-ink-100">
        <!-- Loading state -->
        <div v-if="previewing" class="px-5 py-6 text-center text-[13px] text-ink-500 inline-flex items-center justify-center gap-2 w-full">
          <Sparkles :size="14" class="text-brand-500 animate-pulse" />
          Reading the workbook…
        </div>

        <!-- Error state -->
        <div v-else-if="previewError" class="m-4 rounded-md border border-warn/30 bg-warn-soft text-warn px-3 py-2.5 text-[12.5px] num">
          {{ previewError }}
          <button class="block mt-1.5 underline text-warn hover:text-warn-dark" @click="clearFile">Pick a different file</button>
        </div>

        <!-- Preview content -->
        <div v-else-if="preview" class="px-5 pt-4 pb-5">
          <!-- Summary line — what we extracted about the file itself -->
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
                {{ fmtShares(totalRows) }} rows across
                {{ [
                  preview.counts.shareClasses && `${preview.counts.shareClasses} share classes`,
                  preview.counts.stakeholders && `${preview.counts.stakeholders} stakeholders`,
                  preview.counts.grants       && `${preview.counts.grants} option grants`,
                  preview.counts.convertibles && `${preview.counts.convertibles} convertibles`,
                ].filter(Boolean).join(' · ') }}
              </div>
            </div>
          </div>

          <!-- Counts grid -->
          <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-4">
            <div v-for="cat in [
              { key: 'shareClasses', label: 'Share classes' },
              { key: 'stakeholders', label: 'Stakeholders' },
              { key: 'holdings',     label: 'Holdings' },
              { key: 'grants',       label: 'Option grants' },
              { key: 'convertibles', label: 'Convertibles' },
            ]" :key="cat.key" class="rounded-md border border-ink-100 bg-ink-50/60 px-3 py-2.5">
              <div class="text-[10px] uppercase tracking-[0.06em] text-ink-500 font-medium">{{ cat.label }}</div>
              <div class="num text-[18px] font-semibold text-ink-900 mt-0.5">{{ fmtShares((preview.counts as any)[cat.key]) }}</div>
            </div>
          </div>

          <!-- Sample rows. One mini-table per category. Hidden when the
               category is empty (no rows would just be confusing). -->
          <div class="mt-5 space-y-4">
            <div v-if="preview.samples.shareClasses.length">
              <h4 class="text-[10.5px] uppercase tracking-[0.08em] text-ink-500 font-semibold mb-1.5">Share classes <span class="text-ink-400 font-normal normal-case tracking-normal">— first {{ preview.samples.shareClasses.length }}</span></h4>
              <table class="w-full text-[12px] num">
                <tbody class="divide-y divide-ink-100">
                  <tr v-for="sc in preview.samples.shareClasses" :key="sc.code">
                    <td class="py-1 pr-2 w-14 text-ink-500">{{ sc.code }}</td>
                    <td class="py-1 pr-2 text-ink-900">{{ sc.name }}</td>
                    <td class="py-1 pr-2 text-ink-500 capitalize">{{ sc.kind }}</td>
                    <td class="py-1 text-right text-ink-700">{{ sc.authorized ? `${fmtShares(sc.authorized)} auth` : '' }}</td>
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

            <div v-if="preview.samples.holdings.length">
              <h4 class="text-[10.5px] uppercase tracking-[0.08em] text-ink-500 font-semibold mb-1.5">Holdings <span class="text-ink-400 font-normal normal-case tracking-normal">— first {{ preview.samples.holdings.length }}</span></h4>
              <table class="w-full text-[12px] num">
                <tbody class="divide-y divide-ink-100">
                  <tr v-for="(h, i) in preview.samples.holdings" :key="i">
                    <td class="py-1 pr-2 text-ink-900 truncate max-w-[40%]">{{ h.stakeholderName }}</td>
                    <td class="py-1 pr-2 text-ink-500 w-16">{{ h.shareClassCode }}</td>
                    <td class="py-1 text-right text-ink-700">{{ fmtShares(h.shares) }} shares</td>
                  </tr>
                </tbody>
              </table>
            </div>

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

            <div v-if="preview.samples.convertibles.length">
              <h4 class="text-[10.5px] uppercase tracking-[0.08em] text-ink-500 font-semibold mb-1.5">Convertible notes <span class="text-ink-400 font-normal normal-case tracking-normal">— first {{ preview.samples.convertibles.length }}</span></h4>
              <table class="w-full text-[12px] num">
                <tbody class="divide-y divide-ink-100">
                  <tr v-for="(cn, i) in preview.samples.convertibles" :key="i">
                    <td class="py-1 pr-2 text-ink-900 truncate max-w-[35%]">{{ cn.stakeholderName }}</td>
                    <td class="py-1 pr-2 text-right text-ink-700 w-24">{{ fmtUSD(cn.principal) }}</td>
                    <td class="py-1 pr-2 text-right text-ink-500 w-16">{{ cn.interestRate ? fmtPct(cn.interestRate, 1) : '—' }}</td>
                    <td class="py-1 pr-2 text-right text-ink-500 w-24">{{ cn.valuationCap ? `${fmtUSD(cn.valuationCap)} cap` : '—' }}</td>
                    <td class="py-1 text-right text-ink-500 w-16">{{ cn.conversionDiscount ? fmtPct(cn.conversionDiscount, 0) + ' disc' : '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- Sheet attribution. Footer-style: small text showing which
               sheets we read each category from. Auto-detected; no
               user-facing override (that lived on the old page and most
               users never touched it). -->
          <div v-if="sheetList.length" class="mt-5 pt-3 border-t border-ink-100 text-[11px] text-ink-500">
            <span class="font-medium text-ink-600">Sheets:</span>
            <span v-for="(s, i) in sheetList" :key="s.name" class="ml-1.5">
              <span v-if="i > 0" class="text-ink-300">·</span>
              <span class="num text-ink-700 ml-1.5">{{ s.name }}</span>
              <span class="ml-1">({{ s.role }})</span>
            </span>
          </div>

          <!-- Parser warnings, if any. Surfaced inline so the operator
               sees them before clicking Import. Most are informational
               ("X rows on the Plan sheet weren't recognized as grants")
               and the import still works around them. -->
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

    <!-- Never-touched panel — reassurance for re-imports. First-run
         users don't have anything to lose, so we hide it for them. -->
    <section v-if="!firstRun" class="mt-4 rounded-lg border border-ok/25 bg-ok-soft/60 px-4 py-3 text-[12px] text-ok">
      <div class="flex items-center gap-1.5 font-semibold mb-1">
        <ShieldCheck :size="13" /> Re-import never touches
      </div>
      <p class="leading-relaxed">
        Your <span class="font-medium">Financings table</span> (rounds, pre/new/post money, share price, liq pref, every typed column)
        · <span class="font-medium">Pool Impact Ideas</span>
        · <span class="font-medium">Per-investor allocations</span>
        · <span class="font-medium">Assumptions notes</span>.
      </p>
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
        {{ uploading ? 'Importing…' : (firstRun ? 'Import my cap table' : 'Import') }}
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
          {{ firstRun ? 'Set up your rounds' : 'View cap table' }} <ArrowRight :size="13" />
        </UiButton>
      </header>

      <div class="px-4 py-3 grid grid-cols-2 sm:grid-cols-5 gap-x-4 gap-y-2 border-b border-ink-100">
        <div v-for="cat in [
          { key: 'stakeholders', label: 'Stakeholders' },
          { key: 'shareClasses', label: 'Share classes' },
          { key: 'holdings',     label: 'Holdings' },
          { key: 'grants',       label: 'Grants' },
          { key: 'convertibles', label: 'Convertibles' },
        ]" :key="cat.key" class="border-l border-ink-100 pl-3 first:border-l-0 first:pl-0">
          <div class="text-[10.5px] uppercase tracking-[0.06em] text-ink-500 font-medium">{{ cat.label }}</div>
          <div class="num text-[15px] font-semibold text-ink-900 mt-0.5">{{ result.counts[cat.key] }}</div>
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
