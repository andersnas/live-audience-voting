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
2. Voter taps an option — browser POSTs to `/voterapp/api/vote`
3. Wasm function validates, generates a dedup token from IP+UA, forwards to SSE server
4. SSE server deduplicates via Redis (`SET NX`), publishes event via Redis pub/sub
5. SSE server fans the event out to all connected `EventSource` clients
6. Presenter display receives the event, increments local tally, animates bar chart

## Components

| Component | Technology | Platform |
|---|---|---|
| Voter UI | HTML served by Spin | Akamai Functions (Fermyon) |
| Vote handler | Spin/Wasm (JavaScript SDK) | Akamai Functions (Fermyon) |
| Admin UI | HTML served by Spin | Akamai Functions (Fermyon) |
| SSE server | Node.js / TypeScript | Linode LKE |
| Vote deduplication | Redis `SET NX` | Linode LKE (ClusterIP) |
| Vote pub/sub | Redis `PUBLISH/SUBSCRIBE` | Linode LKE (ClusterIP) |
| Presenter display | Vanilla JS + Chart.js | Browser (fullscreen) |
| Ingress | nginx ingress controller | Linode LKE |
| TLS | Let's Encrypt via cert-manager | DNS-01, Linode webhook |

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
> connect directly to the origin for SSE and admin API calls.

## Project structure
```
live-audience-voting/
├── docs/
│   └── architecture.md        # detailed architecture and operational notes
├── vote-edge-function/        # Fermyon/Spin Wasm — voter UI, admin UI, vote handler
│   ├── src/
│   │   ├── index.js           # request handler
│   │   ├── config.js          # gitignored — real URLs go here
│   │   └── config.example.js  # template — copy to config.js and fill in
│   ├── spin.toml
│   └── webpack.config.js
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

## Build configuration

The Fermyon function requires two URLs at build time. Copy `src/config.example.js`
to `src/config.js` and fill in your values:
```js
// src/config.js — gitignored, never commit real values
export const SSE_SERVER_URL = 'https://{CDN_HOSTNAME}/voterapp/api/vote';
export const ORIGIN_URL = 'https://{ORIGIN_HOSTNAME}/voterapp';
```

Then build and deploy:
```bash
cd vote-edge-function
npm run build && spin aka deploy
```

## Getting started

See `docs/architecture.md` for the full setup guide including infrastructure
requirements, deployment steps, and operational commands.

## Key design decisions

- **Akamai Functions for the edge** — voter UI and vote handler run as Wasm at the edge with sub-millisecond cold starts
- **`/api/*` prefix for all API endpoints** — clean separation between HTML pages and API calls; enables different CDN caching rules per path type
- **SSE over WebSockets** — presenter display is read-only; SSE is simpler, auto-reconnects, works over plain HTTPS
- **SSE bypasses CDN** — Akamai buffers responses before forwarding; SSE never completes so the stream is accessed directly from origin
- **Redis without persistence** — dedup keys are session-scoped (1 hour TTL); pod restarts between sessions are acceptable
- **Tally computed in the browser** — presenter display counts vote events locally from the SSE stream; no server-side aggregation needed
- **No secrets in source** — build URLs stored in gitignored `config.js`; K8s secrets created via kubectl only

## License

MIT
