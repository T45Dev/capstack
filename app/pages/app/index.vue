<script setup lang="ts">
import { Building2, Plus, Trash2, ArrowRight } from 'lucide-vue-next'
import { fmtShares, fmtDate } from '~/utils/format'

interface CompanyRow {
  id: string
  name: string
  slug: string
  ticker: string | null
  starting_round: string | null
  starting_round_date: string | null
  created_at: string
  stakeholder_count: number
  grant_count: number
  total_issued: number
}

const { data: companies, refresh } = await useFetch<CompanyRow[]>('/api/companies', { default: () => [] })

const showCreate = ref(false)
const form = reactive({
  name: '',
  ticker: '',
})
const creating = ref(false)

async function create() {
  if (!form.name.trim() || creating.value) return
  creating.value = true
  try {
    const c = await $fetch<CompanyRow>('/api/companies', {
      method: 'POST',
      body: {
        name: form.name.trim(),
        ticker: form.ticker.trim() || undefined,
      },
    })
    showCreate.value = false
    form.name = ''
    form.ticker = ''
    await refresh()
    await navigateTo(`/companies/${c.id}`)
  } finally {
    creating.value = false
  }
}

async function remove(id: string, name: string) {
  if (!confirm(`Delete ${name}? This wipes its cap table, grants, and scenarios.`)) return
  await $fetch(`/api/companies/${id}`, { method: 'DELETE' })
  await refresh()
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-xl font-semibold tracking-tight text-ink-900">Companies</h1>
        <p class="text-sm text-ink-600 mt-1">Each workspace holds a Carta-sourced cap table, funding rounds, grants, and exit scenarios.</p>
      </div>
      <UiButton variant="primary" @click="showCreate = true">
        <Plus :size="14" /> New company
      </UiButton>
    </div>

    <div v-if="!companies?.length" class="mt-10 max-w-xl mx-auto text-center">
      <div class="grid place-items-center w-14 h-14 rounded-full bg-brand-50 text-brand-600 mx-auto mb-4">
        <Building2 :size="24" />
      </div>
      <h2 class="text-lg font-semibold text-ink-900">Let's set up your first cap table</h2>
      <p class="text-sm text-ink-600 mt-2 leading-relaxed">
        Create a company below — then on the next page you'll drop your Carta pro-forma export
        and we'll suggest your rounds, pool, and open notes.
      </p>
      <UiButton variant="primary" size="lg" class="mt-5" @click="showCreate = true">
        <Plus :size="14" /> Create your first company
      </UiButton>
    </div>

    <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <NuxtLink
        v-for="c in companies"
        :key="c.id"
        :to="`/companies/${c.id}`"
        class="group block rounded-lg border border-ink-300 bg-white hover:border-brand-400 hover:shadow-card-hover p-4 transition-all"
      >
        <div class="flex items-start gap-3">
          <div class="grid place-items-center w-10 h-10 rounded-md bg-brand-50 text-brand-600 shrink-0">
            <Building2 :size="18" />
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <h3 class="font-semibold text-ink-900 truncate">{{ c.name }}</h3>
              <span v-if="c.ticker" class="text-[10px] uppercase tracking-wide text-ink-600 bg-ink-200 px-1.5 py-0.5 rounded">{{ c.ticker }}</span>
            </div>
            <p class="text-xs text-ink-500 mt-1">
              <span v-if="c.starting_round" class="text-brand-700 font-medium">{{ c.starting_round }}</span>
              <span v-if="c.starting_round_date" class="ml-1">· {{ fmtDate(c.starting_round_date) }}</span>
              <span v-if="!c.starting_round">Added {{ fmtDate(c.created_at) }}</span>
            </p>
            <div class="mt-3 grid grid-cols-3 gap-2 text-center">
              <div class="rounded bg-ink-100 py-1.5">
                <div class="text-[10px] uppercase text-ink-500 font-medium">Holders</div>
                <div class="text-sm font-semibold num text-ink-900">{{ c.stakeholder_count }}</div>
              </div>
              <div class="rounded bg-ink-100 py-1.5">
                <div class="text-[10px] uppercase text-ink-500 font-medium">Issued</div>
                <div class="text-sm font-semibold num text-ink-900">{{ fmtShares(c.total_issued) }}</div>
              </div>
              <div class="rounded bg-ink-100 py-1.5">
                <div class="text-[10px] uppercase text-ink-500 font-medium">Grants</div>
                <div class="text-sm font-semibold num text-ink-900">{{ c.grant_count }}</div>
              </div>
            </div>
          </div>
        </div>
        <div class="mt-3 flex items-center justify-between">
          <button
            class="text-xs text-ink-500 hover:text-red-600 inline-flex items-center gap-1"
            @click.stop.prevent="remove(c.id, c.name)"
          >
            <Trash2 :size="12" /> delete
          </button>
          <span class="text-xs text-brand-600 inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            open <ArrowRight :size="12" />
          </span>
        </div>
      </NuxtLink>
    </div>

    <!-- Create modal -->
    <div v-if="showCreate" class="fixed inset-0 z-40 bg-ink-900/40 backdrop-blur-sm grid place-items-center p-4" @click.self="showCreate = false">
      <div class="w-full max-w-md rounded-lg border border-ink-300 bg-white p-5 shadow-card-hover">
        <h2 class="text-base font-semibold text-ink-900">New company</h2>
        <p class="text-xs text-ink-500 mt-1">You'll add funding rounds on the Cap Table page. You can upload a Carta export on the next page for option grants and stakeholders.</p>
        <div class="mt-4 space-y-3">
          <UiInput v-model="form.name" label="Name" placeholder="Advanced NanoTherapies, Inc." />
          <UiInput v-model="form.ticker" label="Ticker / short code (optional)" placeholder="ANT" />
        </div>
        <div class="mt-5 flex justify-end gap-2">
          <UiButton variant="ghost" @click="showCreate = false">Cancel</UiButton>
          <UiButton variant="primary" :disabled="!form.name.trim() || creating" @click="create">
            <Plus :size="14" /> {{ creating ? 'Creating…' : 'Create' }}
          </UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
