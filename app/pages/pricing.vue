<script setup lang="ts">
// Public pricing page. Tiers + comparison matrix come from the single source
// of truth in ~/utils/pricing so they can't drift from the homepage teaser.
import { Check, Minus, ArrowRight } from 'lucide-vue-next'
import { PRICING_TIERS, COMPARE_GROUPS, tierPrice, type BillingPeriod, type CompareRow } from '~/utils/pricing'

definePageMeta({ layout: 'marketing' })

const { origin, url } = useSeo({
  path: '/pricing',
  title: 'Pricing — CapStack Cap Table Software',
  description: 'Simple per-company pricing for CapStack. Start free on one cap table; upgrade to Pro for Carta import and board-ready Excel exports, or Firm for unlimited multi-seat workspaces.',
  type: 'product',
})

const period = ref<BillingPeriod>('annual')

function cellOf(row: CompareRow, key: 'free' | 'pro' | 'firm') {
  return row[key]
}

const faqs = [
  { q: 'What counts as a "company workspace"?', a: 'One company\'s cap table, rounds, grants, and scenarios. Free covers one; Pro covers up to five; Firm is unlimited — handy if you manage a portfolio or a few entities.' },
  { q: 'Do I need a Carta account?', a: 'No. Carta import is a shortcut — you can build everything by hand from a blank workspace. The import just saves you the typing for stakeholders, holdings, grants, and the convertible-note ledger.' },
  { q: 'What\'s in the board-ready Excel export?', a: 'A spreadsheet that reconciles to the on-screen model — rounds, dilution, the option-pool impact, and the grant being approved — formatted for a board packet.' },
  { q: 'Can I change plans later?', a: 'Anytime. Upgrades take effect immediately; downgrades apply at the end of the billing period. Annual billing is discounted versus monthly.' },
  { q: 'Is the Firm plan right for a fund or law firm?', a: 'Yes — unlimited workspaces, up to ten seats on shared workspaces, audit history on every figure, and priority onboarding. Need more than ten seats? Reach out and we\'ll size it with you.' },
]
const openFaq = ref<number | null>(0)

// Structured data: FAQPage (rich result for the questions below) + a Product
// with the three tier offers, and the breadcrumb trail. Prices come from the
// single source of truth so the markup can't drift from the cards.
const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'FAQPage',
      '@id': `${url}#faq`,
      mainEntity: faqs.map(f => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
    {
      '@type': 'Product',
      name: 'CapStack',
      description: 'Cap table and dilution modelling software with Carta import and board-ready Excel export.',
      brand: { '@type': 'Brand', name: 'CapStack' },
      offers: PRICING_TIERS.map(t => ({
        '@type': 'Offer',
        name: `${t.name} plan`,
        price: tierPrice(t, 'monthly') ?? 0,
        priceCurrency: 'USD',
        url,
      })),
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: origin + '/' },
        { '@type': 'ListItem', position: 2, name: 'Pricing', item: url },
      ],
    },
  ],
}
useHead({
  script: [{ type: 'application/ld+json', innerHTML: JSON.stringify(jsonLd) }],
})
</script>

<template>
  <div>
    <section class="max-w-6xl mx-auto px-5 pt-16 pb-10 sm:pt-20 text-center">
      <h1 class="text-3xl sm:text-4xl font-bold tracking-tight text-ink-900">Pricing that scales with the model</h1>
      <p class="mt-4 text-lg text-ink-600 max-w-2xl mx-auto">
        Start free on a single cap table. Upgrade when you need Carta import and the board-ready export.
      </p>

      <!-- Billing toggle -->
      <div class="mt-8 inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-ink-50 p-1">
        <button
          class="px-4 py-1.5 text-[13px] font-medium rounded-md transition-colors"
          :class="period === 'monthly' ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-700'"
          @click="period = 'monthly'"
        >
          Monthly
        </button>
        <button
          class="px-4 py-1.5 text-[13px] font-medium rounded-md transition-colors inline-flex items-center gap-1.5"
          :class="period === 'annual' ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-700'"
          @click="period = 'annual'"
        >
          Annual
          <span class="rounded-full bg-brand-100 text-brand-700 text-[10px] font-semibold px-1.5 py-0.5">Save 20%</span>
        </button>
      </div>
    </section>

    <!-- Tier cards -->
    <section class="max-w-6xl mx-auto px-5 pb-16">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-5 items-start">
        <PricingCard v-for="t in PRICING_TIERS" :key="t.id" :tier="t" :period="period" />
      </div>
      <p class="mt-6 text-center text-[13px] text-ink-400">
        Need more than ten seats or a custom rollout? <NuxtLink to="/app" class="text-brand-600 hover:text-brand-700 font-medium">Get in touch</NuxtLink>.
      </p>
    </section>

    <!-- Comparison table -->
    <section class="bg-ink-50 border-y border-ink-200">
      <div class="max-w-5xl mx-auto px-5 py-16">
        <h2 class="text-2xl font-bold tracking-tight text-ink-900 text-center">Compare every plan</h2>
        <div class="mt-8 overflow-x-auto rounded-xl border border-ink-200 bg-white shadow-card">
          <table class="w-full text-[13.5px]">
            <thead>
              <tr class="border-b border-ink-200">
                <th class="text-left font-semibold text-ink-700 px-5 py-3.5 w-1/2">Plan</th>
                <th class="text-center font-semibold text-ink-700 px-4 py-3.5">Free</th>
                <th class="text-center font-semibold text-brand-700 px-4 py-3.5 bg-brand-50">Pro</th>
                <th class="text-center font-semibold text-ink-700 px-4 py-3.5">Firm</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="g in COMPARE_GROUPS" :key="g.group">
                <tr class="bg-ink-50/70">
                  <td colspan="4" class="px-5 py-2 text-[12px] font-semibold uppercase tracking-wide text-ink-500">{{ g.group }}</td>
                </tr>
                <tr v-for="row in g.rows" :key="row.label" class="border-t border-ink-100">
                  <td class="px-5 py-3 text-ink-700">{{ row.label }}</td>
                  <td v-for="key in (['free', 'pro', 'firm'] as const)" :key="key"
                      class="px-4 py-3 text-center num"
                      :class="key === 'pro' ? 'bg-brand-50/50' : ''">
                    <template v-if="cellOf(row, key) === true">
                      <Check :size="16" class="inline text-brand-500" />
                    </template>
                    <template v-else-if="cellOf(row, key) === false">
                      <Minus :size="16" class="inline text-ink-300" />
                    </template>
                    <template v-else>
                      <span class="text-ink-700">{{ cellOf(row, key) }}</span>
                    </template>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- FAQ -->
    <section class="max-w-3xl mx-auto px-5 py-16">
      <h2 class="text-2xl font-bold tracking-tight text-ink-900 text-center">Frequently asked</h2>
      <div class="mt-8 divide-y divide-ink-200 rounded-xl border border-ink-200 bg-white shadow-card">
        <div v-for="(f, i) in faqs" :key="i">
          <button
            class="w-full flex items-center justify-between gap-4 text-left px-5 py-4"
            @click="openFaq = openFaq === i ? null : i"
          >
            <span class="font-medium text-ink-900">{{ f.q }}</span>
            <span class="text-ink-400 text-lg leading-none shrink-0">{{ openFaq === i ? '–' : '+' }}</span>
          </button>
          <p v-if="openFaq === i" class="px-5 pb-4 -mt-1 text-[13.5px] text-ink-600 leading-relaxed">{{ f.a }}</p>
        </div>
      </div>
    </section>

    <!-- CTA -->
    <section class="max-w-6xl mx-auto px-5 pb-20">
      <div class="rounded-2xl bg-brand-600 px-8 py-12 text-center shadow-card-hover">
        <h2 class="text-2xl font-bold tracking-tight text-white">Try it on your real cap table.</h2>
        <p class="mt-3 text-brand-100">Free to start — no credit card.</p>
        <NuxtLink
          to="/app"
          class="mt-7 inline-flex items-center gap-2 rounded-md bg-white text-brand-700 hover:bg-brand-50 text-sm font-semibold px-6 py-3 shadow-sm transition-colors"
        >
          Open the app <ArrowRight :size="16" />
        </NuxtLink>
      </div>
    </section>
  </div>
</template>
