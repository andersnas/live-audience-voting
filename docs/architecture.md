# Architecture

## Overview

Real-time audience voting system built entirely on Akamai / Linode infrastructure.
Audience members vote on their phones; results appear live on a presenter display.

## Data flow

1. Audience member opens the voter UI on their phone
2. They tap a vote option — browser POSTs to `/voterapp/api/vote`
3. Akamai Function validates, generates dedup token from IP+UA, forwards to SSE server
4. SSE server deduplicates via Redis (`SET NX`), publishes event (`PUBLISH`)
5. SSE server fans out the event to all open `/voterapp/api/events` SSE connections
6. Presenter display receives event, increments local tally, redraws bar chart

## URL structure

All paths are under `/voterapp/`:

| Path | Type | Description |
|---|---|---|
| `/voterapp/` | HTML | Voter UI |
| `/voterapp/admin/` | HTML | Admin UI — live totals and clear votes |
| `/voterapp/api/vote` | POST | Submit a vote |
| `/voterapp/api/clear` | POST | Clear all voter tokens and reset totals |
| `/voterapp/api/totals` | GET | Current vote totals |
| `/voterapp/api/events` | GET SSE | Live event stream — connect directly to origin |
| `/voterapp/api/health` | GET | Health check |

> **Note:** `/voterapp/api/events` must connect directly to the origin — it cannot
> pass through the CDN due to response buffering. The presenter display and admin UI
> connect directly to the origin hostname for SSE and admin API calls.

## CDN routing

The Akamai CDN property routes `/voterapp/*` to the origin (LKE).
The Fermyon function is accessible directly via its `{FUNCTION_DOMAIN}` URL or can be placed
behind the CDN on a separate path. HTML pages (voter UI, admin UI) are served by
the Fermyon function. API calls are handled by the SSE server on LKE.

## Components

### Akamai Functions (Fermyon / Spin / Wasm)
- Serves voter UI HTML and admin UI HTML
- Handles `POST /voterapp/api/vote` — validates and forwards to SSE server
- Outbound URL configured at build time via `src/config.js` (gitignored)
- Build with real URLs: `SSE_SERVER_URL` and `ORIGIN_URL` in `src/config.js`
- Deploy: `npm run build && spin aka deploy`

### SSE server (LKE)
- Node.js / TypeScript
- All routes under `/voterapp/api/` prefix
- Maintains in-memory vote totals (reset on pod restart)
- Two Redis connections: one for subscribe, one for publish/commands

### Redis (LKE)
- Single pod, Bitnami Helm chart, `emptyDir` (no PersistentVolume)
- ClusterIP only — never exposed outside the cluster
- `SET NX voter:{token} 1 EX 3600` — deduplication (1 hour TTL)
- `PUBLISH votes {option}` — fan out to SSE server subscriber

### Presenter display
- File: `display-ui/index.html`
- EventSource connects directly to `{ORIGIN_HOSTNAME}/voterapp/api/events`
- Tallies vote events locally, animates Chart.js bar chart
- Fullscreen on dedicated display

### Admin UI
- Served by Fermyon function at `/voterapp/admin/`
- Polls `{ORIGIN_HOSTNAME}/voterapp/api/totals` every 5 seconds
- SSE stream from `{ORIGIN_HOSTNAME}/voterapp/api/events` for real-time updates
- Clear button calls `{ORIGIN_HOSTNAME}/voterapp/api/clear`

## Infrastructure

| Component | Platform | Notes |
|---|---|---|
| Voter UI + vote handler | Akamai Functions (Fermyon/Spin) | Wasm runtime |
| SSE server | Linode LKE | Deployment + ClusterIP service |
| Redis | Linode LKE | Bitnami Helm, no persistence |
| Ingress | Linode LKE | nginx ingress controller |
| TLS | Let's Encrypt via cert-manager | DNS-01 validation, Linode webhook |
| DNS | Linode DNS Manager | |
| CDN / edge | Akamai | Path-based routing to origin |

## Security

- LKE cluster only accepts traffic on 443 from Akamai edge IPs (Akamai IPACL)
- Redis is ClusterIP only — no external exposure
- TLS auto-renewed by cert-manager (DNS-01, Linode webhook)
- Voter dedup via Redis `SET NX` — silent 200 on duplicate votes
- No secrets or hostnames committed to git

## Build configuration

The Fermyon function requires two URLs configured at build time via `src/config.js`.
This file is gitignored. Copy `src/config.example.js` to `src/config.js` and fill in:
```js
// src/config.js — gitignored, never commit
export const SSE_SERVER_URL = 'https://{CDN_HOSTNAME}/voterapp/api/vote';
export const ORIGIN_URL = 'https://{ORIGIN_HOSTNAME}/voterapp';
```

Then build and deploy:
```bash
cd vote-edge-function
npm run build && spin aka deploy
```

## Secrets — never committed to git
```bash
# Redis password
kubectl create secret generic redis-secret \
  --from-literal=password=YOUR_REDIS_PASSWORD

# Linode API token (cert-manager DNS-01 validation)
kubectl create secret generic linode-credentials \
  --namespace cert-manager \
  --from-literal=token=YOUR_LINODE_API_TOKEN
```

## Useful commands
```bash
# Watch all pods
kubectl get pods --watch

# SSE server logs
kubectl logs -l app=sse-server -f

# Redis CLI
kubectl exec -it redis-master-0 -- redis-cli -a YOUR_PASSWORD

# Clear all voter tokens manually
kubectl exec -it redis-master-0 -- redis-cli -a YOUR_PASSWORD FLUSHDB

# Redeploy SSE server after image push
kubectl rollout restart deployment sse-server

# Build and deploy edge function
cd vote-edge-function && npm run build && spin aka deploy
```
