# live-audience-voting
Real-time audience voting built on Akamai EdgeWorkers, Fermyon Wasm functions, Redis on LKE, and a live SSE display
# live-audience-voting

Real-time audience voting system built entirely on Akamai / Linode infrastructure — no third-party SaaS required.

## Architecture overview

```
Voter phones  →  Akamai EdgeWorkers (Fermyon/Wasm)  →  Redis (LKE)
                                                           ↓
                                                     SSE server (LKE)
                                                           ↓
                                                  Presenter display (browser)
```

### Components

| Component | Technology | Where it runs |
|---|---|---|
| Vote endpoint + dedup | Akamai EdgeWorkers (Fermyon Wasm) | Akamai edge |
| Voter UI (static) | HTML served from edge cache | Akamai edge |
| Deduplication store | Redis (single pod, no persistence) | LKE |
| Vote pub/sub | Redis PUBLISH/SUBSCRIBE | LKE |
| Live results stream | SSE server (Node/Deno) | LKE |
| Presenter display | Vanilla JS + EventSource | Browser (fullscreen) |

### Key design decisions

- **No Cloudflare** — all infrastructure on Akamai/Linode
- - **Redis without persistence** — dedup keys are TTL-based session data; pod restarts between sessions are acceptable
  - - **Redis pub/sub over Kafka** — simpler for a single-room event; swap to Upstash Kafka if replay/durability needed
    - - **SSE over WebSockets** — display screen is read-only; SSE is simpler, auto-reconnects, works through proxies
      - - **Tally computed in the browser** — display tab counts vote events from the SSE stream locally; no server-side aggregation needed
        - - **Fire and forget at the edge** — edge function validates, deduplicates, publishes, and returns 200 immediately
         
          - ## Project structure
         
          - ```
            live-audience-voting/
            ├── README.md
            ├── docs/
            │   └── architecture.md        # detailed architecture notes
            ├── edge-function/             # Fermyon/Wasm EdgeWorker code
            │   ├── src/
            │   │   └── index.ts
            │   └── spin.toml
            ├── sse-server/                # Node SSE server — runs in LKE
            │   ├── src/
            │   │   └── index.ts
            │   ├── Dockerfile
            │   └── package.json
            ├── display-ui/                # Presenter fullscreen display
            │   └── index.html
            └── k8s/
                ├── redis-values.yaml      # Helm overrides for Redis
                └── sse-server.yaml        # K8s Deployment + Service for SSE server
            ```

            ## Getting started

            ### Prerequisites

            - `kubectl` configured against your LKE cluster
            - - `helm` v3
              - - Akamai EdgeWorker account with Fermyon/Spin CLI
               
                - ### 1. Deploy Redis on LKE
               
                - ```bash
                  helm repo add bitnami https://charts.bitnami.com/bitnami
                  helm repo update

                  helm install redis bitnami/redis \
                    --set architecture=standalone \
                    --set auth.password=YOUR_STRONG_PASSWORD \
                    --set master.persistence.enabled=false \
                    --set replica.replicaCount=0

                  # Expose via LoadBalancer (lock down with Akamai firewall rules)
                  kubectl expose deployment redis-master \
                    --type=LoadBalancer \
                    --name=redis-public \
                    --port=6379

                  # Get the public IP (takes ~60 seconds)
                  kubectl get svc redis-public
                  ```

                  ### 2. Deploy the SSE server on LKE

                  ```bash
                  kubectl apply -f k8s/sse-server.yaml
                  ```

                  ### 3. Deploy the edge function

                  ```bash
                  cd edge-function
                  spin deploy
                  ```

                  ### 4. Open the presenter display

                  Open `display-ui/index.html` in a browser tab, point it at your SSE server URL, and go fullscreen.

                  ## Firewall

                  Redis should be locked to Akamai edge egress IP ranges only. The SSE server LoadBalancer IP is public — used by the presenter display browser tab.

                  ## License

                  MIT
