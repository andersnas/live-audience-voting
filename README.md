# live-audience-voting

Real-time audience voting system built on Akamai (edge) and Linode Kubernetes Engine (origin). Audience members register with email, vote on their phones, and results appear live on a presenter display as an animated bar chart.

Supports multiple simultaneous question sets, each with multiple questions, scoped voting (one vote per email per question), per-set admin access codes, and live updates via Server-Sent Events.

## System overview

```mermaid
flowchart LR
    subgraph Browser["Browser"]
        Voter[Voter UI<br/>phone]
        Admin[Admin UI<br/>laptop]
        Display[Display UI<br/>screen]
    end

    subgraph Akamai["Akamai (edge)"]
        CDN[Akamai Ion<br/>CDN]
        Func[Spin Function<br/>WASM/JS]
    end

    subgraph LKE["Linode LKE (origin)"]
        Ingress[nginx ingress<br/>+ TLS]
        SSE[SSE server<br/>Node.js]
        Redis[(Redis<br/>persistent)]
    end

    Voter -->|HTTPS| CDN
    Admin -->|HTTPS| CDN
    Display -->|HTTPS| CDN

    CDN -->|HTML, API proxy| Func
    CDN -->|/api/events SSE| Ingress
    CDN -->|/internal/api/* with internal token| Ingress

    Func -->|"internalFetch + token"| CDN

    Ingress --> SSE
    SSE --> Redis

    style Voter fill:#003a85,color:#fff
    style Admin fill:#003a85,color:#fff
    style Display fill:#003a85,color:#fff
    style Func fill:#7a7cff,color:#fff
    style SSE fill:#04cd63,color:#fff
    style Redis fill:#a64c7a,color:#fff
```

## Components

| Component | Technology | Platform |
|---|---|---|
| Voter UI | HTML/JS served by Spin | Akamai Functions (Fermyon/Spin Wasm) |
| Admin UI | HTML/JS served by Spin | Akamai Functions |
| Display UI | HTML/JS + Chart.js served by Spin | Akamai Functions |
| Edge function | JavaScript (Spin SDK) → Wasm | Akamai Functions |
| SSE server | Node.js / TypeScript | Linode LKE |
| Storage | Redis (Bitnami chart, 1Gi PVC) | Linode LKE (ClusterIP) |
| Ingress | nginx ingress controller | Linode LKE |
| TLS | Let's Encrypt via cert-manager (DNS-01) | Linode webhook |
| CDN | Akamai Ion | Path-based routing, IPACL to LKE |

## Voter flow

```mermaid
sequenceDiagram
    actor Voter
    participant Browser
    participant Function as Spin Function
    participant SSE as SSE Server
    participant Redis

    Voter->>Browser: Open /voterapp/?set={id}
    Browser->>Function: GET HTML
    Function->>SSE: GET /question?set={id} (server-side)
    SSE->>Redis: GET set:{id}
    Redis-->>SSE: set data
    SSE-->>Function: { name }
    Function-->>Browser: HTML with set name injected

    Voter->>Browser: Enter email + Join
    Browser->>Function: POST /api/voter/register
    Function->>SSE: POST /voter/register + x-internal-token
    SSE->>Redis: SADD set:{id}:voters
    SSE-->>Function: { ok, question }
    Note over Function: Sign voter JWT (HMAC-SHA256)<br/>{sub: email, setId, token, exp}
    Function-->>Browser: { jwt, question }
    Note over Browser: Store JWT in sessionStorage

    loop Every 3s
        Browser->>Function: GET /api/question + Bearer JWT
        Function->>Function: Verify JWT
        Function->>SSE: GET /question?set={id} + token
        SSE-->>Function: { question, totals }
        Function-->>Browser: response
    end

    Voter->>Browser: Tap option
    Browser->>Function: POST /api/vote + Bearer JWT
    Function->>Function: Verify JWT, extract token
    Function->>SSE: POST /vote {option, token, setId}
    SSE->>Redis: SET NX voter:{setId}:{qId}:{token}
    SSE->>Redis: HINCRBY set:{setId}:{qId}:votes
    SSE->>Redis: PUBLISH votes:{setId}
    SSE-->>Function: { ok: true }
    Function-->>Browser: { ok: true }
```

## Admin flow

```mermaid
sequenceDiagram
    actor Admin
    participant Browser
    participant Function as Spin Function
    participant SSE as SSE Server
    participant Redis

    Admin->>Browser: Open /voterapp/admin/
    Browser->>Function: GET admin HTML
    Function-->>Browser: HTML
    Browser->>Function: GET /api/sessions
    Function->>SSE: GET /sessions + token
    SSE->>Redis: KEYS set:*
    Redis-->>SSE: list
    SSE-->>Function: sessions[]
    Function-->>Browser: sessions[]
    Note over Browser: Show set picker

    Admin->>Browser: Click set + enter access code
    Browser->>Function: POST /api/admin/login {setId, accessCode}
    Function->>SSE: POST /admin/login + token
    SSE->>Redis: GET set:{id}
    Note over SSE: Compare SHA-256(accessCode)<br/>to stored hash
    SSE-->>Function: { ok, name, questions }
    Note over Function: Sign admin JWT<br/>{sub: admin, setId, role: admin, exp}
    Function-->>Browser: { jwt, name, questions }

    Note over Browser: SSE EventSource direct via CDN
    Browser->>SSE: GET /api/events?set={id}&token=internal
    SSE-->>Browser: SSE stream

    Admin->>Browser: Click "Next" question
    Browser->>Function: POST /api/question/activate + Bearer admin JWT
    Function->>Function: Verify admin JWT (role check)
    Function->>SSE: POST /question/activate + token
    SSE->>Redis: SET set:{id}:active
    SSE->>Redis: PUBLISH votes:{id} {type:activate}
    SSE-->>Function: { ok }
    Function-->>Browser: { ok }
    Note over Browser: SSE pushes activate event<br/>to admin + display
```

## Auth model

```mermaid
flowchart TB
    subgraph Browser
        VoterJWT[Voter JWT<br/>sessionStorage]
        AdminJWT[Admin JWT<br/>sessionStorage]
    end

    subgraph Function["Spin Function (edge)"]
        Sign[Sign JWT<br/>WebCrypto HMAC-SHA256]
        Verify[Verify JWT<br/>+ role check]
        IntFetch[internalFetch<br/>add x-internal-token]
    end

    subgraph SSE["SSE Server (origin)"]
        TokenCheck[Validate<br/>x-internal-token]
        Routes[Route handlers]
    end

    Browser -->|"Authorization: Bearer"| Verify
    Verify --> IntFetch
    IntFetch -->|"x-internal-token header"| TokenCheck
    TokenCheck --> Routes

    Sign -.->|signed with INTERNAL_TOKEN as HMAC secret| VoterJWT
    Sign -.-> AdminJWT
```

**Three layers of auth:**

1. **Internal token** — shared secret between Function and SSE server. Function adds it on every outbound call. SSE server validates it on all routes except `/health` and `/vote`.
2. **Voter JWT** — issued by Function after email registration. Required on `/api/vote` and `/api/question`. Contains a deterministic dedup token (hash of `setId:email`).
3. **Admin JWT** — issued by Function after access code login. Required on all admin operations (`/api/clear`, `/api/question/activate`, `/api/session/*`). Has `role: "admin"` claim.

The Function handles all JWT logic. The SSE server never sees JWTs — only the internal token.

## Voter state machine

```mermaid
stateDiagram-v2
    [*] --> EMAIL: No JWT
    EMAIL --> WAITING: Register, no active question
    EMAIL --> VOTE: Register, question active

    WAITING --> VOTE: Poll detects active question
    VOTE --> VOTED: Submit vote
    VOTED --> VOTE: New question activated
    VOTED --> WAITING: Question deactivated
    VOTE --> WAITING: Question deactivated

    note right of WAITING
        Polls /api/question every 3s
        with voter JWT
    end note

    note right of VOTED
        Cleared if totals=0
        (admin cleared votes)
    end note
```

## Repository layout

```
live-audience-voting/
├── README.md                    # This file
├── docs/
│   └── architecture.md          # Detailed architecture, Redis schema, deployment
├── vote-edge-function/          # Spin function (HTML + JS + WASM)
│   ├── src/
│   │   ├── index.js             # Routing, JWT, proxy logic
│   │   ├── config.js            # GITIGNORED — URLs and secrets
│   │   └── config.example.js    # Template
│   ├── html/
│   │   ├── voter.html           # Voter UI with state machine
│   │   ├── admin.html           # Admin UI (set picker → login → control panel)
│   │   ├── display.html         # Presenter display (Chart.js)
│   │   └── styles.css           # Shared stylesheet
│   ├── spin.toml                # Spin manifest
│   └── webpack.config.js
├── sse-server/                  # Node.js SSE server
│   ├── src/index.ts
│   ├── Dockerfile
│   └── package.json
├── k8s/
│   ├── sse-server.yaml          # Deployment + Service
│   ├── sse-ingress.yaml         # nginx ingress + TLS
│   ├── cluster-issuer.yaml      # cert-manager (Let's Encrypt DNS-01)
│   └── redis-values.yaml        # Bitnami Redis Helm overrides (1Gi PVC)
└── loadtest/
    ├── locustfile.py            # Locust test, simulates 300+ voters
    └── README.md                # Test scenarios + monitoring tips
```

## Quick start

1. **Create the first session** (bootstrap via curl — see `docs/architecture.md`)
2. **Build and deploy the edge function:**
   ```bash
   cd vote-edge-function
   cp src/config.example.js src/config.js
   # Edit config.js with your URLs and INTERNAL_TOKEN
   npm install && npm run build && spin aka deploy
   ```
3. **Build and deploy the SSE server:**
   ```bash
   cd sse-server
   docker buildx build --platform linux/amd64,linux/arm64 \
     -t YOUR_DOCKER_USER/sse-server:latest --push .
   kubectl apply -f ../k8s/
   ```
4. **Open the admin UI** at `https://{CDN_HOSTNAME}/voterapp/admin/`, pick the session, log in.

See `docs/architecture.md` for the full setup guide, Redis schema, API reference, and deployment commands.

## Key design decisions

- **Spin function for edge logic** — JWT sign/verify via WebCrypto runs at the edge with sub-millisecond cold starts.
- **All API calls proxied through the function** — except SSE events (CDN buffering would break the stream).
- **JWT auth in the Function, not the SSE server** — keeps the backend simple. SSE server only validates internal token.
- **Voter dedup per question, not per session** — `voter:{setId}:{questionId}:{token}` allows voting on each question once.
- **Voters poll, admin/display use SSE** — phones don't hold long-lived connections; presenter and admin do.
- **Redis with persistence** — sessions and questions survive restarts; vote dedup keys still expire (1h TTL).
- **No secrets in source** — `config.js` gitignored, K8s secrets created via kubectl only.

## License

MIT
