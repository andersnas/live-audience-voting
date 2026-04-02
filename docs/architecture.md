# Architecture

## Overview

Real-time audience voting system built entirely on Akamai / Linode infrastructure.
Audience members vote on their phones; results appear live on a presenter display.

## Data flow

1. Audience member opens the voter UI on their phone
2. They tap a vote option — browser POSTs to the Akamai Function
3. Akamai Function validates, generates dedup token from IP+UA, forwards to SSE server
4. SSE server deduplicates via Redis (SET NX), publishes event (PUBLISH)
5. SSE server fans out the event to all open `/voterapp/events` SSE connections
6. Presenter display receives event, increments local tally, redraws bar chart

## URL structure

### Public voter-facing (through Akamai CDN)
| Path | Description |
|---|---|
| `https://{CDN_HOSTNAME}/voterapp/` | Voter UI — requires trailing slash |
| `https://{CDN_HOSTNAME}/voterapp/vote` | Vote submission (POST) |

### Fermyon Wasm Functions (direct access)
| Path | Description |
|---|---|
| `https://{FWF_APP_URL}/voterapp/` | Voter UI — requires trailing slash |
| `https://{FWF_APP_URL}/voterapp/vote` | Vote handler (POST) |
| `https://{FWF_APP_URL}/voterapp/admin/` | Admin UI — live totals and clear votes |

### Backend / origin (LKE — direct, bypasses Akamai)
| Path | Description |
|---|---|
| `https://{ORIGIN_HOSTNAME}/voterapp/health` | Health check |
| `https://{ORIGIN_HOSTNAME}/voterapp/vote` | Vote endpoint (POST) |
| `https://{ORIGIN_HOSTNAME}/voterapp/events` | SSE stream — presenter display connects here |
| `https://{ORIGIN_HOSTNAME}/voterapp/totals` | Current vote totals (GET) |
| `https://{ORIGIN_HOSTNAME}/voterapp/admin/clear` | Clear all voter tokens and reset totals (POST) |

### Akamai property path mapping
| Incoming path | Forwards to | Notes |
|---|---|---|
| `{CDN_HOSTNAME}/voterapp/*` | `{ORIGIN_HOSTNAME}/voterapp/*` | No path rewrite — full path preserved |

## Why SSE bypasses Akamai

SSE is a long-lived HTTP response that streams data in chunks indefinitely.
Akamai buffers responses before forwarding — it waits for the response to complete,
which never happens with SSE. The presenter display and admin UI connect directly
to the origin to avoid this buffering.

To make SSE work through Akamai would require:
- Streaming behavior enabled (disable response buffering)
- Read timeout set to 3600+ seconds
- SureRoute and gzip compression disabled for that path

## Components

### Akamai Functions (Fermyon / Spin / Wasm)
- Handles: voter UI, vote submission, admin UI
- Outbound: calls `{CDN_HOSTNAME}/voterapp/vote` (through Akamai CDN to origin)
- Dedup token: generated from `True-Client-IP` + `User-Agent` headers at the edge

### SSE server (LKE)
- Language: Node.js / TypeScript
- All routes under `/voterapp/` prefix
- Maintains in-memory vote totals (reset on pod restart)
- Two Redis connections: one for subscribe, one for publish/commands

### Redis (LKE)
- Single pod, Bitnami Helm chart, emptyDir (no PersistentVolume)
- ClusterIP only — never exposed outside the cluster
- `SET NX voter:{token} 1 EX 3600` — deduplication (1 hour TTL)
- `PUBLISH votes {option}` — fan out to SSE server subscriber
- `KEYS voter:*` + `DEL` — used by admin clear endpoint

### Presenter display
- File: `display-ui/index.html`
- Connects via EventSource directly to `{ORIGIN_HOSTNAME}/voterapp/events`
- Tallies vote events locally, animates Chart.js bar chart
- Fullscreen on dedicated display — open directly in browser

### Admin UI
- Served by Fermyon function at `/voterapp/admin/`
- Polls `{ORIGIN_HOSTNAME}/voterapp/totals` every 5 seconds
- Also subscribes to SSE stream for real-time updates
- Clear button calls `{ORIGIN_HOSTNAME}/voterapp/admin/clear`

## Infrastructure

| Component | Platform | Notes |
|---|---|---|
| Voter UI + vote handler | Akamai Functions (Fermyon/Spin) | Wasm runtime |
| SSE server | Linode LKE | Deployment + ClusterIP service |
| Redis | Linode LKE | Bitnami Helm, no persistence |
| Ingress | Linode LKE | nginx ingress controller |
| TLS | Let's Encrypt via cert-manager | DNS-01 validation, Linode webhook |
| DNS | Linode DNS Manager | |
| CDN / edge | Akamai | Property with path-based routing |

## Security

- LKE cluster only accepts traffic on 443 from Akamai edge IPs (Akamai IPACL)
- Redis is ClusterIP only — no external exposure
- TLS auto-renewed by cert-manager (DNS-01, Linode webhook)
- Voter dedup via Redis SET NX — silent 200 on duplicate votes
- No secrets committed to git — created via kubectl directly

## Known limitations

- SSE stream cannot pass through Akamai CDN without additional property configuration
- Vote totals are in-memory — lost on SSE server pod restart
- Dedup token based on IP+UA fingerprint — sufficient for live events
- Admin UI has no authentication — access via direct URL only

## Secrets — never committed to git
```bash
kubectl create secret generic redis-secret \
  --from-literal=password=YOUR_REDIS_PASSWORD

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

# List all voter dedup keys
kubectl exec -it redis-master-0 -- redis-cli -a YOUR_PASSWORD KEYS "voter:*"

# Clear all voter tokens manually
kubectl exec -it redis-master-0 -- redis-cli -a YOUR_PASSWORD FLUSHDB

# Redeploy SSE server after image push
kubectl rollout restart deployment sse-server

# Deploy edge function
cd vote-edge-function && spin aka deploy
```
