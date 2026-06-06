<script setup lang="ts">
// Public marketing homepage. Lives at `/`; the Companies app moved to `/app`.
import {
  Upload, FileSpreadsheet, GitCompare, TrendingDown, FlaskConical, Scale,
  Download, ArrowRight, Check,
} from 'lucide-vue-next'
import { PRICING_TIERS } from '~/utils/pricing'

definePageMeta({ layout: 'marketing' })
useHead({
  title: 'CapStack — Cap tables, financings & board-ready exports',
  meta: [{
    name: 'description',
    content: 'Import your Carta export, model rounds and convertible notes, see dilution clearly, and ship a board-ready Excel for every option grant.',
  }],
})

const features = [
  { icon: Upload, title: 'One-click Carta import', body: 'Drop your Carta pro-forma export. Stakeholders, holdings, grants, the option pool, and the full convertible-note ledger come in clean.' },
  { icon: FileSpreadsheet, title: 'Rounds you actually own', body: 'Build a chronological record of financings the way you think about them — not the way a share-class ledger forces you to.' },
  { icon: GitCompare, title: 'Dilution you can see', body: 'Pre- and post-money denominators side by side, so a holder whose share count never moves still shows the dilution they actually take.' },
  { icon: TrendingDown, title: 'Option-pool impact', body: 'Watch the authorized and available pool move as you size the next round — before you commit a single grant.' },
  { icon: FlaskConical, title: 'Exit scenarios', body: 'Run the waterfall across exit values and see what each stakeholder clears under your preference stack.' },
  { icon: Scale, title: 'Grant Fairness', body: 'Pressure-test a proposed grant against ownership targets with the same canonical math the rest of the model uses.' },
]

const steps = [
  { n: '01', title: 'Import', body: 'Upload your Carta export — or start from a blank workspace and type your rounds in.' },
  { n: '02', title: 'Model', body: 'Add financings, attribute convertible notes to rounds, and size the open round and pool.' },
  { n: '03', title: 'Export', body: 'Ship a board-ready Excel for the grant approval — the numbers reconcile across every page.' },
]
</script>

<template>
  <div>
    <!-- Hero ────────────────────────────────────────────────────────── -->
    <section class="relative overflow-hidden">
      <div class="absolute inset-0 bg-gradient-to-b from-brand-50/60 via-white to-white pointer-events-none" />
      <div class="relative max-w-6xl mx-auto px-5 pt-20 pb-16 sm:pt-28 sm:pb-20">
        <div class="max-w-3xl">
          <span class="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 text-brand-700 text-[12px] font-medium px-3 py-1">
            <span class="w-1.5 h-1.5 rounded-full bg-brand-500 animate-open-dot" /> Built for the board-approval workflow
          </span>
          <h1 class="mt-5 text-4xl sm:text-5xl font-bold tracking-tight text-ink-900 leading-[1.08]">
            Your cap table, from Carta import<br class="hidden sm:block" />
            to <span class="text-brand">board-ready Excel</span>.
          </h1>
          <p class="mt-5 text-lg text-ink-600 leading-relaxed max-w-2xl">
            CapStack is the cap-table and scenario modeller for operators. Import your Carta export,
            build a clean record of financings, attribute convertible notes, model dilution, and
            export the spreadsheet your board signs off on.
          </p>
          <div class="mt-8 flex flex-wrap items-center gap-3">
            <NuxtLink
              to="/app"
              class="inline-flex items-center gap-2 rounded-md bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium px-5 py-3 shadow-sm transition-colors"
            >
              Start free <ArrowRight :size="16" />
            </NuxtLink>
            <NuxtLink
              to="/pricing"
              class="inline-flex items-center gap-2 rounded-md bg-white hover:bg-ink-100 text-ink-800 border border-ink-300 text-sm font-medium px-5 py-3 shadow-sm transition-colors"
            >
              See pricing
            </NuxtLink>
          </div>
          <p class="mt-4 text-[13px] text-ink-400">No credit card to start · Carta import & Excel export on Pro</p>
        </div>

        <!-- Visual: a stylized round-stack card echoing the product. -->
        <div class="mt-14 max-w-3xl">
          <div class="rounded-xl border border-ink-200 bg-white shadow-card-hover overflow-hidden">
            <div class="flex items-center gap-2 px-4 py-2.5 border-b border-ink-100 bg-ink-50">
              <span class="w-2.5 h-2.5 rounded-full bg-ink-300" />
              <span class="w-2.5 h-2.5 rounded-full bg-ink-300" />
              <span class="w-2.5 h-2.5 rounded-full bg-ink-300" />
              <span class="ml-2 text-[12px] text-ink-400 num">capstack · Financings</span>
            </div>
            <div class="p-5 space-y-3">
              <div v-for="(w, i) in [40, 58, 76, 92]" :key="i" class="flex items-center gap-3">
                <span class="text-[11px] font-semibold text-ink-400 num w-6">R{{ i + 1 }}</span>
                <div class="flex-1 h-7 rounded-md bg-ink-100 overflow-hidden">
                  <div
                    class="h-full rounded-md"
                    :class="i === 3 ? 'bg-teal-300' : 'bg-brand-500'"
                    :style="{ width: w + '%', opacity: i === 3 ? 1 : 0.45 + i * 0.18 }"
                  />
                </div>
                <span class="text-[11px] text-ink-500 num w-16 text-right">{{ (w * 0.13).toFixed(1) }}% FDS</span>
              </div>
              <div class="pt-1 flex items-center justify-between text-[12px]">
                <span class="text-ink-400">Open round — notes converting</span>
                <span class="num font-semibold text-brand-700">Total FDS 12,480,000</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Features ────────────────────────────────────────────────────── -->
    <section id="features" class="max-w-6xl mx-auto px-5 py-16 sm:py-20 scroll-mt-20">
      <div class="max-w-2xl">
        <h2 class="text-2xl sm:text-3xl font-bold tracking-tight text-ink-900">Everything the model needs, nothing it doesn't</h2>
        <p class="mt-3 text-ink-600">One workspace per company. The same canonical math behind every page, so the numbers reconcile.</p>
      </div>
      <div class="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        <div
          v-for="f in features"
          :key="f.title"
          class="rounded-xl border border-ink-200 bg-white p-5 shadow-card hover:shadow-card-hover hover:border-brand-300 transition-all"
        >
          <div class="grid place-items-center w-10 h-10 rounded-md bg-brand-50 text-brand-600 mb-3">
            <component :is="f.icon" :size="18" />
          </div>
          <h3 class="font-semibold text-ink-900">{{ f.title }}</h3>
          <p class="mt-1.5 text-[13.5px] text-ink-600 leading-relaxed">{{ f.body }}</p>
        </div>
      </div>
    </section>

    <!-- How it works ───────────────────────────────────────────────── -->
    <section id="how" class="bg-ink-50 border-y border-ink-200 scroll-mt-20">
      <div class="max-w-6xl mx-auto px-5 py-16 sm:py-20">
        <h2 class="text-2xl sm:text-3xl font-bold tracking-tight text-ink-900">Three steps to a board-ready export</h2>
        <div class="mt-10 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div v-for="s in steps" :key="s.n" class="relative rounded-xl border border-ink-200 bg-white p-6">
            <div class="text-[13px] font-bold text-brand-500 num">{{ s.n }}</div>
            <h3 class="mt-2 text-lg font-semibold text-ink-900">{{ s.title }}</h3>
            <p class="mt-2 text-[13.5px] text-ink-600 leading-relaxed">{{ s.body }}</p>
          </div>
        </div>
        <div class="mt-8 inline-flex items-center gap-2 text-[13px] text-ink-500">
          <Download :size="15" class="text-brand-500" />
          The Excel reconciles to the on-screen model — no copy-paste, no drift.
        </div>
      </div>
    </section>

    <!-- Pricing teaser ─────────────────────────────────────────────── -->
    <section class="max-w-6xl mx-auto px-5 py-16 sm:py-20">
      <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div class="max-w-2xl">
          <h2 class="text-2xl sm:text-3xl font-bold tracking-tight text-ink-900">Simple, per-company pricing</h2>
          <p class="mt-3 text-ink-600">Start free on one cap table. Upgrade when you need Carta import and the board-ready export.</p>
        </div>
        <NuxtLink to="/pricing" class="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 shrink-0">
          Compare all plans <ArrowRight :size="15" />
        </NuxtLink>
      </div>
      <div class="mt-10 grid grid-cols-1 md:grid-cols-3 gap-5">
        <PricingCard v-for="t in PRICING_TIERS" :key="t.id" :tier="t" period="monthly" />
      </div>
    </section>

    <!-- CTA band ───────────────────────────────────────────────────── -->
    <section class="max-w-6xl mx-auto px-5 pb-20">
      <div class="rounded-2xl bg-brand-600 px-8 py-12 sm:px-12 sm:py-14 text-center shadow-card-hover">
        <h2 class="text-2xl sm:text-3xl font-bold tracking-tight text-white">Bring your next round to the board with confidence.</h2>
        <p class="mt-3 text-brand-100 max-w-xl mx-auto">Spin up a workspace in seconds. Import a Carta export or start from scratch.</p>
        <NuxtLink
          to="/app"
          class="mt-7 inline-flex items-center gap-2 rounded-md bg-white text-brand-700 hover:bg-brand-50 text-sm font-semibold px-6 py-3 shadow-sm transition-colors"
        >
          Start free <ArrowRight :size="16" />
        </NuxtLink>
      </div>
    </section>
  </div>
</template>
