# Architecture

## Overview

Real-time audience voting system built entirely on Akamai / Linode infrastructure.
Audience members vote on their phones; results appear live on a presenter display.

## Data flow

1. Audience member opens `https://{CDN_HOSTNAME}/voterapp/` on their phone
2. They tap a vote option — browser POSTs to `{CDN_HOSTNAME}/voterapp/vote`
3. Akamai forwards the request to `web{CDN_HOSTNAME}/voterapp/vote`
4. SSE server validates, deduplicates via Redis (SET NX), publishes event (PUBLISH)
5. SSE server fans out the event to all open `/voterapp/events` connections
6. Presenter display receives event, increments local tally, redraws bar chart

## URL structure

| Public URL | Forwards to | Description |
|---|---|---|
| `{CDN_HOSTNAME}/voterapp/` | `web{CDN_HOSTNAME}/voterapp/` | Voter UI |
| `{CDN_HOSTNAME}/voterapp/vote` | `web{CDN_HOSTNAME}/voterapp/vote` | Vote endpoint |
| `{CDN_HOSTNAME}/voterapp/health` | `web{CDN_HOSTNAME}/voterapp/health` | Health check |
| `web{CDN_HOSTNAME}/voterapp/events` | SSE server direct | Presenter display (bypasses Akamai) |

## Why /voterapp/events bypasses Akamai

SSE is a long-lived HTTP response that streams data in chunks indefinitely.
Akamai buffers responses before forwarding — it waits for the response to complete,
which never happens with SSE. The presenter display connects directly to
web{CDN_HOSTNAME} to avoid this buffering. This is acceptable because the
presenter display is a controlled environment (one laptop/screen), not a public endpoint.

To make SSE work through Akamai would require:
- Streaming behavior enabled on the /voterapp/events path
- Read timeout set to 3600+ seconds
- Response buffering disabled
- SureRoute and gzip disabled for that path

## Components

### Akamai Functions (Fermyon / Spin / Wasm)
- Deployed at: https://{FUNCTION_HOSTNAME}
- Handles POST /voterapp/vote from voter phones
- Validates option and generates session token from request fingerprint
- Forwards to SSE server at web{CDN_HOSTNAME}/voterapp/vote
- Returns 200 immediately

### SSE server (LKE)
- Node.js / TypeScript
- All routes under /voterapp/ prefix
- GET  /voterapp/health  — health check (K8s probes)
- GET  /voterapp/events  — SSE stream for presenter display
- POST /voterapp/vote    — dedup + publish vote
- GET  /voterapp/        — voter UI HTML (coming soon)

### Redis (LKE)
- Single pod, Bitnami Helm chart, emptyDir (no PersistentVolume)
- ClusterIP only — never exposed outside cluster
- SET NX voter:{token} 1 EX 3600 — deduplication
- PUBLISH votes {option}          — fan out to SSE server

### Presenter display
- Single HTML file
- EventSource connects directly to https://web{CDN_HOSTNAME}/voterapp/events
- Tallies vote events locally, animates Chart.js bar chart
- Fullscreen on dedicated display

## Infrastructure

| Component        | Platform                   | Notes                          |
|------------------|----------------------------|--------------------------------|
| Akamai Functions | Akamai edge (Fermyon/Spin) | Wasm runtime, {FUNCTION_DOMAIN}          |
| SSE server       | Linode LKE                 | Deployment + ClusterIP service |
| Redis            | Linode LKE                 | Bitnami Helm, no persistence   |
| Ingress          | Linode LKE                 | nginx ingress controller       |
| TLS              | Let's Encrypt / cert-manager | DNS-01 via Linode API        |
| DNS              | Linode DNS Manager         | {DOMAIN} zone            |

## Security

- LKE cluster only accepts traffic on 443 from Akamai edge IPs (Akamai IPACL)
- Redis is ClusterIP only — no external exposure
- TLS auto-renewed by cert-manager (DNS-01, Linode webhook)
- Voter dedup via SET NX — silent 200 on duplicate votes
- No secrets committed to git — created via kubectl directly

## Secrets — never committed to git
```bash
kubectl create secret generic redis-secret \
  --from-literal=password=YOUR_REDIS_PASSWORD

kubectl create secret generic linode-credentials \
  --namespace cert-manager \
  --from-literal=token=YOUR_LINODE_API_TOKEN
```
