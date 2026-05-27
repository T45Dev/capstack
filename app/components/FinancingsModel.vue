<script setup lang="ts">
// Read-only finance-model view — the cap table the way an operator reads it:
// rounds across the columns, metrics down the rows, tranches combined into one
// column per round (SA1+SA2+SA3 = "Series A"). Mirrors the canonical finance
// spreadsheet. Editing happens in the wizard or the editable grid; this is the
// at-a-glance model output.
import { fmtUSD, fmtShares, fmtPricePerShare } from '~/utils/format'

interface RoundColumn {
  round_id: string; code: string; name: string | null
  kind: 'formation' | 'closed' | 'open'
  close_date: string | null; parent_round_code: string | null; seniority: number
  pre_money: number | null; new_money: number; post_money: number; share_price: number | null
  notes_financing: number; cumulated_financing: number; total_shares_fds: number
  common: number; preferred_issued: number; notes_converted: number
  option_pool_issued: number; option_pool_attributed: number; available_options: number
}
const props = defineProps<{ rounds: RoundColumn[] }>()

// Combine each parent round with its conversion tranches into a single column.
const columns = computed(() => {
  const groups = new Map<string, RoundColumn[]>()
  for (const r of props.rounds) {
    const key = r.parent_round_code || r.code
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(r)
  }
  const cols = [...groups.values()].map((members) => {
    const anchor = members.find(m => !m.parent_round_code) || members[0]!
    const sum = (f: keyof RoundColumn) => members.reduce((s, m) => s + (Number(m[f]) || 0), 0)
    // Cumulative fields come from the last tranche in the group (highest FDS).
    const last = members.reduce((a, b) => (b.total_shares_fds || 0) > (a.total_shares_fds || 0) ? b : a, members[0]!)
    const newMoney = sum('new_money')
    return {
      key: anchor.code,
      name: anchor.name || anchor.code,
      kind: anchor.kind,
      close_date: anchor.close_date,
      seniority: anchor.seniority,
      pre_money: anchor.pre_money,
      share_price: anchor.share_price,
      new_money: newMoney,
      post_money: (anchor.pre_money || 0) + newMoney,
      notes_financing: sum('notes_financing'),
      cumulated_financing: last.cumulated_financing,
      total_shares_fds: last.total_shares_fds,
      common: sum('common'),
      preferred_issued: sum('preferred_issued'),
      notes_converted: sum('notes_converted'),
      option_pool_issued: sum('option_pool_issued'),
      option_pool_attributed: sum('option_pool_attributed'),
      available_options: last.available_options,
    }
  })
  return cols.sort((a, b) =>
    (a.kind === 'open' ? 1 : 0) - (b.kind === 'open' ? 1 : 0)
    || (a.close_date || '').localeCompare(b.close_date || '')
    || a.seniority - b.seniority)
})

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[2]}/${m[3]}/${m[1].slice(2)}` : iso
}
const usd = (v: number | null) => (v == null || v === 0) ? '—' : fmtUSD(v)
const sh = (v: number | null) => (v == null || v === 0) ? '—' : fmtShares(v)

interface RowDef { label: string; get: (c: typeof columns.value[number]) => string; group: 'money' | 'shares'; emphasis?: boolean }
const rows: RowDef[] = [
  { label: 'Closing date', group: 'money', get: c => fmtDate(c.close_date) },
  { label: 'Pre-money valuation', group: 'money', get: c => usd(c.pre_money) },
  { label: 'New money', group: 'money', get: c => usd(c.new_money) },
  { label: 'Post-money valuation', group: 'money', get: c => usd(c.post_money), emphasis: true },
  { label: 'Share price', group: 'money', get: c => c.share_price ? fmtPricePerShare(c.share_price) : '—' },
  { label: 'Notes financing', group: 'money', get: c => usd(c.notes_financing) },
  { label: 'Cumulative financing', group: 'money', get: c => usd(c.cumulated_financing) },
  { label: 'Total shares — fully diluted', group: 'shares', get: c => sh(c.total_shares_fds), emphasis: true },
  { label: 'Common', group: 'shares', get: c => sh(c.common) },
  { label: 'Preferred issued', group: 'shares', get: c => sh(c.preferred_issued) },
  { label: 'Notes converted', group: 'shares', get: c => sh(c.notes_converted) },
  { label: 'Option pool issued', group: 'shares', get: c => sh(c.option_pool_issued) },
  { label: 'Option pool attributed', group: 'shares', get: c => sh(c.option_pool_attributed) },
  { label: 'Available (options)', group: 'shares', get: c => sh(c.available_options) },
]
</script>

<template>
  <div class="border border-ink-200 rounded-lg bg-white overflow-hidden shadow-[0_1px_0_rgba(16,24,40,0.04)]">
    <div class="overflow-x-auto">
      <table class="w-full border-collapse text-[13px]">
        <thead>
          <tr class="border-b border-ink-200">
            <th class="sticky left-0 bg-white z-10 border-r border-ink-200 px-4 py-2.5 text-left text-[10.5px] uppercase tracking-[0.08em] text-ink-500 font-semibold">
              Capitalization
            </th>
            <th
              v-for="c in columns" :key="c.key"
              class="px-3 py-2.5 text-right font-semibold whitespace-nowrap"
              :class="c.kind === 'open' ? 'bg-emerald-50 text-emerald-800' : 'text-ink-900'"
            >
              {{ c.name }}
              <span v-if="c.kind === 'open'" class="block text-[9.5px] uppercase tracking-wide font-medium text-emerald-600">modeling</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, i) in rows" :key="row.label"
            class="border-b border-ink-100"
            :class="[
              row.emphasis ? 'bg-ink-50/60 font-semibold' : '',
              i > 0 && rows[i - 1].group !== row.group ? 'border-t-2 border-ink-200' : '',
            ]"
          >
            <td class="sticky left-0 bg-white z-10 border-r border-ink-200 px-4 py-1.5 text-left text-ink-600"
                :class="row.emphasis ? 'font-semibold text-ink-900 bg-ink-50/60' : ''">
              {{ row.label }}
            </td>
            <td
              v-for="c in columns" :key="c.key"
              class="px-3 py-1.5 text-right tabular-nums whitespace-nowrap"
              :class="c.kind === 'open' ? 'bg-emerald-50/40' : ''"
            >
              {{ row.get(c) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
