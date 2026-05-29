<script setup lang="ts">
// Pick another stakeholder to link to as primary. Renders a searchable
// list — operator types to filter by name, clicks a row to confirm.
import { X, Search, Link2 } from 'lucide-vue-next'

interface Candidate {
  id: string
  name: string
  type: string | null
  total_shares: number
}

const props = defineProps<{
  open: boolean
  candidates: Candidate[]
  hideId?: string  // exclude this stakeholder from the picker (the one being linked)
  title?: string
}>()
const emit = defineEmits<{
  close: []
  pick: [candidate: Candidate]
}>()

const query = ref('')
watch(() => props.open, (v) => { if (v) query.value = '' })

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return props.candidates
    .filter(c => c.id !== props.hideId)
    .filter(c => !q || c.name.toLowerCase().includes(q))
    .slice(0, 200)
})

function fmtShares(n: number): string {
  if (n <= 0) return '0'
  return new Intl.NumberFormat('en-US').format(n)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-50 bg-ink-900/40 flex items-center justify-center p-4" @click.self="emit('close')">
      <div class="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col overflow-hidden">
        <header class="px-5 py-3 border-b border-ink-200 flex items-center justify-between gap-3">
          <div>
            <h2 class="text-[14px] font-semibold text-ink-900 flex items-center gap-1.5"><Link2 :size="14" /> {{ title || 'Link to stakeholder' }}</h2>
            <p class="text-[11px] text-ink-500 leading-tight mt-0.5">Pick the primary — shares from this row will roll up under them.</p>
          </div>
          <button class="text-ink-400 hover:text-ink-700 p-1 rounded hover:bg-ink-100" @click="emit('close')"><X :size="16" /></button>
        </header>

        <div class="px-3 py-2 border-b border-ink-100">
          <div class="flex items-center gap-2 bg-ink-50 rounded-md px-2 py-1.5">
            <Search :size="13" class="text-ink-400 shrink-0" />
            <input
              v-model="query"
              type="text"
              placeholder="Search stakeholders…"
              class="flex-1 bg-transparent text-[13px] outline-none border-0 text-left"
              autofocus
            />
          </div>
        </div>

        <div class="flex-1 overflow-y-auto">
          <div v-if="!filtered.length" class="px-4 py-8 text-center text-[12.5px] text-ink-500">
            No matches.
          </div>
          <button
            v-for="c in filtered"
            :key="c.id"
            type="button"
            class="w-full px-4 py-2 border-b border-ink-100 last:border-b-0 text-left hover:bg-brand-soft/40 transition-colors flex items-center justify-between gap-3"
            @click="emit('pick', c)"
          >
            <div class="min-w-0">
              <div class="text-[13px] text-ink-900 font-medium truncate">{{ c.name }}</div>
              <div v-if="c.type" class="text-[10.5px] text-ink-500 uppercase tracking-wide">{{ c.type }}</div>
            </div>
            <div class="text-[11.5px] num text-ink-500 shrink-0">{{ fmtShares(c.total_shares) }} sh</div>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
