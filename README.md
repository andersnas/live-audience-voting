# live-audience-voting

Real-time audience voting system built entirely on Akamai / Linode infrastructure.

## What it does

Audience members open a URL on their phones, tap a vote option, and results appear instantly on a presenter display as a live animated bar chart. The system handles deduplication so each person can only vote once per session.

## Architecture
```
Voter phone
  └── Akamai Functions (Fermyon/Spin Wasm)
        └── SSE server (Linode LKE)
              └── Redis (Linode LKE, internal only)
                    └── SSE stream → Presenter display
```

### How it works

1. Voter opens the voter UI served from Akamai Functions (Fermyon/Spin)
2. Voter taps an option — browser POSTs to the Wasm vote handler
3. Wasm function validates the vote, generates a dedup token from the voter's IP and User-Agent, forwards to the SSE server
4. SSE server deduplicates via Redis (`SET NX`), publishes the event via Redis pub/sub
5. SSE server fans the event out to all connected `EventSource` clients
6. Presenter display receives the event, increments local tally, animates the bar chart

## Components

| Component | Technology | Platform |
|---|---|---|
| Voter UI | Static HTML served by Spin | Akamai Functions (Fermyon) |
| Vote handler | Spin/Wasm (JavaScript SDK) | Akamai Functions (Fermyon) |
| Admin UI | Static HTML served by Spin | Akamai Functions (Fermyon) |
| SSE server | Node.js / TypeScript | Linode LKE |
| Vote deduplication | Redis `SET NX` | Linode LKE (ClusterIP) |
| Vote pub/sub | Redis `PUBLISH/SUBSCRIBE` | Linode LKE (ClusterIP) |
| Presenter display | Vanilla JS + Chart.js | Browser (fullscreen) |
| Ingress | nginx ingress controller | Linode LKE |
| TLS | Let's Encrypt via cert-manager | DNS-01, Linode webhook |

## URL structure

All public paths are under `/voterapp/`:

| Path | Description |
|---|---|
| `/voterapp/` | Voter UI — requires trailing slash |
| `/voterapp/vote` | Vote submission (POST) |
| `/voterapp/admin/` | Admin UI — live totals and clear votes |
| `/voterapp/health` | Health check |
| `/voterapp/events` | SSE stream — presenter display connects here directly |
| `/voterapp/totals` | Current vote totals (GET) |
| `/voterapp/admin/clear` | Clear all voter tokens and reset totals (POST) |

> **Note:** The SSE stream (`/voterapp/events`) must be accessed directly from the origin — it cannot pass through the CDN due to response buffering. The presenter display and admin UI connect directly to the origin for this reason.

## Project structure
```
live-audience-voting/
├── docs/
│   └── architecture.md        # detailed architecture and operational notes
├── vote-edge-function/        # Fermyon/Spin Wasm — voter UI, vote handler, admin UI
│   ├── src/index.js
│   └── spin.toml
├── sse-server/                # Node.js SSE server — runs in LKE
│   ├── src/index.ts
│   ├── Dockerfile
│   └── package.json
├── display-ui/                # Presenter fullscreen bar chart display
│   └── index.html
└── k8s/
    ├── redis-values.yaml      # Helm overrides for Redis (no persistence)
    ├── sse-server.yaml        # K8s Deployment + Service
    ├── sse-ingress.yaml       # nginx ingress + cert-manager TLS
    ├── cluster-issuer.yaml    # cert-manager ClusterIssuer (Let's Encrypt DNS-01)
    └── README-secrets.md      # how to create K8s secrets (never committed)
```

## Getting started

See `docs/architecture.md` for the full setup guide including infrastructure requirements, deployment steps, and operational commands.

## Key design decisions

- **Akamai Functions for the edge** — voter UI and vote handler run as Wasm at the edge with sub-millisecond cold starts
- **SSE over WebSockets** — the presenter display is read-only; SSE is simpler, auto-reconnects, and works over plain HTTPS
- **Redis without persistence** — dedup keys are session-scoped (1 hour TTL); pod restarts between sessions are acceptable
- **Tally computed in the browser** — the presenter display counts vote events locally from the SSE stream; no server-side aggregation needed
- **No external SaaS** — everything runs on Akamai / Linode infrastructure

## License

MIT
