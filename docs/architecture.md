# Architecture

## Overview

This system lets a live audience vote using their phones and displays results in real time on a presenter screen — all on Akamai / Linode infrastructure.

## Data flow

1. Audience scans QR code, opens voter UI (served from Akamai edge cache)
2. They tap an option — browser POSTs to the Akamai EdgeWorker endpoint
3. EdgeWorker validates, checks dedup in Redis (SET NX), PUBLISHes vote event
4. EdgeWorker returns 200 immediately (fire and forget)
5. SSE server pod in LKE is subscribed to Redis — streams events to open EventSource connections
6. Presenter display tab receives events, increments local tally, redraws bar chart

## Components

### Akamai EdgeWorkers (Fermyon / Wasm)
- Serves static voter HTML/JS from edge cache
- Handles POST /vote
- Validates option value and session token
- Deduplicates: SET NX voter:{fingerprint} EX 3600
- Publishes: PUBLISH votes {option}
- Returns 200 immediately

### Redis (LKE pod)
- Single pod, Bitnami Helm chart, emptyDir (no PersistentVolume)
- SET NX voter:{id} 1 EX 3600 — dedup
- PUBLISH votes {option} — fan out to SSE server
- Exposed via LoadBalancer, locked to Akamai egress IPs via firewall

### SSE server (LKE pod)
- Node.js ~50 lines
- SUBSCRIBEs to Redis votes channel
- Streams data: {event}\n\n to all open HTTP connections
- Exposed via LoadBalancer — used by presenter display

### Presenter display
- Single HTML file, no framework
- EventSource to SSE server URL
- Tallies votes locally, animates Chart.js bar chart
- Fullscreen on dedicated display

## Design decisions

| Decision | Rationale |
|---|---|
| No Cloudflare | Reliability; everything on Akamai/Linode |
| Redis pub/sub over Kafka | Simpler for single-room live event |
| No Redis persistence | Session-scoped data; emptyDir is fine |
| SSE over WebSockets | Display is read-only; SSE auto-reconnects |
| Tally in browser | No server aggregation; replays on reconnect |

## Networking

```
Internet → Akamai EdgeWorker → Redis LoadBalancer (Akamai firewall locked)
Internet → SSE server LoadBalancer → Presenter browser tab
```
