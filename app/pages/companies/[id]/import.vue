<script setup lang="ts">
import { UploadCloud, CheckCircle2, AlertTriangle, ShieldCheck, FileSpreadsheet } from 'lucide-vue-next'

const route = useRoute()
const id = computed(() => route.params.id as string)

const { data: company } = await useFetch(() => `/api/companies/${id.value}`, { watch: [id] })

const file = ref<File | null>(null)
const dragging = ref(false)
const replace = ref(true)
const uploading = ref(false)
const result = ref<{ ok: boolean; counts: Record<string, number>; skipped?: string[]; warnings: string[] } | null>(null)
const error = ref<string | null>(null)

// Sheet-role mapping. Populated by the /import-inspect endpoint on
// file selection. Each role's value is the actual sheet name from
// the workbook (or empty = "auto-detect", which uses the parser's
// built-in regex fallback). Surfacing this explicitly means the
// operator can point us at the right sheet when Carta's labelling
// slips past our patterns — the future-proof fix the user asked for.
interface SheetInfo { name: string; rowCount: number; columnCount: number }
const sheets = ref<SheetInfo[]>([])
const inspecting = ref(false)
const inspectError = ref<string | null>(null)

type Role = 'detailedCapTableSheet' | 'optionPlanSheet' | 'convertibleNotesSheet' | 'summaryCapTableSheet'
const roleLabels: Record<Role, { label: string; hint: string }> = {
  detailedCapTableSheet:  { label: 'Detailed cap table',         hint: 'Per-stakeholder grid (holdings, options summed per person).' },
  optionPlanSheet:        { label: 'Option grants (per grant)',   hint: 'Per-grant rows: strike, issue date, vesting, exercised. This drives Option Pool Impact.' },
  convertibleNotesSheet:  { label: 'Convertible notes ledger',    hint: 'Principal, interest, valuation cap, discount, conversion date.' },
  summaryCapTableSheet:   { label: 'Summary cap table',           hint: 'Authorized totals per class + total option pool size.' },
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
  shareClasses: { label: 'Share classes',  hint: 'Common, Preferred (per series), Warrants, etc.' },
  stakeholders: { label: 'Stakeholders',   hint: 'Founders, investors, employees — anyone on the cap table' },
  holdings:     { label: 'Holdings',       hint: 'Stakeholder × share-class shares (the cap table grid itself)' },
  grants:       { label: 'Option grants',  hint: 'Outstanding options + strike / vesting / exercised / forfeited' },
  convertibles: { label: 'Convertible notes', hint: 'CN ledger — principal, rate, discount, conversion date' },
  optionPools:  { label: 'Option pool size', hint: 'Total authorized pool from the Stock Option and Incentive Plan sheet' },
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
    // Per-category flags. Server reads these to decide what to wipe-and-
    // reimport vs leave alone.
    for (const k of Object.keys(include) as Cat[]) {
      fd.append(`include_${k === 'shareClasses' ? 'share_classes' : k === 'optionPools' ? 'option_pools' : k}`, String(include[k]))
    }
    // Sheet-role overrides. Empty string = auto-detect (server's regex
    // fallback runs). Any non-empty value is the exact sheet name to
    // use.
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

// Quick toggles for the common cases.
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
</script>

<template>
  <div class="max-w-2xl mx-auto">
    <h1 class="text-xl font-semibold tracking-tight text-ink-900">Import cap table</h1>
    <p class="text-sm text-ink-600 mt-1">
      Upload a Carta <code class="text-ink-900 bg-ink-200 px-1 rounded">.xlsx</code> pro-forma export for <span class="text-ink-900 font-medium">{{ company?.name }}</span>.
      Pick exactly which categories should re-import so your hand-curated work stays safe.
    </p>

    <UiCard class="mt-6">
      <div
        class="rounded-md border-2 border-dashed transition-colors p-8 text-center"
        :class="dragging ? 'border-brand-500 bg-brand-50' : 'border-ink-300 bg-ink-100/50'"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <UploadCloud :size="32" class="mx-auto text-ink-500" />
        <p class="mt-3 text-sm text-ink-800">
          <span class="font-medium">Drop .xlsx here</span> or
          <label class="text-brand-600 hover:text-brand-700 cursor-pointer underline font-medium">
            browse
            <input type="file" accept=".xlsx,.xlsm" class="hidden" @change="onPick" />
          </label>
        </p>
        <p v-if="file" class="mt-2 text-xs text-ink-700">{{ file.name }} ({{ Math.round(file.size / 1024) }} KB)</p>
      </div>

      <!-- Sheet-role mapping. After a file is selected we inspect the
           workbook and surface the sheet list + auto-detected role
           guesses so the operator can confirm or override. This is the
           future-proof fix for Carta's varying sheet labels — instead
           of relying on regex pattern matching alone, we let the
           operator point us at the right sheet explicitly. -->
      <div v-if="file" class="mt-5">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-ink-500 flex items-center gap-1.5">
            <FileSpreadsheet :size="13" /> Sheet roles
          </h3>
          <span v-if="inspecting" class="text-[11px] text-ink-500 italic">Reading sheets…</span>
        </div>
        <p class="text-[11px] text-ink-500 mb-2">
          Tell us which sheet contains what. Auto-detected from sheet names; override here when the labelling slips past our patterns.
        </p>
        <div v-if="inspectError" class="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5 mb-2">{{ inspectError }}</div>
        <div v-else-if="sheets.length" class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
          <div v-for="(meta, role) in roleLabels" :key="role">
            <label class="block text-[11px] font-medium text-ink-700">{{ meta.label }}</label>
            <select
              v-model="sheetRoles[role]"
              class="mt-0.5 w-full text-[12px] border border-ink-300 hover:border-ink-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 rounded px-1.5 py-1 bg-white"
            >
              <option value="">— auto-detect —</option>
              <option v-for="s in sheets" :key="s.name" :value="s.name">{{ s.name }} ({{ s.rowCount }} rows)</option>
            </select>
            <div class="text-[10px] text-ink-500 mt-0.5">{{ meta.hint }}</div>
          </div>
        </div>
      </div>

      <!-- Per-category opt-in selector. Defaults to everything-on so the
           old behavior survives; the operator can untick anything they've
           curated. -->
      <div class="mt-5">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-ink-500">What to (re-)import</h3>
          <div class="flex items-center gap-2 text-[11px]">
            <button class="text-brand-600 hover:text-brand-700 underline" @click="selectAll(true)">All</button>
            <span class="text-ink-400">·</span>
            <button class="text-brand-600 hover:text-brand-700 underline" @click="selectAll(false)">None</button>
            <span class="text-ink-400">·</span>
            <button class="text-brand-600 hover:text-brand-700 underline" title="Keep Share classes (and the round attribution they drive) intact; re-import everything else." @click="keepFinancingsSafe">Skip share classes</button>
          </div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <label v-for="(meta, k) in catLabels" :key="k" class="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" v-model="include[k]" class="mt-0.5 rounded border-ink-400 text-brand-500 focus:ring-brand-500" />
            <div>
              <div class="text-ink-900 font-medium">{{ meta.label }}</div>
              <div class="text-[11px] text-ink-500">{{ meta.hint }}</div>
            </div>
          </label>
        </div>
      </div>

      <!-- Never-touched panel — surface the failsafe explicitly. -->
      <div class="mt-5 rounded-md border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-900">
        <div class="flex items-center gap-1.5 font-semibold mb-1">
          <ShieldCheck :size="14" /> Never touched by re-import
        </div>
        <p class="text-emerald-900/90">
          <span class="font-medium">Financings table</span> (rounds, pre-money, new money, share price, liq pref, all the columns you typed)
          · <span class="font-medium">Pool Impact Ideas</span>
          · <span class="font-medium">Per-investor allocations</span>
          · <span class="font-medium">Assumptions notes</span>.
        </p>
      </div>

      <div class="mt-4 flex items-center justify-between gap-3">
        <label class="text-xs text-ink-600 inline-flex items-center gap-2">
          <input type="checkbox" v-model="replace" class="rounded border-ink-400 text-brand-500 focus:ring-brand-500" />
          Replace existing rows in checked categories (recommended for a fresh export)
        </label>
        <UiButton variant="primary" :disabled="!file || uploading" @click="upload">
          <UploadCloud :size="14" /> {{ uploading ? 'Uploading…' : 'Import' }}
        </UiButton>
      </div>
    </UiCard>

    <UiCard v-if="result" class="mt-4" :title="result.ok ? 'Import complete' : 'Import finished with issues'">
      <template #header>
        <CheckCircle2 v-if="result.ok" :size="18" class="text-emerald-600" />
        <AlertTriangle v-else :size="18" class="text-amber-600" />
      </template>
      <div class="flex flex-wrap gap-2">
        <UiStat label="Stakeholders" :value="result.counts.stakeholders" class="flex-1 min-w-[110px]" />
        <UiStat label="Share classes" :value="result.counts.shareClasses" class="flex-1 min-w-[110px]" />
        <UiStat label="Holdings" :value="result.counts.holdings" class="flex-1 min-w-[110px]" />
        <UiStat label="Grants" :value="result.counts.grants" class="flex-1 min-w-[110px]" />
        <UiStat label="Convertibles" :value="result.counts.convertibles" class="flex-1 min-w-[110px]" />
      </div>
      <div v-if="result.skipped?.length" class="mt-3 text-xs text-ink-600">
        Skipped (kept as-is): <span class="font-medium">{{ result.skipped.join(', ') }}</span>
      </div>
      <div v-if="result.warnings?.length" class="mt-4">
        <h4 class="text-xs uppercase text-ink-500 tracking-wide font-semibold mb-2">Notes</h4>
        <ul class="space-y-1 text-xs text-ink-700 list-disc pl-5">
          <li v-for="(w, i) in result.warnings" :key="i">{{ w }}</li>
        </ul>
      </div>
      <div class="mt-4 flex justify-end">
        <UiButton variant="primary" @click="done">View cap table →</UiButton>
      </div>
    </UiCard>

    <div v-if="error" class="mt-4 rounded-md border border-red-200 bg-red-50 text-red-800 px-4 py-3 text-sm">
      {{ error }}
    </div>
  </div>
</template>
