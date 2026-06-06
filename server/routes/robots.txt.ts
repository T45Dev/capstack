// Served at /robots.txt. Generated (not static) so the Sitemap line tracks
// the deploy's NUXT_PUBLIC_SITE_URL. The product surfaces (/app, /companies)
// and the API are kept out of the index; only the marketing pages are crawled.
export default defineEventHandler((event) => {
  const { public: { siteUrl } } = useRuntimeConfig(event)
  const origin = String(siteUrl).replace(/\/$/, '')
  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  return [
    'User-agent: *',
    'Disallow: /app',
    'Disallow: /companies',
    'Disallow: /api',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n')
})
