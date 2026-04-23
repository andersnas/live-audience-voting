# Load testing

Simulates human-like voter behavior with Locust:

1. Loads the voter HTML page
2. Pauses 2-5s (reading + typing email)
3. Registers with a unique email, receives JWT
4. Polls `/api/question` every ~3s (matches real voter UI)
5. When a question is active: pauses 3-10s (thinking), then votes
6. Keeps polling; votes again on each new question activated by admin

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install locust
```

Use `.venv/bin/locust` for the commands below, or activate with `source .venv/bin/activate`.

## Run

```bash
cd loadtest

# Web UI (recommended for interactive testing)
SET_ID=<your-set-id> locust -f locustfile.py \
  --host https://{CDN_HOSTNAME}

# Then open http://localhost:8089 and start with 300 users at spawn rate 5/s

# Headless mode
SET_ID=<your-set-id> locust -f locustfile.py \
  --host https://{CDN_HOSTNAME} \
  --users 300 --spawn-rate 5 \
  --run-time 10m --headless
```

## During the test

Open the admin UI in another window and activate/advance questions to trigger
vote rounds. The simulated voters will pick up new questions via polling and
vote within 3-10 seconds.

## Test scenarios

| Scenario | Command | Purpose |
|---|---|---|
| Ramp up | `--users 300 --spawn-rate 5` | Gradual increase (300 users in 60s) |
| Spike | `--users 300 --spawn-rate 300` | Worst-case sudden load |
| Sustained | `--users 300 --run-time 15m` | Find memory leaks, stability |
| Stress | `--users 500 --spawn-rate 10` | Find breaking point |

## What to watch

- **p95 / p99 response times** for `POST /api/vote` and `GET /api/question`
- **Failure rate** — should stay near 0%
- **Throughput** (requests/second) — indicates capacity ceiling
- **Admin UI responsiveness** — admin should remain usable during load
- **Display UI** — SSE events should still flow (watch the live chart)

## Server-side monitoring

While load test runs, watch resource usage:

```bash
export KUBECONFIG=/path/to/kubeconfig.yaml

# Live pod CPU/memory
kubectl top pods --watch

# SSE server logs (vote records, errors)
kubectl logs -l app=sse-server -f

# Redis memory
kubectl exec -it redis-master-0 -- redis-cli -a YOUR_PASSWORD INFO memory
```

## Notes

- Each simulated voter creates a persistent Redis key (`voter:{setId}:{questionId}:{token}`)
  that expires after 1 hour. For repeat tests, consider calling `/api/clear` from admin
  or wait for TTL.
- The voter UI uses unique emails per simulated user (UUID-based), so each counts as a
  distinct voter. Load test emails: `loadtest_{uuid}@example.com`
- The test requires an existing set. Create one via the bootstrap curl (see
  `docs/architecture.md`) before running.
