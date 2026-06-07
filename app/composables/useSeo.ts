// Per-page SEO helper — single place that assembles the canonical URL,
// Open Graph / Twitter card, and robots directives so the marketing pages
// stay consistent (and in the repo's single-source-of-truth spirit). Pages
// pass a path + title + description; the absolute origin comes from
// runtimeConfig.public.siteUrl (override per-deploy with NUXT_PUBLIC_SITE_URL).

interface SeoOptions {
  title: string
  description: string
  /** Route path, e.g. '/' or '/pricing'. Used for canonical + og:url. */
  path: string
  /** Absolute or root-relative image path. Defaults to the social card. */
  image?: string
  /** og:type — 'website' for the homepage, 'product' for pricing, etc. */
  type?: 'website' | 'product' | 'article'
  /** Keep search engines out (used for app/workspace pages). */
  noindex?: boolean
}

export function useSeo(opts: SeoOptions) {
  const { public: { siteUrl } } = useRuntimeConfig()
  const origin = String(siteUrl).replace(/\/$/, '')
  const url = origin + opts.path
  const img = opts.image ?? '/og-image.png'
  const image = img.startsWith('http') ? img : origin + img

  useSeoMeta({
    title: opts.title,
    description: opts.description,
    ogTitle: opts.title,
    ogDescription: opts.description,
    ogType: opts.type ?? 'website',
    ogUrl: url,
    ogImage: image,
    ogImageWidth: 1200,
    ogImageHeight: 630,
    ogImageType: 'image/png',
    ogImageAlt: 'Pariva — cap table & dilution software',
    ogSiteName: 'Pariva',
    ogLocale: 'en_US',
    twitterCard: 'summary_large_image',
    twitterTitle: opts.title,
    twitterDescription: opts.description,
    twitterImage: image,
    robots: opts.noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large',
  })

  useHead({
    link: [{ rel: 'canonical', href: url }],
  })

  return { url, origin, image }
}
