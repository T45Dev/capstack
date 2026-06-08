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
import { fmtUSD, fmtShares, fmtPricePerShare } from '~/utils/format'
import { calcSum } from '~/utils/calc'

const props = defineProps<{ companyId: string }>()
const emit = defineEmits<{ refreshed: [] }>()

interface MatrixRound {
  id: string; code: string; name: string | null
  kind: 'formation' | 'closed' | 'open'
  close_date: string | null; share_price: number | null
  new_money: number; preferred_issued: number
}
interface MatrixInvestor { id: string; name: string; type: string | null }
interface Cell { id: string; amount: number; shares: number; notes: string | null }
interface CnEntry { principal: number; accrued: number; total: number; notes: number }
interface RoundSums {
  allocated: number; new_money: number; delta: number
  allocated_shares: number; preferred_issued: number; delta_shares: number
}
interface MatrixResponse {
  rounds: MatrixRound[]
  investors: MatrixInvestor[]
  matrix: Record<string, Record<string, Cell>>
  sums: Record<string, RoundSums>
  cn: Record<string, CnEntry>
  cn_total: number
}

const companyId = computed(() => props.companyId)
const { data, refresh } = await useFetch<MatrixResponse>(() => `/api/companies/${companyId.value}/investor-matrix`, {
  watch: [companyId],
  default: () => ({ rounds: [], investors: [], matrix: {}, sums: {}, cn: {}, cn_total: 0 } as MatrixResponse),
})

function cnFor(stakeholderId: string): CnEntry | null {
  return data.value?.cn?.[stakeholderId] || null
}

// Resizable columns — widths only (the matrix keeps its own sort). The round
// columns are dynamic, so re-sync the width list when they change, preserving
// any widths the operator has dragged.
const colsTable = useSortableTable({ key: 'capstack:investor-matrix:widths', columns: [] })
watch(() => data.value?.rounds, (rounds) => {
  const defs = [
    { key: 'investor', label: 'Investor', width: 220, sortable: false, align: 'left' as const },
    ...(rounds || []).map(r => ({ key: r.id, label: r.code, width: 150, sortable: false, align: 'right' as const })),
    { key: 'cn', label: 'CN', width: 130, sortable: false, align: 'right' as const },
    { key: 'total', label: 'Total', width: 140, sortable: false, align: 'right' as const },
  ]
  const widthMap: Record<string, number> = {}
  for (const c of colsTable.cols) widthMap[c.key] = c.width
  colsTable.cols.splice(0, colsTable.cols.length, ...defs.map(d => ({ ...d, width: widthMap[d.key] ?? d.width })))
}, { immediate: true, deep: true })

// Local drafts buffer cell edits so we commit one PATCH per blurred
// cell. Stored as AMOUNTS ($) since that's what round_investors holds;
// when the operator edits shares we convert via the round's
// share_price before saving.
const drafts = ref<Record<string, Record<string, number>>>({})
function ppsForRound(roundId: string): number {
  const r = data.value?.rounds.find(x => x.id === roundId)
  return r?.share_price && r.share_price > 0 ? r.share_price : 0
}
function cellAmount(roundId: string, stakeholderId: string): number | null {
  const d = drafts.value[roundId]?.[stakeholderId]
  if (d !== undefined) return d
  const cell = data.value?.matrix?.[roundId]?.[stakeholderId]
  return cell?.amount ?? null
}
function cellShares(roundId: string, stakeholderId: string): number {
  const amt = cellAmount(roundId, stakeholderId) || 0
  const pps = ppsForRound(roundId)
  return pps > 0 ? Math.floor(amt / pps) : 0
}
// Edit path: operator types SHARES; convert × share_price → amount
// for storage. Rounds with no share_price (the open round before the
// operator's typed one) fall back to amount-editing in the cell.
function setSharesDraft(roundId: string, stakeholderId: string, shares: number | null) {
  const pps = ppsForRound(roundId)
  if (!drafts.value[roundId]) drafts.value[roundId] = {}
  if (pps > 0) {
    drafts.value[roundId][stakeholderId] = (shares ?? 0) * pps
  } else {
    // No price set: treat the input as raw $ amount so the field is
    // still usable. The cell renders a small "set $/share" hint.
    drafts.value[roundId][stakeholderId] = shares ?? 0
  }
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
    const bucket = drafts.value[roundId]
    if (bucket) {
      delete bucket[stakeholderId]
      if (Object.keys(bucket).length === 0) delete drafts.value[roundId]
    }
    await refresh()
    emit('refreshed')
  } catch (e) {
    console.error('Failed to save cell', e)
  }
}

// Inline share-price setter. The matrix is shares-primary, so a round
// with no share_price can't render shares and its cells fall back to raw
// $. Rather than send the operator off to the round's card, the column
// header exposes a compact "$/share" input that PATCHes the round in
// place; once set, every cell in that column flips from $ to shares. The
// draft commits live via NumberInput's input event, so blur/Enter just
// flush whatever was typed.
const priceDrafts = ref<Record<string, number | null>>({})
async function savePrice(roundId: string) {
  const v = priceDrafts.value[roundId]
  if (v == null || v <= 0) { delete priceDrafts.value[roundId]; return }
  try {
    await $fetch(`/api/rounds/${roundId}`, { method: 'PATCH', body: { share_price: v } })
    delete priceDrafts.value[roundId]
    await refresh()
    emit('refreshed')
  } catch (e) {
    console.error('Failed to set share price', e)
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

// Total shares per investor across all rounds. CNs don't add to
// shares — they're paper money that converts later — so they get
// surfaced in a separate $ rollup.
function totalSharesForInvestor(inv: MatrixInvestor): number {
  let sum = 0
  for (const r of data.value?.rounds || []) sum += cellShares(r.id, inv.id)
  return sum
}
// Total $ per investor — sum across rounds (using live drafts) plus
// outstanding CN principal + accrued. Shown as a secondary number so
// the operator who still thinks in dollars has it in view.
function totalDollarsForInvestor(inv: MatrixInvestor): number {
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
  // Sort by total shares (matrix is shares-first); ties break on $.
  list.sort((a, b) => {
    const ds = totalSharesForInvestor(b) - totalSharesForInvestor(a)
    if (ds !== 0) return ds
    return totalDollarsForInvestor(b) - totalDollarsForInvestor(a)
  })
  return list
})

function sumDeltaClass(delta: number, newMoney: number): string {
  if (!newMoney) return 'text-ink-500'
  if (Math.abs(delta) < 1) return 'text-ok'
  return 'text-warn'
}

// Calc-tooltip strings — actual numbers behind each derived cell.
function fCnTotal(inv: MatrixInvestor): string | null {
  const cn = cnFor(inv.id)
  if (!cn?.total) return null
  return calcSum([['Principal', cn.principal || 0], ['Accrued', cn.accrued || 0]], fmtUSD)
}
function fTotalShares(inv: MatrixInvestor): string | null {
  const parts: Array<[string, number]> = []
  for (const r of data.value?.rounds || []) {
    const s = cellShares(r.id, inv.id)
    if (s > 0) parts.push([r.name || r.code, s])
  }
  return parts.length ? calcSum(parts) : null
}
function fRoundReconcile(r: MatrixRound): string {
  const alloc = data.value?.sums[r.id]?.allocated_shares ?? 0
  const exp = r.preferred_issued || 0
  const d = data.value?.sums[r.id]?.delta_shares ?? 0
  return `Allocated ${fmtShares(alloc)} − expects ${fmtShares(exp)} = ${fmtShares(d)}`
}
</script>

<template>
  <div class="border border-ink-200 rounded-lg bg-white overflow-hidden shadow-[0_1px_0_rgba(16,24,40,0.04)]">
    <div v-if="!(data?.rounds.length)" class="px-4 py-10 text-center text-sm text-ink-500">
      Add a round on the Rounds tab to start attributing investors.
    </div>
    <div v-else class="overflow-x-auto table-scroll">
      <table class="border-separate" :style="{ borderSpacing: 0 }">
        <TableColgroup :cols="colsTable.cols" :trailing="[40]" />
        <thead class="bg-ink-50/60">
          <tr>
            <th class="relative px-3 py-2 border-b border-ink-200 text-left sticky left-0 z-20 bg-ink-50/95 backdrop-blur shadow-[1px_0_0_0_rgb(0_0_0/0.06)]">
              <span class="text-[10.5px] uppercase tracking-[0.08em] text-ink-500 font-semibold">Investor</span>
              <span class="resize-handle" @mousedown.prevent.stop="colsTable.startResize($event, 'investor')" @click.stop />
            </th>
            <th
              v-for="r in data.rounds"
              :key="r.id"
              class="relative px-3 py-2 border-b border-ink-200 text-right"
              :class="r.kind === 'open' ? 'bg-brand-soft/40' : ''"
            >
              <div class="flex items-center justify-end gap-1.5">
                <span class="text-[11.5px] font-medium" :class="r.kind === 'open' ? 'text-brand-edge' : 'text-ink-700'">{{ r.name || r.code }}</span>
                <span v-if="r.kind === 'open'" class="text-[9px] uppercase tracking-wider text-brand-edge font-semibold">Open</span>
              </div>
              <div class="text-[10px] text-ink-400 num text-right mt-0.5">{{ r.close_date || '—' }}</div>
              <!-- Share price: muted when set; an inline amber setter when
                   not, so the operator can price a round without leaving
                   the matrix. Saving flips every cell in this column from
                   $ to shares. -->
              <div v-if="(r.share_price || 0) > 0" class="text-[10px] text-ink-400 num text-right mt-0.5">{{ fmtPricePerShare(r.share_price) }}/sh</div>
              <div v-else class="mt-1 flex items-center justify-end gap-1">
                <span class="text-[9px] uppercase tracking-wide text-amber-600 font-semibold">$/sh</span>
                <NumberInput
                  variant="bare"
                  prefix="$"
                  :digits="5"
                  :model-value="priceDrafts[r.id] ?? null"
                  placeholder="set price"
                  input-class="num text-[11px] text-right w-16 bg-amber-50 border border-amber-200 rounded px-1 py-0.5 text-amber-900 placeholder:text-amber-400 placeholder:not-italic focus:border-amber-400 focus:bg-white focus:outline-none"
                  @update:model-value="(v: number | null) => (priceDrafts[r.id] = v)"
                  @blur="() => savePrice(r.id)"
                  @keydown.enter="(e: KeyboardEvent) => (e.target as HTMLInputElement).blur()"
                />
              </div>
              <span class="resize-handle" @mousedown.prevent.stop="colsTable.startResize($event, r.id)" @click.stop />
            </th>
            <th class="relative px-3 py-2 border-b border-ink-200 text-right bg-amber-50/40">
              <div class="flex items-center justify-end gap-1.5">
                <span class="text-[11.5px] font-medium text-amber-700">Convertible notes</span>
              </div>
              <div class="text-[10px] text-ink-400 mt-0.5">principal + accrued</div>
              <span class="resize-handle" @mousedown.prevent.stop="colsTable.startResize($event, 'cn')" @click.stop />
            </th>
            <th class="relative px-3 py-2 border-b border-ink-200 text-right">
              <span class="text-[10.5px] uppercase tracking-[0.08em] text-ink-500 font-semibold">Total shares</span>
              <span class="resize-handle" @mousedown.prevent.stop="colsTable.startResize($event, 'total')" @click.stop />
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
              <!-- Primary input: SHARES (per the operator: "preferred
                   tab on Rounds is meant to show shares, not investment").
                   We compute amount = shares × share_price on commit so
                   round_investors keeps cash as the source of truth.
                   Rounds with no share_price fall back to $ editing
                   inline; the prefix flips to "$" + a small hint. -->
              <label class="cell-edit block">
                <NumberInput
                  variant="bare"
                  :prefix="ppsForRound(r.id) > 0 ? '' : '$'"
                  :model-value="ppsForRound(r.id) > 0 ? cellShares(r.id, inv.id) || null : cellAmount(r.id, inv.id)"
                  placeholder="—"
                  input-class="num text-[13px] bg-transparent text-right"
                  @update:model-value="(v) => setSharesDraft(r.id, inv.id, v)"
                  @blur="() => commitCell(r.id, inv.id)"
                  @keydown.enter="(e: KeyboardEvent) => (e.target as HTMLInputElement).blur()"
                />
              </label>
              <!-- Hint when the round has no share_price yet (cell fell
                   back to $ editing because we can't derive shares
                   without a price). The $/share setter now lives in this
                   round's column header — point the operator there. -->
              <div
                v-if="ppsForRound(r.id) <= 0 && (cellAmount(r.id, inv.id) || 0) > 0"
                class="text-[10px] text-amber-600 text-right mt-0.5 italic"
              >$ — set $/share in header ↑</div>
            </td>
            <!-- CN total per investor. Read-only — CN data lives on the
                 Convertible-notes ledger; this column is a roll-up so
                 the operator can see paper money alongside cash on the
                 same row. -->
            <td class="px-3 py-1.5 text-right bg-amber-50/30">
              <template v-if="cnFor(inv.id)?.total">
                <div class="text-[13px] num font-medium text-amber-800">
                  <UiCalcTip :formula="fCnTotal(inv)">{{ fmtUSD(cnFor(inv.id)?.total ?? 0) }}</UiCalcTip>
                </div>
                <div v-if="(cnFor(inv.id)?.notes ?? 0) > 1" class="text-[10px] text-amber-600 mt-0.5">{{ cnFor(inv.id)?.notes }} notes</div>
              </template>
              <span v-else class="text-ink-300 text-[12px]">—</span>
            </td>
            <td class="px-3 py-1.5 text-right text-[13px]">
              <template v-if="totalSharesForInvestor(inv) > 0">
                <div class="num font-semibold text-ink-900"><UiCalcTip :formula="fTotalShares(inv)">{{ fmtShares(totalSharesForInvestor(inv)) }}</UiCalcTip></div>
              </template>
              <template v-else-if="cnFor(inv.id)?.total">
                <span class="text-[11px] text-amber-700 italic">CN only</span>
              </template>
              <span v-else class="text-ink-300">—</span>
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
              <!-- Add-investor row: same convention as the body cells.
                   Enter shares; we convert × share_price → amount before
                   the POST. When share_price is unset, fall back to
                   raw $. -->
              <label v-if="newName.trim()" class="cell-edit block">
                <NumberInput
                  variant="bare"
                  :prefix="(r.share_price || 0) > 0 ? '' : '$'"
                  :model-value="(r.share_price || 0) > 0
                    ? ((newAmounts[r.id] || 0) / (r.share_price || 1)) || null
                    : (newAmounts[r.id] || null)"
                  placeholder="—"
                  input-class="num text-[13px] bg-transparent text-right"
                  @update:model-value="(v) => (newAmounts[r.id] = (r.share_price || 0) > 0 ? ((v || 0) * (r.share_price || 0)) : (v || 0))"
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
          <!-- Allocated: shares per round. Reconciliation against
               preferred_issued (Δ row below). -->
          <tr class="bg-ink-50/60 border-t border-ink-200">
            <td class="px-3 py-2 text-right pr-6 sticky left-0 z-10 bg-ink-50/95 text-[10.5px] uppercase tracking-[0.06em] text-ink-500 font-semibold">Allocated</td>
            <td
              v-for="r in data.rounds"
              :key="r.id"
              class="px-3 py-2 text-right font-semibold text-[13px]"
              :class="[r.kind === 'open' ? 'bg-brand-soft/30' : '', sumDeltaClass(data.sums[r.id]?.delta_shares ?? 0, r.preferred_issued)]"
            >
              <UiCalcTip :formula="fRoundReconcile(r)">{{ fmtShares(data.sums[r.id]?.allocated_shares ?? 0) }}</UiCalcTip>
            </td>
            <!-- CN column stays in $ — convertible notes are paper
                 money that hasn't converted to shares yet. -->
            <td class="px-3 py-2 text-right font-semibold text-amber-800 text-[13px] bg-amber-50/40">
              {{ data.cn_total ? fmtUSD(data.cn_total) : '—' }}
            </td>
            <td class="px-3 py-2" colspan="2"></td>
          </tr>
          <!-- Target row: round.preferred_issued (the share count the
               round expects). -->
          <tr class="text-[11.5px] text-ink-500 border-t border-ink-100">
            <td class="px-3 py-1.5 text-right pr-6 sticky left-0 z-10 bg-white">Round expects</td>
            <td v-for="r in data.rounds" :key="r.id" class="px-3 py-1.5 text-right" :class="r.kind === 'open' ? 'bg-brand-soft/20' : ''">
              {{ fmtShares(r.preferred_issued || 0) }}
            </td>
            <td class="px-3 py-1.5 bg-amber-50/20"></td>
            <td colspan="2"></td>
          </tr>
          <!-- Δ row: shares delta. Reconciliation goes green when the
               cell allocations sum to the round's preferred_issued. -->
          <tr class="text-[11.5px] border-t border-ink-100">
            <td class="px-3 py-1.5 text-right pr-6 sticky left-0 z-10 bg-white text-ink-500">Δ to allocate</td>
            <td
              v-for="r in data.rounds"
              :key="r.id"
              class="px-3 py-1.5 text-right"
              :class="[r.kind === 'open' ? 'bg-brand-soft/20' : '', sumDeltaClass(data.sums[r.id]?.delta_shares ?? 0, r.preferred_issued)]"
            >
              <UiCalcTip :formula="fRoundReconcile(r)">
                <span v-if="Math.abs(data.sums[r.id]?.delta_shares ?? 0) < 1">✓ reconciled</span>
                <span v-else class="inline-flex items-center gap-1">
                  <AlertTriangle :size="10" />
                  {{ fmtShares(data.sums[r.id]?.delta_shares ?? 0) }} sh
                </span>
              </UiCalcTip>
            </td>
            <td class="px-3 py-1.5 bg-amber-50/20"></td>
            <td colspan="2"></td>
          </tr>
        </tfoot>
      </table>
    </div>
    <p v-if="data?.rounds.length" class="px-4 py-2 text-[11.5px] text-ink-500 bg-ink-50/50 border-t border-ink-100">
      Cells show shares per investor per round. Δ goes green when allocated shares sum to the round's Preferred-issued line. CN column stays in $ — convertibles are paper money that hasn't priced into shares yet.
    </p>
  </div>
</template>
