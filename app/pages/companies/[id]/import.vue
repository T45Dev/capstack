<script setup lang="ts">
import { UploadCloud, CheckCircle2, AlertTriangle, ShieldCheck, FileSpreadsheet, ArrowRight } from 'lucide-vue-next'

const route = useRoute()
const id = computed(() => route.params.id as string)

const { data: company } = await useFetch(() => `/api/companies/${id.value}`, { watch: [id] })

const file = ref<File | null>(null)
const dragging = ref(false)
const replace = ref(true)
const uploading = ref(false)
const result = ref<{ ok: boolean; counts: Record<string, number>; skipped?: string[]; warnings: string[] } | null>(null)
const error = ref<string | null>(null)

// Sheet-role mapping. Populated by /import-inspect on file selection.
// Empty value = auto-detect (parser regex fallback); any other value is
// the literal sheet name to use. Surfacing the picker explicitly is the
// future-proof fix for Carta's varying sheet labels.
interface SheetInfo { name: string; rowCount: number; columnCount: number }
const sheets = ref<SheetInfo[]>([])
const inspecting = ref(false)
const inspectError = ref<string | null>(null)

type Role = 'detailedCapTableSheet' | 'optionPlanSheet' | 'convertibleNotesSheet' | 'summaryCapTableSheet'
const roleLabels: Record<Role, { label: string; hint: string }> = {
  detailedCapTableSheet:  { label: 'Detailed cap table',         hint: 'Per-stakeholder grid (holdings, options summed per person).' },
  optionPlanSheet:        { label: 'Option grants (per grant)',  hint: 'Per-grant rows: strike, issue date, vesting, exercised. Drives Option Pool Impact.' },
  convertibleNotesSheet:  { label: 'Convertible notes ledger',   hint: 'Principal, interest, valuation cap, discount, conversion date.' },
  summaryCapTableSheet:   { label: 'Summary cap table',          hint: 'Authorized totals per class + total option pool size.' },
}
const sheetRoles = reactive<Record<Role, string>>({
  detailedCapTableSheet: '',
  optionPlanSheet: '',
  convertibleNotesSheet: '',
  summaryCapTableSheet: '',
})

async function inspect(f: File) {
  inspecting.value = true
  inspectError.value = null
  sheets.value = []
  for (const k of Object.keys(sheetRoles) as Role[]) sheetRoles[k] = ''
  try {
    const fd = new FormData()
    fd.append('file', f)
    const res = await $fetch<{ sheets: SheetInfo[]; detected: Record<Role, string | null> }>(`/api/companies/${id.value}/import-inspect`, { method: 'POST', body: fd })
    sheets.value = res.sheets
    for (const k of Object.keys(sheetRoles) as Role[]) {
      sheetRoles[k] = res.detected[k] || ''
    }
  } catch (e: any) {
    inspectError.value = e?.data?.message || e?.message || 'Inspect failed'
  } finally {
    inspecting.value = false
  }
}

watch(file, (f) => { if (f) inspect(f) })

// Per-category opt-in. Default = include everything (matches current
// behavior). Rounds, assumptions, pool_events (Pool Impact Ideas), and
// round_investors are listed in the "never touched" panel below; they're
// not on this list because the server never deletes them.
type Cat = 'shareClasses' | 'stakeholders' | 'holdings' | 'grants' | 'convertibles' | 'optionPools'
const include = reactive<Record<Cat, boolean>>({
  shareClasses: true,
  stakeholders: true,
  holdings: true,
  grants: true,
  convertibles: true,
  optionPools: true,
})

const catLabels: Record<Cat, { label: string; hint: string }> = {
  shareClasses: { label: 'Share classes',     hint: 'Common, Preferred (per series), Warrants, etc.' },
  stakeholders: { label: 'Stakeholders',      hint: 'Founders, investors, employees — anyone on the cap table.' },
  holdings:     { label: 'Holdings',          hint: 'Stakeholder × share-class shares (the cap-table grid itself).' },
  grants:       { label: 'Option grants',     hint: 'Outstanding options + strike / vesting / exercised / forfeited.' },
  convertibles: { label: 'Convertible notes', hint: 'CN ledger — principal, rate, discount, conversion date.' },
  optionPools:  { label: 'Option pool size',  hint: 'Total authorized pool from the Stock Option and Incentive Plan sheet.' },
}

function onPick(e: Event) {
  const t = e.target as HTMLInputElement
  if (t.files?.[0]) file.value = t.files[0]
}
function onDrop(e: DragEvent) {
  dragging.value = false
  if (e.dataTransfer?.files?.[0]) file.value = e.dataTransfer.files[0]
}

async function upload() {
  if (!file.value || uploading.value) return
  uploading.value = true
  result.value = null
  error.value = null
  try {
    const fd = new FormData()
    fd.append('file', file.value)
    fd.append('replace', String(replace.value))
    for (const k of Object.keys(include) as Cat[]) {
      fd.append(`include_${k === 'shareClasses' ? 'share_classes' : k === 'optionPools' ? 'option_pools' : k}`, String(include[k]))
    }
    fd.append('sheet_detailed_cap_table',  sheetRoles.detailedCapTableSheet)
    fd.append('sheet_option_plan',         sheetRoles.optionPlanSheet)
    fd.append('sheet_convertible_notes',   sheetRoles.convertibleNotesSheet)
    fd.append('sheet_summary_cap_table',   sheetRoles.summaryCapTableSheet)
    result.value = await $fetch(`/api/companies/${id.value}/import`, { method: 'POST', body: fd })
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || 'Upload failed'
  } finally {
    uploading.value = false
  }
}

function done() {
  navigateTo(`/companies/${id.value}/cap-table`)
}

function selectAll(v: boolean) {
  for (const k of Object.keys(include) as Cat[]) include[k] = v
}
function keepFinancingsSafe() {
  // "Just the data the Financings page doesn't own" — keeps share classes
  // off (because share-class names sometimes drive round attribution) and
  // turns the rest on.
  include.shareClasses = false
  include.stakeholders = true
  include.holdings = true
  include.grants = true
  include.convertibles = true
  include.optionPools = true
}

function fileSizeLabel(f: File): string {
  const kb = f.size / 1024
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`
}
</script>

<template>
  <div class="max-w-3xl mx-auto">
    <!-- Page header matching the Financings page chrome. Lives on this
         page only (no global wrapper) so it picks up the same -mx-6
         bleed and breadcrumb pattern. -->
    <div class="border-b border-ink-200 bg-white -mx-6 -mt-6 px-6 pt-5 pb-3 mb-6">
      <div class="flex items-center gap-1.5 text-[12px] text-ink-500 mb-2">
        <span>Cap-table model</span>
        <span class="text-ink-300">/</span>
        <span class="text-ink-700 font-medium">Import</span>
      </div>
      <div class="flex items-end justify-between gap-6 flex-wrap">
        <div class="min-w-0">
          <div class="flex items-center gap-3 flex-wrap">
            <h1 class="text-[22px] font-semibold text-ink-900 tracking-tight">Import cap table</h1>
            <span class="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full bg-ink-100 text-ink-600 font-medium">
              <span class="w-1.5 h-1.5 rounded-full bg-ink-300"></span>
              {{ company?.name || '—' }}
            </span>
          </div>
          <p class="text-[13px] text-ink-500 mt-1 max-w-2xl">
            Drop a Carta <code class="text-ink-700 bg-ink-100 px-1 py-px rounded text-[12px] num">.xlsx</code>
            export. Pick exactly which categories should re-import so any
            hand-curated work on the Financings page stays untouched.
          </p>
        </div>
        <NuxtLink :to="`/companies/${id}/cap-table`">
          <button class="h-8 px-2.5 inline-flex items-center gap-1.5 text-[12px] text-ink-700 border border-ink-200 rounded-md hover:bg-ink-50">
            Cancel
          </button>
        </NuxtLink>
      </div>
    </div>

    <!-- Drop zone -->
    <section class="border border-ink-200 rounded-lg bg-white shadow-[0_1px_0_rgba(16,24,40,0.04)]">
      <div
        class="m-4 rounded-md border-2 border-dashed transition-colors px-6 py-10 text-center"
        :class="dragging ? 'border-brand bg-brand-soft' : (file ? 'border-ok/40 bg-ok-soft/40' : 'border-ink-300 bg-ink-50/40')"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <UploadCloud v-if="!file" :size="32" class="mx-auto text-ink-500" />
        <CheckCircle2 v-else :size="32" class="mx-auto text-ok" />
        <p class="mt-3 text-[13px] text-ink-800">
          <template v-if="file">
            <span class="font-medium num">{{ file.name }}</span>
            <span class="text-ink-500 ml-1.5 num">({{ fileSizeLabel(file) }})</span>
          </template>
          <template v-else>
            <span class="font-medium">Drop .xlsx here</span> or
            <label class="text-brand-edge hover:text-brand-deep cursor-pointer underline font-medium">
              browse
              <input type="file" accept=".xlsx,.xlsm" class="hidden" @change="onPick" />
            </label>
          </template>
        </p>
        <p v-if="file" class="mt-1">
          <label class="text-[11px] text-ink-500 hover:text-ink-700 cursor-pointer underline">
            choose a different file
            <input type="file" accept=".xlsx,.xlsm" class="hidden" @change="onPick" />
          </label>
        </p>
      </div>

      <!-- Sheet-role mapping. After file selection we read the workbook
           and surface the sheet list + auto-detected role guesses. -->
      <div v-if="file" class="px-4 pt-2 pb-4 border-t border-ink-100">
        <div class="flex items-center justify-between mb-3 mt-3">
          <h3 class="text-[10.5px] uppercase tracking-[0.08em] font-semibold text-ink-500 flex items-center gap-1.5">
            <FileSpreadsheet :size="12" /> Sheet roles
          </h3>
          <span v-if="inspecting" class="text-[11px] text-ink-500 italic">Reading sheets…</span>
        </div>
        <p class="text-[12px] text-ink-500 mb-3">
          Tell us which sheet contains what. Auto-detected from sheet names; override when Carta's labelling slips past our patterns.
        </p>
        <div v-if="inspectError" class="text-[12px] text-warn bg-warn-soft border border-warn/30 rounded-md px-3 py-2 mb-3 num">{{ inspectError }}</div>
        <div v-else-if="sheets.length" class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
          <div v-for="(meta, role) in roleLabels" :key="role">
            <label class="block text-[11.5px] font-medium text-ink-700 mb-1">{{ meta.label }}</label>
            <label class="cell-edit block">
              <select v-model="sheetRoles[role]" class="num text-[13px] bg-transparent">
                <option value="">— auto-detect —</option>
                <option v-for="s in sheets" :key="s.name" :value="s.name">{{ s.name }} ({{ s.rowCount }} rows)</option>
              </select>
            </label>
            <div class="text-[10.5px] text-ink-500 mt-1">{{ meta.hint }}</div>
          </div>
        </div>
      </div>

      <!-- Per-category opt-in selector. -->
      <div class="px-4 pt-4 pb-4 border-t border-ink-100">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-[10.5px] uppercase tracking-[0.08em] font-semibold text-ink-500">What to (re-)import</h3>
          <div class="flex items-center gap-2 text-[11.5px]">
            <button class="text-brand-edge hover:text-brand-deep" @click="selectAll(true)">All</button>
            <span class="text-ink-300">·</span>
            <button class="text-brand-edge hover:text-brand-deep" @click="selectAll(false)">None</button>
            <span class="text-ink-300">·</span>
            <button
              class="text-brand-edge hover:text-brand-deep"
              title="Keep Share classes (and the round attribution they drive) intact; re-import everything else."
              @click="keepFinancingsSafe"
            >Skip share classes</button>
          </div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2.5">
          <label v-for="(meta, k) in catLabels" :key="k" class="flex items-start gap-2 cursor-pointer py-1 px-2 rounded hover:bg-ink-50">
            <input type="checkbox" v-model="include[k]" class="mt-0.5 w-3.5 h-3.5 rounded border-ink-300 text-brand focus:ring-brand/30" />
            <div class="min-w-0">
              <div class="text-[13px] text-ink-900 font-medium">{{ meta.label }}</div>
              <div class="text-[11px] text-ink-500">{{ meta.hint }}</div>
            </div>
          </label>
        </div>
      </div>

      <!-- Never-touched panel — the failsafe surfaced. -->
      <div class="mx-4 mb-4 rounded-md border border-ok/25 bg-ok-soft/60 px-3 py-2.5 text-[11.5px] text-ok">
        <div class="flex items-center gap-1.5 font-semibold mb-1">
          <ShieldCheck :size="13" /> Never touched by re-import
        </div>
        <p class="leading-relaxed">
          <span class="font-medium">Financings table</span> (rounds, pre/new/post money, share price, liq pref, every typed column)
          · <span class="font-medium">Pool Impact Ideas</span>
          · <span class="font-medium">Per-investor allocations</span>
          · <span class="font-medium">Assumptions notes</span>.
        </p>
      </div>

      <!-- Action row -->
      <div class="px-4 py-3 border-t border-ink-100 bg-ink-50/40 flex items-center justify-between gap-3 rounded-b-lg">
        <label class="text-[12px] text-ink-600 inline-flex items-center gap-2 cursor-pointer">
          <input type="checkbox" v-model="replace" class="w-3.5 h-3.5 rounded border-ink-300 text-brand focus:ring-brand/30" />
          Replace existing rows in checked categories (recommended for a fresh export)
        </label>
        <button
          class="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-white bg-ink-900 hover:bg-ink-800 rounded-md disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-ink-700"
          :disabled="!file || uploading"
          @click="upload"
        >
          <UploadCloud :size="13" />
          {{ uploading ? 'Uploading…' : 'Import' }}
        </button>
      </div>
    </section>

    <!-- Result panel -->
    <section v-if="result" class="mt-4 border border-ink-200 rounded-lg bg-white shadow-[0_1px_0_rgba(16,24,40,0.04)]">
      <header class="px-4 py-3 border-b border-ink-200 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <CheckCircle2 v-if="result.ok" :size="16" class="text-ok" />
          <AlertTriangle v-else :size="16" class="text-warn" />
          <h2 class="text-[13px] font-semibold text-ink-900">{{ result.ok ? 'Import complete' : 'Import finished with issues' }}</h2>
        </div>
        <button
          class="h-8 px-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-white bg-ink-900 hover:bg-ink-800 rounded-md"
          @click="done"
        >
          View cap table <ArrowRight :size="13" />
        </button>
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

      <div v-if="result.skipped?.length" class="px-4 py-2 text-[11.5px] text-ink-500 border-b border-ink-100 num">
        Skipped (kept as-is):
        <span class="text-ink-700 font-medium">{{ result.skipped.join(', ') }}</span>
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

<style scoped>
/* The native <select> inside .cell-edit doesn't inherit the wrapper's font
   styling cleanly across browsers; nudge it back to mono + size so it
   visually lines up with the matrix's typed cells. */
.cell-edit select {
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 16 16' fill='none' stroke='%23667085' stroke-width='1.5' stroke-linecap='round'%3E%3Cpath d='M3.5 6 L8 10.5 L12.5 6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 4px center;
  background-size: 12px;
  padding-right: 18px;
}
</style>
