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

# live-audience-voting

Real-time audience voting system built entirely on Akamai / Linode infrastructure — no third-party SaaS required.

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
2. 2. Voter taps an option — browser POSTs to the Wasm vote handler
   3. 3. Wasm function validates the vote, generates a dedup token from the voter's IP and User-Agent, forwards to the SSE server
      4. 4. SSE server deduplicates via Redis (`SET NX`), publishes the event via Redis pub/sub
         5. 5. SSE server fans the event out to all connected `EventSource` clients
            6. 6. Presenter display receives the event, increments local tally, animates the bar chart
               7.
               8. ## Components
               9.
               10. | Component | Technology | Platform |
               11. |---|---|---|
               12. | Voter UI | Static HTML served by Spin | Akamai Functions (Fermyon) |
               13. | Vote handler | Spin/Wasm (JavaScript SDK) | Akamai Functions (Fermyon) |
               14. | Admin UI | Static HTML served by Spin | Akamai Functions (Fermyon) |
               15. | SSE server | Node.js / TypeScript | Linode LKE |
               16. | Vote deduplication | Redis `SET NX` | Linode LKE (ClusterIP) |
               17. | Vote pub/sub | Redis `PUBLISH/SUBSCRIBE` | Linode LKE (ClusterIP) |
               18. | Presenter display | Vanilla JS + Chart.js | Browser (fullscreen) |
               19. | Ingress | nginx ingress controller | Linode LKE |
               20. | TLS | Let's Encrypt via cert-manager | DNS-01, Linode webhook |
               21.
               22. ## URL structure
               23.
               24. All public paths are under `/voterapp/`:
               25.
               26. | Path | Description |
               27. |---|---|
               28. | `/voterapp/` | Voter UI — requires trailing slash |
               29. | `/voterapp/vote` | Vote submission (POST) |
               30. | `/voterapp/admin/` | Admin UI — live totals and clear votes |
               31. | `/voterapp/health` | Health check |
               32. | `/voterapp/events` | SSE stream — presenter display connects here directly |
               33. | `/voterapp/totals` | Current vote totals (GET) |
               34. | `/voterapp/admin/clear` | Clear all voter tokens and reset totals (POST) |
               35.
               36. > **Note:** The SSE stream (`/voterapp/events`) must be accessed directly from the origin — it cannot pass through the CDN due to response buffering. The presenter display and admin UI connect directly to the origin for this reason.
                   >
                   > ## Project structure
                   >
                   > ```
                   > live-audience-voting/
                   > ├── docs/
                   > │   └── architecture.md        # detailed architecture and operational notes
                   > ├── vote-edge-function/        # Fermyon/Spin Wasm — voter UI, vote handler, admin UI
                   > │   ├── src/index.js
                   > │   └── spin.toml
                   > ├── sse-server/                # Node.js SSE server — runs in LKE
                   > │   ├── src/index.ts
                   > │   ├── Dockerfile
                   > │   └── package.json
                   > ├── display-ui/                # Presenter fullscreen bar chart display
                   > │   └── index.html
                   > └── k8s/
                   >     ├── redis-values.yaml      # Helm overrides for Redis (no persistence)
                   >     ├── sse-server.yaml        # K8s Deployment + Service
                   >     ├── sse-ingress.yaml       # nginx ingress + cert-manager TLS
                   >     ├── cluster-issuer.yaml    # cert-manager ClusterIssuer (Let's Encrypt DNS-01)
                   >     └── README-secrets.md      # how to create K8s secrets (never committed)
                   > ```
                   >
                   > ## Getting started
                   >
                   > See `docs/architecture.md` for the full setup guide including infrastructure requirements, deployment steps, and operational commands.
                   >
                   > ## Key design decisions
                   >
                   > - **Akamai Functions for the edge** — voter UI and vote handler run as Wasm at the edge with sub-millisecond cold starts
                   > - - **SSE over WebSockets** — the presenter display is read-only; SSE is simpler, auto-reconnects, and works over plain HTTPS
                   >   - - **Redis without persistence** — dedup keys are session-scoped (1 hour TTL); pod restarts between sessions are acceptable
                   >     - - **Tally computed in the browser** — the presenter display counts vote events locally from the SSE stream; no server-side aggregation needed
                   >       - - **No external SaaS** — everything runs on Akamai / Linode infrastructure
                   >         -
                   >         - ## License
                   >         -
                   >         - MIT### Components

| Component | Technology | Where it runs |
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
| Live results stream | SSE server (Node.js) | LKE |
| Presenter display | Vanilla JS + EventSource | Browser (fullscreen) |

### Key design decisions

- **No Cloudflare** — all infrastructure on Akamai/Linode
- - **Redis without persistence** — dedup keys are TTL-based session data; pod restarts between sessions are acceptable
  - - **Redis pub/sub** — simpler than Kafka for a single-room event; swap to Upstash Kafka if replay/durability needed
    - - **SSE over WebSockets** — display screen is read-only; SSE is simpler, auto-reconnects, works through proxies
      - - **Tally computed in the browser** — display tab counts vote events locally; no server-side aggregation needed
        - - **Fire and forget at the edge** — edge function validates, deduplicates, publishes, and returns 200 immediately
          -
          - ## Project structure
          -
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

            ## Prerequisites

            The following tools must be installed and configured on your machine before deploying anything.

            - `kubectl` configured against your LKE cluster (download kubeconfig from Linode Cloud Manager → Kubernetes → your cluster)
            - - `helm` v3 — [install guide](https://helm.sh/docs/intro/install/)
              - - Akamai EdgeWorker account with Fermyon Spin CLI — [install guide](https://developer.fermyon.com/spin/v2/install)
                - - Node.js 20+ (for local SSE server development)
                  - - Docker (for building the SSE server image)
                    -
                    - ## Getting started
                    -
                    - ### 1. Deploy Redis on LKE
                    -
                    - Add the Bitnami Helm repo and install Redis as a standalone pod with no persistence:
                    -
                    - ```bash
                      helm repo add bitnami https://charts.bitnami.com/bitnami
                      helm repo update

                      helm install redis bitnami/redis \
                        -f k8s/redis-values.yaml \
                        --set auth.password=YOUR_STRONG_PASSWORD
                      ```

                      > Note: save the password — you will need it for the edge function and SSE server environment variables.
                      >
                      > Verify the pod is running (takes ~60 seconds):
                      >
                      > ```bash
                      > kubectl get pods
                      > # Wait for redis-master-0 to show STATUS = Running
                      > ```
                      >
                      > ### 2. Expose Redis via LoadBalancer
                      >
                      > ```bash
                      > kubectl expose pod redis-master-0 \
                      >   --type=LoadBalancer \
                      >   --name=redis-public \
                      >   --port=6379
                      > ```
                      >
                      > Watch for the external IP to be assigned by LKE (takes ~60 seconds):
                      >
                      > ```bash
                      > kubectl get svc redis-public --watch
                      > ```
                      >
                      > Once `EXTERNAL-IP` is populated, note it down — this is your Redis endpoint.
                      >
                      > > Security: lock this IP down to Akamai edge egress IP ranges only using an Akamai firewall rule. Do not leave Redis open to the public internet.
                      > >
                      > > Verify Redis is reachable:
                      > >
                      > > ```bash
                      > > kubectl run redis-test --rm -it --image=redis:7 -- \
                      > >   redis-cli -h <EXTERNAL-IP> -p 6379 -a YOUR_STRONG_PASSWORD ping
                      > > # Should return: PONG
                      > > ```
                      > >
                      > > ### 3. Create the Redis password secret in K8s
                      > >
                      > > The SSE server reads the Redis password from a Kubernetes secret:
                      > >
                      > > ```bash
                      > > kubectl create secret generic redis-secret \
                      > >   --from-literal=password=YOUR_STRONG_PASSWORD
                      > > ```
                      > >
                      > > ### 4. Deploy the SSE server on LKE
                      > >
                      > > Build and push the Docker image to your registry, then deploy:
                      > >
                      > > ```bash
                      > > cd sse-server
                      > > docker build -t YOUR_REGISTRY/sse-server:latest .
                      > > docker push YOUR_REGISTRY/sse-server:latest
                      > >
                      > > # Update the image name in k8s/sse-server.yaml, then:
                      > > kubectl apply -f ../k8s/sse-server.yaml
                      > >
                      > > # Get the SSE server public IP
                      > > kubectl get svc sse-server --watch
                      > > ```
                      > >
                      > > ### 5. Deploy the edge function
                      > >
                      > > ```bash
                      > > cd edge-function
                      > > spin deploy
                      > > ```
                      > >
                      > > ### 6. Open the presenter display
                      > >
                      > > Open `display-ui/index.html` in a browser tab. Set the SSE server URL:
                      > >
                      > > ```js
                      > > // At the top of the <script> block in index.html, update:
                      > > const SSE_URL = "http://<SSE-SERVER-EXTERNAL-IP>";
                      > > ```
                      > >
                      > > Then go fullscreen (`F11`) on your presenter screen.
                      > >
                      > > ## Firewall
                      > >
                      > > Redis must be locked to Akamai edge egress IP ranges only — it should never be open to the public internet. The SSE server LoadBalancer IP is intentionally public, as it is consumed directly by the presenter display browser tab.
                      > >
                      > > ## License
                      > >
                      > > MIT|---|---|---|
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
