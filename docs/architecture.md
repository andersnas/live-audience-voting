# Architecture

## Overview

Real-time audience voting system built entirely on Akamai / Linode infrastructure.
Audience members register with email, vote on their phones; results appear live on a presenter display. Supports multiple simultaneous question sets with per-question voting.

## Data flow

### Voter flow
1. Voter opens `/voterapp/?set={id}` on their phone
2. Enters email → edge function registers voter on SSE server, generates voter JWT (WebCrypto HMAC-SHA256)
3. JWT stored in `sessionStorage`, contains dedup token (hash of `setId:email`)
4. Voter sees active question (polled every 3s via `GET /api/question?set={id}`)
5. Taps an option → browser POSTs to `/api/vote` with `Authorization: Bearer {jwt}`
6. Edge function verifies JWT, extracts token, forwards `{option, token, setId}` to SSE server
7. SSE server deduplicates via Redis (`SET NX`), increments vote hash, publishes event
8. Admin and display receive vote event via SSE stream

### Admin flow
1. Admin opens `/voterapp/admin/` → sees set picker (list of sessions)
2. Clicks a session → enters access code → edge function validates via SSE server, issues admin JWT
3. Control panel: live vote counts via SSE, question queue (Previous/Next/Restart/Clear)
4. All admin operations require admin JWT in `Authorization: Bearer` header
5. Can create new sessions, edit questions, delete sessions from control panel

## URL structure

All paths under `/voterapp/`:

### HTML (served by edge function)
| Path | Description |
|---|---|
| `/voterapp/?set={id}` | Voter UI — email registration → vote → confirmation |
| `/voterapp/admin/` | Admin UI — set picker (no `?set=`) or control panel (`?set={id}`) |
| `/voterapp/display/?set={id}` | Presenter display — live Chart.js bar chart |
| `/voterapp/styles.css` | Shared stylesheet |

### API — Browser → Edge Function → SSE Server
| Path | Method | Auth | Description |
|---|---|---|---|
| `/api/voter/register` | POST | None | Register email, returns voter JWT + active question |
| `/api/admin/login` | POST | None | Validate access code, returns admin JWT + questions |
| `/api/vote` | POST | Voter JWT | Submit vote (function verifies JWT, extracts token) |
| `/api/question?set={id}` | GET | Any JWT | Active question (admin gets full question list) |
| `/api/totals?set={id}` | GET | Any JWT | Current vote totals for active question |
| `/api/sessions` | GET | None | List all sessions (name, question count, date) |
| `/api/clear` | POST | Admin JWT | Clear votes for a question |
| `/api/question/activate` | POST | Admin JWT | Activate/deactivate a question |
| `/api/session/create` | POST | Admin JWT | Create new question set |
| `/api/session/update` | POST | Admin JWT | Update questions in a set |
| `/api/session/delete` | POST | Admin JWT | Delete set and all related data |
| `/api/health` | GET | None | Health check (function-local) |

### SSE — Browser → CDN → SSE Server directly
| Path | Auth | Description |
|---|---|---|
| `/api/events?set={id}&token={internal_token}` | Query param | Live event stream for admin + display |

> Voters do NOT use SSE — they poll `/api/question` every 3 seconds.

## Auth model

### Internal token (`x-internal-token`)
- Shared secret between edge function and SSE server
- Edge function adds it to all outbound requests via `internalFetch()`
- SSE server validates on all routes except `/api/health` and `/api/vote`
- Stored in `config.js` (edge function, gitignored) and K8s secret (SSE server)

### Voter JWT
- Signed by edge function using WebCrypto HMAC-SHA256 with `INTERNAL_TOKEN` as secret
- Payload: `{ sub: email, setId, token, iat, exp }`
- `token` = SHA-256 hash of `setId:email` (deterministic dedup key)
- 1 hour expiry
- Stored in browser `sessionStorage`

### Admin JWT
- Signed by edge function using same WebCrypto method
- Payload: `{ sub: "admin", setId, role: "admin", iat, exp }`
- Edge function checks `role === "admin"` on protected routes
- 1 hour expiry

### Key principle
The edge function handles all JWT logic (sign + verify). The SSE server never sees JWTs — it only validates the `x-internal-token`.

## CDN routing (Akamai Ion)

| Path pattern | Routes to | Notes |
|---|---|---|
| `/voterapp/internal/*` | LKE origin (webservices.code4media.com) | CDN rewrites path, strips `/internal/` |
| `/voterapp/api/events` | LKE origin directly | Dedicated SSE streaming rule |
| `/voterapp/*` | Fermyon function (fwf.app) | Edge function serves HTML + proxies API |

IPACL: LKE cluster only accepts traffic from Akamai edge IPs.

## Redis schema

```
set:{id}                              → JSON { name, accessCodeHash, questions, createdAt }
set:{id}:active                       → questionId string
set:{id}:voters                       → SET of emails
set:{id}:{questionId}:votes           → HASH { A: n, B: n, C: n, D: n }
voter:{setId}:{questionId}:{token}    → "1" EX 3600 (dedup, per question)
```

Pub/sub: `votes:{setId}` channel, pattern subscribe `votes:*`

### SSE events broadcast
```
data: {"type":"activate","questionId":"q0","question":{...},"totals":{...},"total":0,"ts":...}
data: {"type":"vote","option":"A","questionId":"q0","totals":{...},"total":5,"ts":...}
data: {"type":"reset","questionId":"q0","ts":...}
data: {"type":"deactivate","ts":...}
data: {"type":"waiting","ts":...}
: heartbeat                           (every 30s)
```

## Voter UI states

| State | Condition | Transitions to |
|---|---|---|
| EMAIL | No JWT | WAITING or VOTE (after register) |
| WAITING | JWT, no active question | VOTE (polling detects new question) |
| VOTE | Active question, not voted | VOTED (after voting) |
| VOTED | Voted on active question | VOTE (new question activated) |

- Polls `/api/question` every 3s (no SSE on voter phones)
- Per-question vote state in `sessionStorage` (`voted_{setId}_{questionId}`)
- If admin clears votes (totals=0), voter's local voted state cleared on next poll

## Components

### Akamai Functions (Fermyon / Spin / Wasm)
- Serves voter UI, admin UI, display UI, and CSS
- JWT sign/verify via WebCrypto HMAC-SHA256
- Proxies all API calls to SSE server with `x-internal-token`
- Auth enforcement: validates voter/admin JWT before forwarding protected routes
- Injects set name into voter HTML server-side (fetches from SSE server)
- Build config: `src/config.js` (gitignored) — `SSE_SERVER_URL`, `ORIGIN_URL`, `INTERNAL_TOKEN`

### SSE server (LKE)
- Node.js / TypeScript
- All routes under `/voterapp/api/` prefix
- Vote totals in Redis HASH (survives pod restart)
- SSE clients tracked per set in `Map<string, Set<ServerResponse>>`
- Pub/sub scoped per set: `psubscribe("votes:*")`
- Two Redis connections: subscriber + publisher/commands

### Redis (LKE)
- Single pod, Bitnami Helm chart, `emptyDir` (no PersistentVolume)
- ClusterIP only — never exposed outside the cluster
- Vote dedup: `SET NX voter:{setId}:{questionId}:{token} 1 EX 3600`
- Vote counts: `HINCRBY set:{setId}:{questionId}:votes {option} 1`
- Pub/sub: `PUBLISH votes:{setId} {event JSON}`

## Infrastructure

| Component | Platform | Notes |
|---|---|---|
| Edge function | Akamai Functions (Fermyon/Spin) | Wasm runtime, JS SDK |
| SSE server | Linode LKE | Deployment + ClusterIP service |
| Redis | Linode LKE | Bitnami Helm, no persistence |
| Ingress | Linode LKE | nginx ingress controller |
| TLS | Let's Encrypt via cert-manager | DNS-01 validation, Linode webhook |
| CDN | Akamai Ion | Path-based routing, SSE streaming rule |

## Security

- LKE cluster only accepts traffic on 443 from Akamai edge IPs (IPACL)
- Internal API protected by shared secret (`x-internal-token` header)
- Admin routes protected by admin JWT (role check in edge function)
- Voter routes protected by voter JWT
- Redis is ClusterIP only — no external exposure
- TLS auto-renewed by cert-manager
- Voter dedup via Redis `SET NX` — silent 200 on duplicate votes
- Access code hashed with SHA-256 before storing in Redis
- No secrets or hostnames committed to git

## Build and deploy

```bash
# Edge function
cd vote-edge-function
# Copy config.example.js to config.js and fill in values first
npm run build && spin aka deploy

# SSE server
cd sse-server
npm run build
docker buildx build --platform linux/amd64,linux/arm64 -t andersnas/sse-server:latest --push .
kubectl rollout restart deployment sse-server

# Config template (vote-edge-function/src/config.js — gitignored)
export const SSE_SERVER_URL = 'https://{CDN_HOSTNAME}/voterapp/internal/api/vote';
export const ORIGIN_URL = 'https://{CDN_HOSTNAME}/voterapp/internal';
export const INTERNAL_TOKEN = 'replace-with-openssl-rand-hex-32';
```

## Secrets — never committed to git
```bash
# Redis password
kubectl create secret generic redis-secret \
  --from-literal=password=YOUR_REDIS_PASSWORD

# Internal token for SSE server
kubectl create secret generic internal-token \
  --from-literal=token=YOUR_INTERNAL_TOKEN

# Linode API token (cert-manager DNS-01 validation)
kubectl create secret generic linode-credentials \
  --namespace cert-manager \
  --from-literal=token=YOUR_LINODE_API_TOKEN
```

## Useful commands
```bash
# Watch pods
kubectl get pods --watch

# SSE server logs
kubectl logs -l app=sse-server -f

# Redis CLI
kubectl exec -it redis-master-0 -- redis-cli -a YOUR_PASSWORD

# List all sets
kubectl exec -it redis-master-0 -- redis-cli -a YOUR_PASSWORD KEYS "set:*"

# Redeploy SSE server
kubectl rollout restart deployment sse-server
```

## Project structure
```
live-audience-voting/
├── vote-edge-function/          # Fermyon/Spin Wasm
│   ├── src/
│   │   ├── index.js             # Routing, JWT, proxy logic
│   │   ├── config.js            # GITIGNORED — URLs and secrets
│   │   └── config.example.js    # Template
│   ├── html/
│   │   ├── voter.html           # Voter UI (email → vote → confirmation)
│   │   ├── admin.html           # Admin UI (set picker → login → control panel)
│   │   ├── display.html         # Presenter display (Chart.js)
│   │   └── styles.css           # Shared stylesheet
│   ├── spin.toml
│   └── webpack.config.js
├── sse-server/
│   └── src/index.ts             # Node.js SSE server
├── k8s/
│   ├── sse-server.yaml          # Deployment + Service
│   ├── sse-ingress.yaml         # nginx ingress + TLS
│   ├── cluster-issuer.yaml      # cert-manager
│   └── redis-values.yaml        # Bitnami Helm overrides
└── docs/
    └── architecture.md          # This file
```
