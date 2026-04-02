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
