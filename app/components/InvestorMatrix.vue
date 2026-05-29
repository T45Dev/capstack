<script setup lang="ts">
// Investors-by-round matrix — embedded on the Financings page below the
// Financings table. Mirrors the per-investor allocation pattern from the
// reference ANT Pro Forma spreadsheet: every named investor gets their own
// row, every round is a column, each cell is the $ amount that investor
// contributed in that round. Sum-per-round reconciles against the round's
// new_money so the user can spot a missing allocation at a glance.
//
// Adding a new investor: type a name in the bottom row, hit Enter or any
// cell, and the API auto-creates the stakeholder.
import { Trash2, Plus, AlertTriangle } from 'lucide-vue-next'
import { fmtUSD, fmtShares } from '~/utils/format'

const props = defineProps<{ companyId: string }>()
const emit = defineEmits<{ refreshed: [] }>()

interface MatrixRound { id: string; code: string; name: string | null; kind: 'formation' | 'closed' | 'open'; close_date: string | null; share_price: number | null; new_money: number }
interface MatrixInvestor { id: string; name: string; type: string | null }
interface Cell { id: string; amount: number; shares: number; notes: string | null }
interface CnEntry { principal: number; accrued: number; total: number; notes: number }
interface MatrixResponse {
  rounds: MatrixRound[]
  investors: MatrixInvestor[]
  matrix: Record<string, Record<string, Cell>>
  sums: Record<string, { allocated: number; new_money: number; delta: number }>
  cn: Record<string, CnEntry>
  cn_total: number
}

const companyId = computed(() => props.companyId)
const { data, refresh } = await useFetch<MatrixResponse>(() => `/api/companies/${companyId.value}/investor-matrix`, {
  watch: [companyId],
  default: () => ({ rounds: [], investors: [], matrix: {}, sums: {}, cn: {}, cn_total: 0 }),
})

function cnFor(stakeholderId: string): CnEntry | null {
  return data.value?.cn?.[stakeholderId] || null
}

// Local drafts so cell edits batch sensibly (one PATCH per blurred cell;
// no debouncing yet — the matrix is small enough that direct writes are
// fine, but using a draft buffer lets us avoid PATCHing on every keystroke).
const drafts = ref<Record<string, Record<string, number>>>({})
function draftKey(roundId: string, stakeholderId: string) {
  return `${roundId}::${stakeholderId}`
}
function cellAmount(roundId: string, stakeholderId: string): number | null {
  const d = drafts.value[roundId]?.[stakeholderId]
  if (d !== undefined) return d
  const cell = data.value?.matrix?.[roundId]?.[stakeholderId]
  return cell?.amount ?? null
}
function cellShares(roundId: string, stakeholderId: string): number {
  const amt = cellAmount(roundId, stakeholderId) || 0
  const r = data.value?.rounds.find(x => x.id === roundId)
  const pps = r?.share_price && r.share_price > 0 ? r.share_price : 0
  return pps > 0 ? Math.floor(amt / pps) : 0
}
function setDraft(roundId: string, stakeholderId: string, value: number | null) {
  const v = value ?? 0
  if (!drafts.value[roundId]) drafts.value[roundId] = {}
  drafts.value[roundId][stakeholderId] = v
}

async function commitCell(roundId: string, stakeholderId: string) {
  const v = drafts.value[roundId]?.[stakeholderId]
  if (v === undefined) return  // no edit
  const existing = data.value?.matrix?.[roundId]?.[stakeholderId]
  try {
    if (existing) {
      if (v === 0) {
        await $fetch(`/api/round-investors/${existing.id}`, { method: 'DELETE' })
      } else {
        await $fetch(`/api/round-investors/${existing.id}`, {
          method: 'PATCH', body: { amount: v },
        })
      }
    } else if (v > 0) {
      await $fetch(`/api/rounds/${roundId}/investors`, {
        method: 'POST', body: { stakeholder_id: stakeholderId, amount: v },
      })
    }
    // Drop the draft on success; refresh pulls the canonical value.
    delete drafts.value[roundId][stakeholderId]
    if (Object.keys(drafts.value[roundId]).length === 0) delete drafts.value[roundId]
    await refresh()
    emit('refreshed')
  } catch (e) {
    console.error('Failed to save cell', e)
  }
}

// Adding a new investor — type a name + initial amounts.
const newName = ref('')
const newAmounts = ref<Record<string, number>>({})
async function addInvestor() {
  const name = newName.value.trim()
  if (!name) return
  // Find the first round with a non-zero amount; create that one first
  // (which auto-creates the stakeholder), then add the rest.
  const rounds = data.value?.rounds || []
  const entries = rounds
    .map(r => ({ roundId: r.id, amount: newAmounts.value[r.id] || 0 }))
    .filter(e => e.amount > 0)
  if (!entries.length) {
    // Create the stakeholder with a zero allocation on the open round (or
    // the latest round) so they at least appear in the list.
    const target = rounds.find(r => r.kind === 'open') || rounds[rounds.length - 1]
    if (!target) return
    await $fetch(`/api/rounds/${target.id}/investors`, {
      method: 'POST', body: { stakeholder_name: name, amount: 0 },
    })
  } else {
    // First POST creates the stakeholder; capture the returned id.
    const first = entries[0]!
    const res: any = await $fetch(`/api/rounds/${first.roundId}/investors`, {
      method: 'POST', body: { stakeholder_name: name, amount: first.amount },
    })
    const stakeholderId = res?.stakeholder_id
    for (const e of entries.slice(1)) {
      if (!stakeholderId) break
      await $fetch(`/api/rounds/${e.roundId}/investors`, {
        method: 'POST', body: { stakeholder_id: stakeholderId, amount: e.amount },
      })
    }
  }
  newName.value = ''
  newAmounts.value = {}
  await refresh()
  emit('refreshed')
}

async function removeInvestor(inv: MatrixInvestor) {
  if (!confirm(`Remove all of ${inv.name}'s round allocations? (The stakeholder stays in the cap table.)`)) return
  const matrix = data.value?.matrix || {}
  const rounds = data.value?.rounds || []
  for (const r of rounds) {
    const cell = matrix[r.id]?.[inv.id]
    if (cell?.id) await $fetch(`/api/round-investors/${cell.id}`, { method: 'DELETE' })
  }
  await refresh()
  emit('refreshed')
}

// Total invested per investor — sum across rounds, plus outstanding
// CN principal + accrued interest. The CN total is paper-money the
// investor has on the table (not yet converted), but it counts in the
// "total invested" view because it'll fold into a round at close.
function totalForInvestor(inv: MatrixInvestor): number {
  let sum = 0
  const matrix = data.value?.matrix || {}
  for (const r of data.value?.rounds || []) {
    const amt = drafts.value[r.id]?.[inv.id] ?? matrix[r.id]?.[inv.id]?.amount ?? 0
    sum += amt
  }
  sum += cnFor(inv.id)?.total || 0
  return sum
}

// Sorted investors — biggest cheque first by default.
const sortedInvestors = computed<MatrixInvestor[]>(() => {
  const list = [...(data.value?.investors || [])]
  list.sort((a, b) => totalForInvestor(b) - totalForInvestor(a))
  return list
})

function sumDeltaClass(delta: number, newMoney: number): string {
  if (!newMoney) return 'text-ink-500'
  if (Math.abs(delta) < 1) return 'text-ok'
  return 'text-warn'
}
</script>

<template>
  <div class="border border-ink-200 rounded-lg bg-white overflow-hidden shadow-[0_1px_0_rgba(16,24,40,0.04)]">
    <div v-if="!(data?.rounds.length)" class="px-4 py-10 text-center text-sm text-ink-500">
      Add a round on the Rounds tab to start attributing investors.
    </div>
    <div v-else class="overflow-x-auto">
      <table class="border-separate w-full" :style="{ borderSpacing: 0 }">
        <colgroup>
          <col style="width: 220px" />
          <col v-for="r in data.rounds" :key="r.id" style="min-width: 150px" />
          <col style="width: 130px" /> <!-- CN column -->
          <col style="width: 140px" />
          <col style="width: 40px" />
        </colgroup>
        <thead class="bg-ink-50/60">
          <tr>
            <th class="px-3 py-2 border-b border-ink-200 text-left sticky left-0 z-20 bg-ink-50/95 backdrop-blur shadow-[1px_0_0_0_rgb(0_0_0/0.06)]">
              <span class="text-[10.5px] uppercase tracking-[0.08em] text-ink-500 font-semibold">Investor</span>
            </th>
            <th
              v-for="r in data.rounds"
              :key="r.id"
              class="px-3 py-2 border-b border-ink-200 text-right"
              :class="r.kind === 'open' ? 'bg-brand-soft/40' : ''"
            >
              <div class="flex items-center justify-end gap-1.5">
                <span class="text-[11.5px] font-medium" :class="r.kind === 'open' ? 'text-brand-edge' : 'text-ink-700'">{{ r.name || r.code }}</span>
                <span v-if="r.kind === 'open'" class="text-[9px] uppercase tracking-wider text-brand-edge font-semibold">Open</span>
              </div>
              <div class="text-[10px] text-ink-400 num text-right mt-0.5">{{ r.close_date || '—' }}</div>
            </th>
            <th class="px-3 py-2 border-b border-ink-200 text-right bg-amber-50/40">
              <div class="flex items-center justify-end gap-1.5">
                <span class="text-[11.5px] font-medium text-amber-700">Convertible notes</span>
              </div>
              <div class="text-[10px] text-ink-400 mt-0.5">principal + accrued</div>
            </th>
            <th class="px-3 py-2 border-b border-ink-200 text-right">
              <span class="text-[10.5px] uppercase tracking-[0.08em] text-ink-500 font-semibold">Total invested</span>
            </th>
            <th class="px-3 py-2 border-b border-ink-200"></th>
          </tr>
        </thead>
        <tbody class="num">
          <tr v-for="inv in sortedInvestors" :key="inv.id" class="hover:bg-ink-50/40 transition-colors border-b border-ink-100 last:border-b-0">
            <td class="px-3 py-1.5 text-ink-900 font-medium sticky left-0 z-10 bg-white" :title="inv.type || ''">
              <span class="text-[13px]">{{ inv.name }}</span>
              <span v-if="inv.type && inv.type !== 'Investor'" class="ml-1.5 text-[9px] uppercase tracking-wide text-ink-500">{{ inv.type }}</span>
            </td>
            <td
              v-for="r in data.rounds"
              :key="r.id"
              class="px-2 py-1.5 align-middle"
              :class="r.kind === 'open' ? 'bg-brand-soft/20' : ''"
            >
              <label class="cell-edit block">
                <NumberInput
                  variant="bare"
                  prefix="$"
                  :model-value="cellAmount(r.id, inv.id)"
                  placeholder="—"
                  input-class="num text-[13px] bg-transparent text-right"
                  @update:model-value="(v) => setDraft(r.id, inv.id, v)"
                  @blur="() => commitCell(r.id, inv.id)"
                  @keydown.enter="(e: KeyboardEvent) => (e.target as HTMLInputElement).blur()"
                />
              </label>
              <div v-if="cellShares(r.id, inv.id) > 0" class="text-[10px] text-ink-400 num text-right mt-0.5">{{ fmtShares(cellShares(r.id, inv.id)) }} sh</div>
            </td>
            <!-- CN total per investor. Read-only — CN data lives on the
                 Convertible-notes ledger; this column is a roll-up so
                 the operator can see paper money alongside cash on the
                 same row. -->
            <td class="px-3 py-1.5 text-right bg-amber-50/30">
              <template v-if="cnFor(inv.id)?.total">
                <div class="text-[13px] num font-medium text-amber-800"
                  :title="`${cnFor(inv.id)?.notes ?? 0} note${(cnFor(inv.id)?.notes ?? 0) === 1 ? '' : 's'} · principal ${fmtUSD(cnFor(inv.id)?.principal ?? 0)} + accrued ${fmtUSD(cnFor(inv.id)?.accrued ?? 0)}`">
                  {{ fmtUSD(cnFor(inv.id)?.total ?? 0) }}
                </div>
                <div v-if="(cnFor(inv.id)?.notes ?? 0) > 1" class="text-[10px] text-amber-600 mt-0.5">{{ cnFor(inv.id)?.notes }} notes</div>
              </template>
              <span v-else class="text-ink-300 text-[12px]">—</span>
            </td>
            <td class="px-3 py-1.5 text-right font-semibold text-ink-900 text-[13px]">
              {{ totalForInvestor(inv) > 0 ? fmtUSD(totalForInvestor(inv)) : '—' }}
            </td>
            <td class="px-2 py-1.5 text-center">
              <button
                type="button"
                class="text-ink-400 hover:text-red-600 transition-colors p-0.5 rounded hover:bg-red-50"
                title="Remove all of this investor's round allocations"
                @click="removeInvestor(inv)"
              ><Trash2 :size="13" /></button>
            </td>
          </tr>
          <!-- Add-investor row -->
          <tr class="bg-ink-50/30 border-b border-ink-100">
            <td class="px-3 py-1.5 sticky left-0 z-10 bg-ink-50/95">
              <input
                v-model="newName"
                type="text"
                placeholder="+ Add investor"
                class="w-full bg-transparent border border-transparent hover:border-ink-200 focus:border-brand focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand/15 rounded px-1.5 py-1 text-[13px] text-ink-900"
                @keydown.enter="addInvestor"
              />
            </td>
            <td v-for="r in data.rounds" :key="r.id" class="px-2 py-1.5 align-middle" :class="r.kind === 'open' ? 'bg-brand-soft/20' : ''">
              <label v-if="newName.trim()" class="cell-edit block">
                <NumberInput
                  variant="bare"
                  prefix="$"
                  :model-value="newAmounts[r.id] || null"
                  placeholder="—"
                  input-class="num text-[13px] bg-transparent text-right"
                  @update:model-value="(v) => (newAmounts[r.id] = v || 0)"
                />
              </label>
            </td>
            <!-- CN column slot — no inline edit; notes live on the
                 Convertible-notes ledger. Kept empty so the column
                 alignment stays put on the add-investor row. -->
            <td class="px-2 py-1.5 bg-amber-50/30"></td>
            <td class="px-3 py-1.5 text-right">
              <button
                v-if="newName.trim()"
                type="button"
                class="inline-flex items-center gap-1 text-[11px] text-brand-edge hover:text-brand-deep font-medium px-2 py-1 rounded border border-brand-200 hover:bg-brand-soft"
                @click="addInvestor"
              ><Plus :size="11" /> Add</button>
            </td>
            <td />
          </tr>
        </tbody>
        <tfoot class="num">
          <tr class="bg-ink-50/60 border-t border-ink-200">
            <td class="px-3 py-2 text-right pr-6 sticky left-0 z-10 bg-ink-50/95 text-[10.5px] uppercase tracking-[0.06em] text-ink-500 font-semibold">Allocated</td>
            <td
              v-for="r in data.rounds"
              :key="r.id"
              class="px-3 py-2 text-right font-semibold text-[13px]"
              :class="[r.kind === 'open' ? 'bg-brand-soft/30' : '', sumDeltaClass(data.sums[r.id]?.delta ?? 0, r.new_money)]"
            >
              {{ fmtUSD(data.sums[r.id]?.allocated ?? 0) }}
            </td>
            <td class="px-3 py-2 text-right font-semibold text-amber-800 text-[13px] bg-amber-50/40">
              {{ data.cn_total ? fmtUSD(data.cn_total) : '—' }}
            </td>
            <td class="px-3 py-2" colspan="2"></td>
          </tr>
          <tr class="text-[11.5px] text-ink-500 border-t border-ink-100">
            <td class="px-3 py-1.5 text-right pr-6 sticky left-0 z-10 bg-white">New money on round</td>
            <td v-for="r in data.rounds" :key="r.id" class="px-3 py-1.5 text-right" :class="r.kind === 'open' ? 'bg-brand-soft/20' : ''">{{ fmtUSD(r.new_money) }}</td>
            <td class="px-3 py-1.5 bg-amber-50/20"></td>
            <td colspan="2"></td>
          </tr>
          <tr class="text-[11.5px] border-t border-ink-100">
            <td class="px-3 py-1.5 text-right pr-6 sticky left-0 z-10 bg-white text-ink-500">Δ to allocate</td>
            <td
              v-for="r in data.rounds"
              :key="r.id"
              class="px-3 py-1.5 text-right"
              :class="[r.kind === 'open' ? 'bg-brand-soft/20' : '', sumDeltaClass(data.sums[r.id]?.delta ?? 0, r.new_money)]"
            >
              <span v-if="Math.abs(data.sums[r.id]?.delta ?? 0) < 1">✓ reconciled</span>
              <span v-else class="inline-flex items-center gap-1">
                <AlertTriangle :size="10" />
                {{ fmtUSD(data.sums[r.id]?.delta ?? 0) }}
              </span>
            </td>
            <td class="px-3 py-1.5 bg-amber-50/20"></td>
            <td colspan="2"></td>
          </tr>
        </tfoot>
      </table>
    </div>
    <p v-if="data?.rounds.length" class="px-4 py-2 text-[11.5px] text-ink-500 bg-ink-50/50 border-t border-ink-100">
      Shares per cell = $ ÷ round share price. Per-round Δ goes green when the allocations sum to the round's New money on the Rounds tab.
    </p>
  </div>
</template>
