# Cloudflare Tunnel for CapStack / Pariva

This directory holds the Cloudflare Tunnel config that exposes the app at
`pariva.t45labs.com`. The ingress rules (`config.yml`) are committed; the
tunnel credentials are **not** — they're a secret and are gitignored.

## One-time setup on the host

Run these once on the box that runs `docker compose` (e.g. `10.10.1.236`).
You need `cloudflared` installed locally just for the create/route steps;
the running tunnel itself lives in the compose `cloudflared` service.

```bash
# 1. Authenticate to your Cloudflare account (opens a browser, writes ~/.cloudflared/cert.pem)
cloudflared tunnel login

# 2. Create the named tunnel. This prints a UUID and writes <UUID>.json
cloudflared tunnel create capstack

# 3. Drop the credentials where compose expects them, next to this README:
cp ~/.cloudflared/<UUID>.json /path/to/capstack/cloudflared/credentials.json

# 4. Point the DNS record at the tunnel (creates a proxied CNAME)
cloudflared tunnel route dns capstack pariva.t45labs.com
```

After that:

```bash
docker compose up -d
docker compose logs -f cloudflared   # should show "Registered tunnel connection"
```

## Adding more hostnames later

Add another `- hostname:` block above the catch-all in `config.yml`, run
`cloudflared tunnel route dns capstack <hostname>`, then
`docker compose restart cloudflared`. One tunnel can front many hostnames.

## Notes

- `tunnel:` in `config.yml` is the tunnel name (`capstack`). If you'd rather
  pin the UUID, swap it in — just keep it consistent with `credentials.json`.
- The `cloudflared` container reaches the app over the compose network using
  the service name `capstack:3100`, so the app does **not** need its host
  port published for the tunnel to work (the `3100:3100` mapping stays only
  for direct LAN access).
