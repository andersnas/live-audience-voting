# Architecture

## Overview

Real-time audience voting system built entirely on Akamai / Linode infrastructure.
Audience members vote on their phones; results appear live on a presenter display.

## Data flow

1. Audience member scans a QR code, opens the voter UI (served from Akamai edge cache)
2. They tap a vote option — browser POSTs to the Akamai Function (Fermyon/Spin) endpoint
3. Akamai Function validates the payload, makes an HTTPS POST to the SSE server `/vote` endpoint
4. SSE server checks deduplication in Redis (SET NX), publishes vote event (PUBLISH)
5. SSE server fans out the event to all open SSE connections
6. Presenter display browser tab receives the event, increments local tally, redraws bar chart

## Why the edge function talks to the SSE server (not Redis directly)

Akamai Functions (Fermyon/Spin) can only make outbound HTTPS requests — no raw TCP.
Redis speaks TCP on port 6379, unreachable from the edge runtime.
The SSE server acts as the HTTPS gateway in front of Redis, handling both:
- POST /vote — dedup + publish
- GET /    — SSE stream to presenter display

## Components

### Akamai Functions (Fermyon / Spin / Wasm)
- Serves static voter HTML/JS from edge cache
- Handles POST /vote from voter phones
- Validates option and session token
- Makes HTTPS POST to SSE server /vote endpoint
- Returns 200 immediately

### SSE server (LKE)
- Node.js / TypeScript
- POST /vote — dedup via Redis SET NX, publish via Redis PUBLISH
- GET /      — SSE stream, fans out Redis events to all connected clients
- GET /health — liveness/readiness probe
- Deployed as Kubernetes Deployment + ClusterIP Service
- Exposed via nginx ingress on port 443 with Let's Encrypt TLS
- Live at: https://web{CDN_HOSTNAME}

### Redis (LKE)
- Single pod, Bitnami Helm chart, emptyDir (no PersistentVolume)
- Session-scoped data only — pod restart between events is acceptable
- ClusterIP service only — never exposed outside the cluster
- SET NX voter:{token} 1 EX 3600 — deduplication
- PUBLISH votes {option}          — fan out to SSE server

### Presenter display
- Single HTML file, no framework
- EventSource connects to https://web{CDN_HOSTNAME}/
- Tallies vote events locally, animates Chart.js bar chart
- Fullscreen on dedicated display

## Infrastructure

| Component        | Platform                  | Notes                          |
|------------------|---------------------------|--------------------------------|
| Akamai Functions | Akamai edge (Fermyon/Spin)| Wasm runtime                   |
| SSE server       | Linode LKE                | Deployment + ClusterIP service |
| Redis            | Linode LKE                | Bitnami Helm, no persistence   |
| Ingress          | Linode LKE                | nginx ingress controller       |
| TLS              | Let's Encrypt / cert-manager | DNS-01 via Linode API       |
| DNS              | Linode DNS Manager        | {DOMAIN} zone            |

## Networking
```
Voter phone
  └── HTTPS → Akamai Function (Fermyon/Spin)
                └── HTTPS POST /vote → web{CDN_HOSTNAME} (Akamai IPACL)
                                          └── nginx ingress (443)
                                                └── SSE server pod
                                                      └── Redis (ClusterIP only)

Presenter display
  └── HTTPS GET / (EventSource) → web{CDN_HOSTNAME}
                                    └── nginx ingress → SSE server pod
```

## Security

- LKE cluster only accepts traffic on 443 from Akamai edge IPs (Akamai IPACL)
- Redis is ClusterIP only — no external exposure
- TLS auto-renewed by cert-manager (DNS-01, Linode webhook)
- Voter dedup via SET NX with session token — silent 200 on duplicate
- No secrets committed to git — created via kubectl directly

## Key design decisions

| Decision                        | Rationale                                              |
|---------------------------------|--------------------------------------------------------|
| No Cloudflare                   | Reliability; everything on Akamai/Linode               |
| SSE server as Redis gateway     | Akamai Functions can only make HTTPS calls, not TCP    |
| Redis pub/sub over Kafka        | Simpler for single-room event; no replay needed        |
| No Redis persistence            | Session-scoped data; emptyDir is fine                  |
| SSE over WebSockets             | Display is read-only; SSE simpler and auto-reconnects  |
| Tally in browser                | No server aggregation; replays from stream on reconnect|
| DNS-01 cert validation          | HTTP-01 not viable — cluster only accepts Akamai IPs   |

## Endpoints

| Endpoint                                     | Method | Description                        |
|----------------------------------------------|--------|------------------------------------|
| https://web{CDN_HOSTNAME}/          | GET    | SSE stream (presenter display)     |
| https://web{CDN_HOSTNAME}/vote      | POST   | Submit vote (called by Akamai Fn)  |
| https://web{CDN_HOSTNAME}/health    | GET    | Health check (K8s probes)          |

## Secrets — never committed to git

Create directly via kubectl:
```bash
# Redis password
kubectl create secret generic redis-secret \
  --from-literal=password=YOUR_REDIS_PASSWORD

# Linode API token (cert-manager DNS-01 validation)
kubectl create secret generic linode-credentials \
  --namespace cert-manager \
  --from-literal=token=YOUR_LINODE_API_TOKEN
```
