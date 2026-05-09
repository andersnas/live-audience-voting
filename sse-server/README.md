# sse-server

Node.js/TypeScript server running in Linode LKE. Handles all stateful operations:

- Question set CRUD
- Vote recording (Redis HASH)
- Vote deduplication (Redis SET NX with TTL)
- SSE streaming to admin and display clients
- Pub/sub between server replicas via Redis (`votes:{setId}` channel pattern)

## Setup

```bash
npm install
```

Required env vars:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | `""` | Redis password |
| `SESSION_TTL` | `3600` | Vote dedup key TTL (seconds) |
| `INTERNAL_TOKEN` | `""` | Shared secret for the `x-internal-token` header |

If `INTERNAL_TOKEN` is unset, the server runs in dev mode and accepts all requests with a warning.

## Build and run locally

```bash
npm run build
npm start
```

## Build Docker image (multi-arch)

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t YOUR_DOCKER_USER/sse-server:latest --push .
```

## Deploy to LKE

```bash
kubectl apply -f ../k8s/sse-server.yaml
kubectl rollout restart deployment sse-server
```

K8s secrets `redis-secret` and `internal-token` must exist before applying. See `k8s/README-secrets.md` (not committed) or the architecture docs.

## Endpoints

All under `/voterapp/api/`. See [`docs/architecture.md`](../docs/architecture.md#api-routing) for the full reference with auth requirements.

## Redis schema

```
set:{id}                              → JSON QuestionSet
set:{id}:active                       → questionId
set:{id}:voters                       → SET of emails
set:{id}:{questionId}:votes           → HASH option → count
voter:{setId}:{questionId}:{token}    → "1" EX 3600
```

Pub/sub channel: `votes:{setId}`. The subscriber uses `psubscribe("votes:*")` to receive events for all sets.
