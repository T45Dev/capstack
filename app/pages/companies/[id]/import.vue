<script setup lang="ts">
import { UploadCloud, CheckCircle2, AlertTriangle } from 'lucide-vue-next'

const route = useRoute()
const id = computed(() => route.params.id as string)

const { data: company } = await useFetch(() => `/api/companies/${id.value}`, { watch: [id] })

const file = ref<File | null>(null)
const dragging = ref(false)
const replace = ref(true)
const uploading = ref(false)
const result = ref<{ ok: boolean; counts: Record<string, number>; warnings: string[] } | null>(null)
const error = ref<string | null>(null)

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
</script>

<template>
  <div class="max-w-2xl mx-auto">
    <h1 class="text-xl font-semibold tracking-tight text-ink-900">Import cap table</h1>
    <p class="text-sm text-ink-600 mt-1">
      Upload a Carta <code class="text-ink-900 bg-ink-200 px-1 rounded">.xlsx</code> pro-forma export for <span class="text-ink-900 font-medium">{{ company?.name }}</span>.
      CapStack parses the Detailed Cap Table, Summary Cap Table, and Convertible Notes sheets.
    </p>

    <UiCard class="mt-6">
      <div
        class="rounded-md border-2 border-dashed transition-colors p-8 text-center"
        :class="dragging ? 'border-accent-500 bg-accent-50' : 'border-ink-300 bg-ink-100/50'"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <UploadCloud :size="32" class="mx-auto text-ink-500" />
        <p class="mt-3 text-sm text-ink-800">
          <span class="font-medium">Drop .xlsx here</span> or
          <label class="text-accent-600 hover:text-accent-700 cursor-pointer underline font-medium">
            browse
            <input type="file" accept=".xlsx,.xlsm" class="hidden" @change="onPick" />
          </label>
        </p>
        <p v-if="file" class="mt-2 text-xs text-ink-700">{{ file.name }} ({{ Math.round(file.size / 1024) }} KB)</p>
      </div>

      <div class="mt-4 flex items-center justify-between gap-3">
        <label class="text-sm text-ink-700 inline-flex items-center gap-2">
          <input type="checkbox" v-model="replace" class="rounded border-ink-400 text-accent-500 focus:ring-accent-500" />
          Replace existing data (recommended for fresh exports)
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
