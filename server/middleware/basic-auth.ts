import { timingSafeEqual } from 'node:crypto'

// HTTP Basic Auth gate for the whole app.
//
// Opt-in: only enforced when BOTH NUXT_BASIC_AUTH_USER and NUXT_BASIC_AUTH_PASS
// are set (see runtimeConfig in nuxt.config.ts). That way the deployed
// container can require a login on every request — covering both the public
// pariva.t45labs.com tunnel and direct LAN access on :3100 — while local
// `npm run dev` without those vars stays open.
//
// Basic Auth sends credentials base64-encoded (not encrypted), so this is only
// meaningful over HTTPS. Cloudflare terminates TLS in front of the tunnel and
// the LAN is trusted, so that holds here. It's a single shared credential to
// keep casual visitors out — not a real identity system.

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  // timingSafeEqual throws on length mismatch; guard first. The length check
  // itself leaks length, which is acceptable for a shared gate credential.
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export default defineEventHandler((event) => {
  const { basicAuthUser, basicAuthPass } = useRuntimeConfig(event)

  // Not configured → gate disabled (dev / un-provisioned deploys).
  if (!basicAuthUser || !basicAuthPass) return

  const header = getHeader(event, 'authorization') || ''
  const [scheme, encoded] = header.split(' ')

  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8')
    const sep = decoded.indexOf(':')
    if (sep >= 0) {
      const user = decoded.slice(0, sep)
      const pass = decoded.slice(sep + 1)
      // Evaluate both halves regardless of the first result to avoid
      // short-circuit timing differences.
      const ok = safeEqual(user, basicAuthUser) && safeEqual(pass, basicAuthPass)
      if (ok) return
    }
  }

  setResponseStatus(event, 401)
  setResponseHeader(event, 'WWW-Authenticate', 'Basic realm="Pariva", charset="UTF-8"')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return 'Authentication required.'
})
