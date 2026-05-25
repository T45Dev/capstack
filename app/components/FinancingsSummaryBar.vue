<script setup lang="ts">
// 6-stat summary bar above the matrix. Pulls highlights off the rounds
// array so the operator sees the scenario's headline numbers without
// scanning the table.
//
// Columns (left to right):
//   Open round         · "closing {date}" — brand-tinted value
//   Last closed        · "{date}"
//   Post-money (open)  · "pre + new"
//   Share price (open) · "typed"
//   Total FDS (post)   · "fully diluted"
//   Cumulative raise   · "across all rounds"
//
// Each cell is a stack: 10.5px uppercase label, 15px num value, 11px num
// sub-line. Cells are separated by an inset left border (border-l on
// every-but-first) for the divider look without an explicit ::before.
import { fmtUSD, fmtShares, fmtPricePerShare, fmtDate } from '~/utils/format'

interface RoundLite {
  round_id: string
  code: string
  name: string | null
  kind: 'formation' | 'closed' | 'open'
  close_date: string | null
  share_price: number | null
  pre_money: number | null
  new_money: number
  post_money: number
  notes_financing: number
  total_shares_fds: number
  cumulated_financing: number
}

interface Props {
  rounds: RoundLite[]
}
const props = defineProps<Props>()

const openRound = computed(() => props.rounds.find(r => r.kind === 'open'))
const lastClosed = computed(() => {
  const closed = props.rounds.filter(r => r.kind === 'closed' || r.kind === 'formation')
  return closed.length > 0 ? closed[closed.length - 1] : null
})
const cumulativeRaise = computed(() => {
  // Sum of new_money + notes_financing across every round, regardless of
  // status. Matches the matrix's "Cumulative financing" final value.
  if (props.rounds.length === 0) return 0
  const last = props.rounds[props.rounds.length - 1]
  return last.cumulated_financing
})

interface Item {
  label: string
  value: string
  sub: string
  tone?: 'brand'
}
const items = computed<Item[]>(() => {
  const open = openRound.value
  const lc = lastClosed.value
  return [
    {
      label: 'Open round',
      value: open ? (open.name || open.code) : '—',
      sub: open?.close_date ? `closing ${fmtDate(open.close_date)}` : 'no round flagged open',
      tone: 'brand',
    },
    {
      label: 'Last closed',
      value: lc ? (lc.name || lc.code) : '—',
      sub: lc?.close_date ? fmtDate(lc.close_date) : '—',
    },
    {
      label: 'Post-money (open)',
      value: open ? fmtUSD(open.post_money) : '—',
      sub: 'pre + new',
    },
    {
      label: 'Share price (open)',
      value: open?.share_price ? fmtPricePerShare(open.share_price) : '—',
      sub: 'typed',
    },
    {
      label: 'Total FDS (post)',
      value: open ? fmtShares(open.total_shares_fds) : (lc ? fmtShares(lc.total_shares_fds) : '—'),
      sub: 'fully diluted',
    },
    {
      label: 'Cumulative raise',
      value: fmtUSD(cumulativeRaise.value),
      sub: 'across all rounds',
    },
  ]
})
</script>

<template>
  <div class="px-4 py-3 border border-ink-200 rounded-lg bg-white shadow-[0_1px_0_rgba(16,24,40,0.04)]">
    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-x-6 gap-y-3">
      <div
        v-for="(it, i) in items"
        :key="i"
        class="border-l border-ink-100 pl-4 first:border-l-0 first:pl-0 lg:border-l lg:pl-4 lg:[&:nth-child(7n+1)]:border-l-0 lg:[&:nth-child(7n+1)]:pl-0"
      >
        <div class="text-[10.5px] uppercase tracking-[0.06em] text-ink-500 font-medium">{{ it.label }}</div>
        <div
          class="num text-[15px] font-semibold mt-0.5 truncate"
          :class="it.tone === 'brand' ? 'text-brand-edge' : 'text-ink-900'"
          :title="it.value"
        >
          {{ it.value }}
        </div>
        <div class="text-[11px] text-ink-500 num mt-0.5 truncate" :title="it.sub">{{ it.sub }}</div>
      </div>
    </div>
  </div>
</template>
