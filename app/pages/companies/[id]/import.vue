<script setup lang="ts">
import { UploadCloud, CheckCircle2, AlertTriangle, ArrowRight, Download, Sparkles, FileSpreadsheet } from 'lucide-vue-next'

const route = useRoute()
const id = computed(() => route.params.id as string)

interface CompanyRow { id: string; name: string; slug: string | null; ticker: string | null; setup_completed_at: string | null }
const { data: company } = await useFetch<CompanyRow>(() => `/api/companies/${id.value}`, { watch: [id] })

const slug = computed(() => company.value?.slug || (company.value?.name || 'capstack').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))

// ---- Step 1a: blank template ----
function downloadTemplate() { window.location.href = `/api/companies/${id.value}/master-template` }

// ---- Step 1b: prefill from a Carta export ----
// We POST the Carta file and get back a prefilled .xlsx; trigger a browser
// download from the blob (can't use a plain link for a POST-with-body).
const cartaFile = ref<File | null>(null)
const prefilling = ref(false)
const prefillError = ref<string | null>(null)
const prefilled = ref(false)
function onCartaPick(e: Event) {
  cartaFile.value = (e.target as HTMLInputElement).files?.[0] || null
  prefillError.value = null; prefilled.value = false
}
async function prefillFromCarta() {
  if (!cartaFile.value || prefilling.value) return
  prefilling.value = true; prefillError.value = null; prefilled.value = false
  try {
    const fd = new FormData()
    fd.append('file', cartaFile.value)
    const res = await fetch(`/api/companies/${id.value}/carta-to-template`, { method: 'POST', body: fd })
    if (!res.ok) {
      const body = await res.json().catch(() => ({} as any))
      throw new Error(body?.message || 'Could not read that Carta export')
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${slug.value}-prefilled.xlsx`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
    prefilled.value = true
  } catch (e: any) {
    prefillError.value = e?.message || 'Prefill failed'
  } finally {
    prefilling.value = false
  }
}

// ---- Step 2: import the filled workbook ----
const masterFile = ref<File | null>(null)
const masterUploading = ref(false)
const masterResult = ref<{ ok: boolean; counts: Record<string, number>; warnings: string[] } | null>(null)
const masterError = ref<string | null>(null)
function onMasterPick(e: Event) {
  masterFile.value = (e.target as HTMLInputElement).files?.[0] || null
  masterError.value = null; masterResult.value = null
}
async function uploadMaster() {
  if (!masterFile.value || masterUploading.value) return
  masterUploading.value = true; masterError.value = null
  try {
    const fd = new FormData()
    fd.append('file', masterFile.value)
    masterResult.value = await $fetch(`/api/companies/${id.value}/master-import`, { method: 'POST', body: fd })
  } catch (e: any) {
    masterError.value = e?.data?.message || e?.message || 'Import failed'
  } finally {
    masterUploading.value = false
  }
}

// Friendly labels for the imported-counts chips.
const countLabels: Record<string, string> = {
  stakeholders: 'stakeholders', holdings: 'holdings', grants: 'issued grants',
  proposed: 'proposed grants', convertibles: 'convertibles', rounds: 'rounds', ideas: 'ideas',
}
const importedCounts = computed(() =>
  Object.entries(masterResult.value?.counts || {}).filter(([, v]) => v > 0))
</script>

<template>
  <div class="max-w-3xl mx-auto">
    <!-- Page header -->
    <div class="border-b border-ink-200 bg-white -mx-6 -mt-6 px-6 pt-5 pb-3 mb-6">
      <div class="flex items-center gap-1.5 text-[12px] text-ink-500 mb-2">
        <NuxtLink :to="`/companies/${id}`" class="hover:text-ink-700">Cap-table model</NuxtLink>
        <span class="text-ink-300">/</span>
        <span class="text-ink-700 font-medium">Import</span>
      </div>
      <div class="flex items-end justify-between gap-6 flex-wrap">
        <div class="min-w-0">
          <div class="flex items-center gap-3 flex-wrap">
            <h1 class="text-[22px] font-semibold text-ink-900 tracking-tight">Import your company</h1>
            <span class="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full bg-ink-100 text-ink-600 font-medium">
              <span class="w-1.5 h-1.5 rounded-full bg-ink-300"></span>
              {{ company?.name || '—' }}
            </span>
          </div>
          <p class="text-[13px] text-ink-500 mt-1 max-w-2xl">
            One workbook loads everything — Stakeholders, Holdings, Option grants, Convertibles, and
            Round history. Get a blank template, or bootstrap one from a Carta export, fill the gaps,
            then import it.
          </p>
        </div>
        <NuxtLink :to="`/companies/${id}/cap-table`">
          <UiButton variant="ghost" size="sm">Cancel</UiButton>
        </NuxtLink>
      </div>
    </div>

    <!-- Step 1: get a template -->
    <section class="rounded-xl border border-ink-200 bg-white shadow-[0_1px_0_rgba(16,24,40,0.04)] overflow-hidden mb-6">
      <div class="px-5 py-4 border-b border-ink-100">
        <h2 class="text-[15px] font-semibold text-ink-900"><span class="text-ink-400 font-normal">1 ·</span> Get your template</h2>
        <p class="text-[12.5px] text-ink-500 mt-1 max-w-xl">
          People are entered once on <span class="font-medium text-ink-700">Stakeholders</span>; other tabs reference them by name.
          On <span class="font-medium text-ink-700">Option grants</span>, set each row's Status to Issued, Proposed, or Idea.
        </p>
      </div>

      <div class="grid sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-ink-100">
        <!-- Blank -->
        <div class="px-5 py-4">
          <div class="flex items-center gap-2 text-ink-800">
            <FileSpreadsheet :size="16" class="text-brand-600" />
            <span class="text-[13px] font-medium">Start blank</span>
          </div>
          <p class="text-[12px] text-ink-500 mt-1">An empty workbook with all tabs, dropdowns, and an Instructions sheet.</p>
          <UiButton variant="secondary" size="sm" class="mt-3" @click="downloadTemplate"><Download :size="14" /> Download template</UiButton>
        </div>

        <!-- Prefill from Carta -->
        <div class="px-5 py-4">
          <div class="flex items-center gap-2 text-ink-800">
            <Sparkles :size="16" class="text-brand-600" />
            <span class="text-[13px] font-medium">Prefill from a Carta export</span>
          </div>
          <p class="text-[12px] text-ink-500 mt-1">Upload a Carta <code class="text-ink-700 bg-ink-100 px-1 py-px rounded text-[11px] num">.xlsx</code> — we fill in stakeholders, holdings, issued grants, convertibles, and round dates.</p>
          <div class="mt-3 flex items-center gap-2 flex-wrap">
            <label class="inline-flex items-center gap-2 text-[12.5px] text-ink-700 border border-ink-300 rounded-md px-3 py-1.5 cursor-pointer hover:border-ink-400 bg-white">
              <input type="file" accept=".xlsx,.xlsm" class="hidden" @change="onCartaPick">
              <UploadCloud :size="14" /> {{ cartaFile ? cartaFile.name : 'Choose Carta export…' }}
            </label>
            <UiButton v-if="cartaFile" size="sm" :disabled="prefilling" @click="prefillFromCarta">{{ prefilling ? 'Building…' : 'Build prefilled template' }}</UiButton>
          </div>
          <p v-if="prefillError" class="mt-2 text-[12px] text-red-600">{{ prefillError }}</p>
          <p v-if="prefilled" class="mt-2 text-[12px] text-ok inline-flex items-center gap-1"><CheckCircle2 :size="13" /> Downloaded — fill the gaps, then import below.</p>
        </div>
      </div>
    </section>

    <!-- Step 2: import the filled workbook -->
    <section class="rounded-xl border border-ink-200 bg-white shadow-[0_1px_0_rgba(16,24,40,0.04)] overflow-hidden">
      <div class="px-5 py-4 border-b border-ink-100">
        <h2 class="text-[15px] font-semibold text-ink-900"><span class="text-ink-400 font-normal">2 ·</span> Import your filled workbook</h2>
        <p class="text-[12.5px] text-ink-500 mt-1 max-w-xl">Best for a fresh company. Stakeholders and share classes upsert by name, so re-running won't duplicate them.</p>
      </div>
      <div class="px-5 py-4">
        <div class="flex items-center gap-3 flex-wrap">
          <label class="inline-flex items-center gap-2 text-[12.5px] text-ink-700 border border-ink-300 rounded-md px-3 py-1.5 cursor-pointer hover:border-ink-400 bg-white">
            <UploadCloud :size="14" /> {{ masterFile ? masterFile.name : 'Choose filled workbook…' }}
            <input type="file" accept=".xlsx" class="hidden" @change="onMasterPick">
          </label>
          <UiButton v-if="masterFile" size="sm" :disabled="masterUploading" @click="uploadMaster">{{ masterUploading ? 'Importing…' : 'Import workbook' }}</UiButton>
        </div>
        <p v-if="masterError" class="mt-2 text-[12px] text-red-600">{{ masterError }}</p>

        <div v-if="masterResult" class="mt-4 rounded-lg border border-ok/30 bg-ok-soft/40 px-4 py-3">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div class="flex items-center gap-2">
              <CheckCircle2 v-if="masterResult.ok" :size="16" class="text-ok" />
              <AlertTriangle v-else :size="16" class="text-warn" />
              <h3 class="text-[13px] font-semibold text-ink-900">{{ masterResult.ok ? 'Import complete' : 'Imported with issues' }}</h3>
            </div>
            <NuxtLink :to="`/companies/${id}/cap-table`"><UiButton variant="primary" size="sm">Go to Financings <ArrowRight :size="13" /></UiButton></NuxtLink>
          </div>
          <div class="mt-2 flex flex-wrap gap-1.5 num">
            <span v-for="[k, v] in importedCounts" :key="k" class="inline-flex items-center text-[12px] px-2 py-0.5 rounded bg-white border border-ok/30 text-ink-700">
              {{ v }} {{ countLabels[k] || k }}
            </span>
          </div>
          <ul v-if="masterResult.warnings?.length" class="mt-2 space-y-0.5 text-[11.5px] text-amber-700 num">
            <li v-for="(w, i) in masterResult.warnings" :key="i">— {{ w }}</li>
          </ul>
        </div>
      </div>
    </section>
  </div>
</template>
