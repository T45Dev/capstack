<script setup lang="ts">
// Bulk import of preferred shareholders. Paste a tab/space-separated
// list of (name, shares, [dollars]) and submit. Imported holders are
// merged into stakeholders and given holdings in a synthetic
// "Previous Preferred" share class so they show up in the dilution
// view and anywhere else that reads holdings.
import { X, Upload, AlertTriangle, CheckCircle2 } from 'lucide-vue-next'
import { fmtShares, fmtUSD } from '~/utils/format'

const props = defineProps<{ companyId: string; open: boolean }>()
const emit = defineEmits<{ close: []; imported: [{ created_stakeholders: number; updated_holdings: number }] }>()

const pasted = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)
const result = ref<{ created_stakeholders: number; updated_holdings: number } | null>(null)

interface Row { name: string; shares: number; dollars: number | null; warn?: string }

// Split each line on tabs OR runs of 2+ whitespace. Names can contain
// single spaces ("VCT Investments") so single whitespace can't be a
// delimiter. After splitting, column 1 = name, column 2 = shares,
// column 3 (optional) = dollars. Numeric columns strip $ and commas.
const parsedRows = computed<Row[]>(() => {
  const text = pasted.value.replace(/\r/g, '')
  if (!text.trim()) return []
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const out: Row[] = []
  for (const line of lines) {
    const cells = line.split(/\t+|\s{2,}/).map(c => c.trim()).filter(Boolean)
    if (cells.length < 2) {
      out.push({ name: cells[0] || '', shares: 0, dollars: null, warn: 'Need at least name and shares' })
      continue
    }
    const name = cells[0] || ''
    const rawShares = cells[1] || ''
    const sharesNum = Number(rawShares.replace(/[$,\s]/g, ''))
    if (!isFinite(sharesNum) || sharesNum <= 0) {
      // First line might be a header — skip silently if both name and
      // shares look non-numeric.
      if (out.length === 0 && /[a-zA-Z]/.test(rawShares)) continue
      out.push({ name, shares: 0, dollars: null, warn: `"${rawShares}" isn't a valid share count` })
      continue
    }
    let dollars: number | null = null
    if (cells[2]) {
      const dn = Number(cells[2].replace(/[$,\s]/g, ''))
      if (isFinite(dn) && dn > 0) dollars = dn
    }
    out.push({ name, shares: Math.floor(sharesNum), dollars })
  }
  return out
})

const validRows = computed(() => parsedRows.value.filter(r => !r.warn && r.shares > 0))
const warnRows = computed(() => parsedRows.value.filter(r => r.warn))
const totalShares = computed(() => validRows.value.reduce((a, r) => a + r.shares, 0))
const totalDollars = computed(() => validRows.value.reduce((a, r) => a + (r.dollars || 0), 0))

async function submit() {
  if (submitting.value || !validRows.value.length) return
  submitting.value = true
  error.value = null
  try {
    const r = await $fetch<{ created_stakeholders: number; updated_holdings: number }>(
      `/api/companies/${props.companyId}/import-preferred`,
      {
        method: 'POST',
        body: { holders: validRows.value.map(r => ({ name: r.name, shares: r.shares, dollars: r.dollars })) },
      },
    )
    result.value = r
    emit('imported', r)
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || 'Import failed'
  } finally {
    submitting.value = false
  }
}

function reset() {
  pasted.value = ''
  result.value = null
  error.value = null
}

function close() {
  emit('close')
  // Defer the reset so the modal's closing animation doesn't flash empty state.
  setTimeout(reset, 200)
}

// Example data block for the placeholder. Two columns of demo data —
// shows the expected paste format without forcing a header row.
const examplePlaceholder = `VCT Investments\t1,250,000\t$5,000,000
Acme Ventures\t   500,000\t$2,000,000
T45 Labs\t       250,000\t$1,000,000`
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-50 bg-ink-900/40 flex items-center justify-center p-4" @click.self="close">
      <div class="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <header class="px-5 py-3 border-b border-ink-200 flex items-center justify-between gap-3">
          <div>
            <h2 class="text-[15px] font-semibold text-ink-900">Import preferred shareholders</h2>
            <p class="text-[12px] text-ink-500 leading-tight mt-0.5">Paste name + shares + optional $ from a spreadsheet. Replaces existing holdings in the synthetic "Previous Preferred" share class.</p>
          </div>
          <button class="text-ink-400 hover:text-ink-700 p-1 rounded hover:bg-ink-100" @click="close"><X :size="16" /></button>
        </header>

        <div class="px-5 py-4 flex-1 overflow-y-auto space-y-4">
          <!-- Success state -->
          <div v-if="result" class="border border-ok/30 bg-ok-soft text-ink-800 px-4 py-3 rounded-lg flex items-start gap-2.5">
            <CheckCircle2 :size="18" class="text-ok shrink-0 mt-0.5" />
            <div class="text-[13px]">
              Imported <span class="font-semibold">{{ result.updated_holdings }}</span> preferred holders
              ({{ result.created_stakeholders }} new stakeholder{{ result.created_stakeholders === 1 ? '' : 's' }}).
              They now show up in the dilution view and anywhere else that reads from holdings.
            </div>
          </div>

          <!-- Input + preview -->
          <div v-else>
            <label class="block text-[12px] font-medium text-ink-700 mb-1">Paste TSV / spreadsheet rows</label>
            <textarea
              v-model="pasted"
              class="w-full h-44 px-3 py-2 text-[12.5px] border border-ink-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand/30 num"
              :placeholder="examplePlaceholder"
              spellcheck="false"
            />
            <p class="text-[11px] text-ink-400 mt-1">
              One holder per line. Columns: <span class="font-medium text-ink-600">name</span>, <span class="font-medium text-ink-600">shares</span>, <span class="font-medium text-ink-600">$ invested</span> (optional). Separate with tabs or 2+ spaces — copy-paste from Excel/Sheets works directly.
            </p>

            <!-- Preview table -->
            <div v-if="parsedRows.length" class="mt-4 border border-ink-200 rounded-md overflow-hidden">
              <table class="text-[12.5px] num">
                <thead class="bg-ink-50 text-[10px] uppercase tracking-wider text-ink-500 font-semibold">
                  <tr>
                    <th class="px-3 py-1.5 text-left">Name</th>
                    <th class="px-3 py-1.5 text-right">Shares</th>
                    <th class="px-3 py-1.5 text-right">$ invested</th>
                    <th class="px-3 py-1.5 text-left w-6"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(r, i) in parsedRows" :key="i" :class="r.warn ? 'bg-warn-soft/30' : ''">
                    <td class="px-3 py-1 text-ink-900">{{ r.name || '—' }}</td>
                    <td class="px-3 py-1 text-right text-ink-700">{{ r.shares ? fmtShares(r.shares) : '—' }}</td>
                    <td class="px-3 py-1 text-right text-ink-500">{{ r.dollars ? fmtUSD(r.dollars) : '—' }}</td>
                    <td class="px-3 py-1 text-right">
                      <AlertTriangle v-if="r.warn" :size="12" class="text-warn-edge" :title="r.warn" />
                    </td>
                  </tr>
                </tbody>
                <tfoot class="bg-ink-50/60">
                  <tr class="text-[11px] text-ink-500">
                    <td class="px-3 py-1.5 font-semibold uppercase tracking-[0.06em]">Total ({{ validRows.length }})</td>
                    <td class="px-3 py-1.5 text-right font-semibold text-ink-900">{{ fmtShares(totalShares) }}</td>
                    <td class="px-3 py-1.5 text-right font-semibold text-ink-900">{{ totalDollars ? fmtUSD(totalDollars) : '—' }}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div v-if="warnRows.length" class="mt-2 text-[11.5px] text-warn-edge flex items-start gap-1.5">
              <AlertTriangle :size="12" class="shrink-0 mt-0.5" />
              <span>{{ warnRows.length }} row{{ warnRows.length === 1 ? '' : 's' }} couldn't be parsed — they'll be skipped.</span>
            </div>

            <div v-if="error" class="mt-3 px-3 py-2 border border-red-300 bg-red-50 text-red-700 text-[12.5px] rounded-md">
              {{ error }}
            </div>
          </div>
        </div>

        <footer class="px-5 py-3 border-t border-ink-200 bg-ink-50/40 flex items-center justify-end gap-2">
          <button class="px-3 py-1.5 text-[12.5px] text-ink-700 hover:bg-ink-100 rounded-md" @click="close">{{ result ? 'Done' : 'Cancel' }}</button>
          <UiButton v-if="!result" variant="primary" size="md" :disabled="!validRows.length || submitting" @click="submit">
            <Upload :size="13" />
            {{ submitting ? 'Importing…' : `Import ${validRows.length || ''}` }}
          </UiButton>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
