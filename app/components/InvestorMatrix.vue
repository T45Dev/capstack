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
interface MatrixResponse {
  rounds: MatrixRound[]
  investors: MatrixInvestor[]
  matrix: Record<string, Record<string, Cell>>
  sums: Record<string, { allocated: number; new_money: number; delta: number }>
}

const companyId = computed(() => props.companyId)
const { data, refresh } = await useFetch<MatrixResponse>(() => `/api/companies/${companyId.value}/investor-matrix`, {
  watch: [companyId],
  default: () => ({ rounds: [], investors: [], matrix: {}, sums: {} }),
})

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
  return pps > 0 ? amt / pps : 0
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

// Total invested per investor (sum across rounds).
function totalForInvestor(inv: MatrixInvestor): number {
  let sum = 0
  const matrix = data.value?.matrix || {}
  for (const r of data.value?.rounds || []) {
    const amt = drafts.value[r.id]?.[inv.id] ?? matrix[r.id]?.[inv.id]?.amount ?? 0
    sum += amt
  }
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
  if (Math.abs(delta) < 1) return 'text-emerald-700'
  return 'text-amber-700'
}
</script>

<template>
  <UiCard title="Investors by round" subtitle="Type each investor's contribution per round. Sums reconcile against each round's new money; mismatches show in amber." :padded="false">
    <div v-if="!(data?.rounds.length)" class="px-4 py-8 text-center text-sm text-ink-500">
      Add a round above to start attributing investors.
    </div>
    <div v-else class="overflow-x-auto">
      <table class="text-[12px] border-separate" style="border-spacing: 0; min-width: 100%;">
        <colgroup>
          <col style="width: 220px" />
          <col v-for="r in data.rounds" :key="r.id" style="min-width: 140px" />
          <col style="width: 130px" />
          <col style="width: 40px" />
        </colgroup>
        <thead class="text-ink-700 bg-ink-100">
          <tr>
            <th class="px-3 py-2 border-b border-ink-300 text-left text-[11px] font-semibold uppercase tracking-wide sticky left-0 z-10 bg-ink-100">Investor</th>
            <th
              v-for="r in data.rounds"
              :key="r.id"
              class="px-3 py-2 border-b border-ink-300 text-right text-[11px] font-semibold"
              :class="r.kind === 'open' ? 'bg-accent-50 text-accent-700' : 'text-ink-700'"
            >
              <div class="font-semibold">{{ r.name || r.code }}</div>
              <div class="text-[9px] font-normal text-ink-500">{{ r.close_date || '—' }}<span v-if="r.kind === 'open'" class="ml-1 uppercase tracking-wider text-accent-600">Open</span></div>
            </th>
            <th class="px-3 py-2 border-b border-ink-300 text-right text-[11px] font-semibold text-ink-700">Total invested</th>
            <th class="px-3 py-2 border-b border-ink-300"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="inv in sortedInvestors" :key="inv.id" class="hover:bg-accent-50/30 transition-colors">
            <td class="px-3 py-1.5 border-b border-ink-200 text-ink-900 font-medium sticky left-0 z-10 bg-white" :title="inv.type || ''">
              {{ inv.name }}
              <span v-if="inv.type && inv.type !== 'Investor'" class="ml-1.5 text-[9px] uppercase tracking-wide text-ink-500">{{ inv.type }}</span>
            </td>
            <td
              v-for="r in data.rounds"
              :key="r.id"
              class="px-3 py-1.5 border-b border-ink-200 text-right text-ink-700"
              :class="r.kind === 'open' ? 'bg-accent-50/40' : ''"
            >
              <NumberInput
                variant="bare"
                prefix="$"
                :model-value="cellAmount(r.id, inv.id)"
                placeholder="—"
                input-class="w-full bg-amber-50 border border-amber-300 hover:border-amber-500 focus:border-accent-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-accent-500 rounded px-1 py-0.5 text-right text-[12px] text-ink-900 num"
                @update:model-value="(v) => setDraft(r.id, inv.id, v)"
                @blur="() => commitCell(r.id, inv.id)"
                @keydown.enter="(e: KeyboardEvent) => (e.target as HTMLInputElement).blur()"
              />
              <div v-if="cellShares(r.id, inv.id) > 0" class="text-[9px] text-ink-400 num">{{ fmtShares(cellShares(r.id, inv.id)) }} sh</div>
            </td>
            <td class="px-3 py-1.5 border-b border-ink-200 text-right font-medium text-ink-900 num">
              {{ totalForInvestor(inv) > 0 ? fmtUSD(totalForInvestor(inv)) : '—' }}
            </td>
            <td class="px-3 py-1.5 border-b border-ink-200 text-center">
              <button
                type="button"
                class="text-ink-400 hover:text-red-600 transition-colors p-0.5 rounded hover:bg-red-50"
                title="Remove all of this investor's round allocations"
                @click="removeInvestor(inv)"
              ><Trash2 :size="13" /></button>
            </td>
          </tr>
          <!-- Add-investor row -->
          <tr class="bg-ink-50/40">
            <td class="px-3 py-1.5 border-b border-ink-200 sticky left-0 z-10 bg-ink-50/80">
              <input
                v-model="newName"
                type="text"
                placeholder="+ Add investor"
                class="w-full bg-transparent border border-transparent hover:border-ink-300 focus:border-accent-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-accent-500 rounded px-1 py-0.5 text-[12px] text-ink-900"
                @keydown.enter="addInvestor"
              />
            </td>
            <td v-for="r in data.rounds" :key="r.id" class="px-3 py-1.5 border-b border-ink-200 text-right" :class="r.kind === 'open' ? 'bg-accent-50/30' : ''">
              <NumberInput
                v-if="newName.trim()"
                variant="bare"
                prefix="$"
                :model-value="newAmounts[r.id] || null"
                placeholder="—"
                input-class="w-full bg-amber-50 border border-amber-300 hover:border-amber-500 focus:border-accent-500 focus:bg-white focus:outline-none focus:ring-1 focus:ring-accent-500 rounded px-1 py-0.5 text-right text-[12px] text-ink-900 num"
                @update:model-value="(v) => (newAmounts[r.id] = v || 0)"
              />
            </td>
            <td class="px-3 py-1.5 border-b border-ink-200 text-right">
              <button
                v-if="newName.trim()"
                type="button"
                class="inline-flex items-center gap-1 text-[11px] text-accent-700 hover:text-accent-800 font-medium px-2 py-0.5 rounded border border-accent-300 hover:bg-accent-50"
                @click="addInvestor"
              ><Plus :size="11" /> Add</button>
            </td>
            <td />
          </tr>
        </tbody>
        <tfoot>
          <tr class="bg-ink-100/70 font-medium">
            <td class="px-3 py-2 border-t-2 border-ink-300 text-ink-700 text-right pr-6 sticky left-0 z-10 bg-ink-100/70">Allocated</td>
            <td
              v-for="r in data.rounds"
              :key="r.id"
              class="px-3 py-2 border-t-2 border-ink-300 text-right"
              :class="[r.kind === 'open' ? 'bg-accent-50/40' : '', sumDeltaClass(data.sums[r.id]?.delta ?? 0, r.new_money)]"
            >
              {{ fmtUSD(data.sums[r.id]?.allocated ?? 0) }}
            </td>
            <td class="px-3 py-2 border-t-2 border-ink-300" colspan="2"></td>
          </tr>
          <tr class="text-[11px] text-ink-600">
            <td class="px-3 py-1 text-right pr-6 sticky left-0 z-10 bg-white">New money on round</td>
            <td v-for="r in data.rounds" :key="r.id" class="px-3 py-1 text-right num" :class="r.kind === 'open' ? 'bg-accent-50/40' : ''">{{ fmtUSD(r.new_money) }}</td>
            <td colspan="2"></td>
          </tr>
          <tr class="text-[11px]">
            <td class="px-3 py-1 text-right pr-6 sticky left-0 z-10 bg-white text-ink-500">Δ to allocate</td>
            <td
              v-for="r in data.rounds"
              :key="r.id"
              class="px-3 py-1 text-right num"
              :class="[r.kind === 'open' ? 'bg-accent-50/40' : '', sumDeltaClass(data.sums[r.id]?.delta ?? 0, r.new_money)]"
            >
              <span v-if="Math.abs(data.sums[r.id]?.delta ?? 0) < 1">✓</span>
              <span v-else class="inline-flex items-center gap-1">
                <AlertTriangle :size="10" />
                {{ fmtUSD(data.sums[r.id]?.delta ?? 0) }}
              </span>
            </td>
            <td colspan="2"></td>
          </tr>
        </tfoot>
      </table>
    </div>
    <p class="px-4 py-2 text-[11px] text-ink-500 bg-ink-50/60 border-t border-ink-200">
      Shares per cell = $ ÷ round share price. Per-round Δ stays green when the allocations sum to the round's New money on the Summary card above.
    </p>
  </UiCard>
</template>
