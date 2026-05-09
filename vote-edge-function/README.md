# vote-edge-function

The Spin/Wasm function that runs at the Akamai edge. Handles:

- Serving voter, admin, and display UIs (HTML)
- JWT sign/verify via WebCrypto HMAC-SHA256
- Proxying all API calls to the SSE server with the internal token
- Auth enforcement (voter JWT, admin JWT with role check)

## Setup

```bash
npm install
cp src/config.example.js src/config.js
# Edit config.js with your URLs and INTERNAL_TOKEN
```

`src/config.js` is gitignored. It must define:

```js
export const SSE_SERVER_URL = 'https://{CDN_HOSTNAME}/voterapp/internal/api/vote';
export const ORIGIN_URL = 'https://{CDN_HOSTNAME}/voterapp/internal';
export const INTERNAL_TOKEN = 'replace-with-openssl-rand-hex-32';
```

`INTERNAL_TOKEN` is used both as the shared secret with the SSE server (sent in the `x-internal-token` header) and as the HMAC secret for signing JWTs.

## Build and deploy

```bash
npm run build && spin aka deploy
```

The build pipeline runs webpack (bundles HTML/CSS via raw-loader, JS to a single bundle), then `j2w` to compile to Wasm.

## Local development

```bash
npm run build
spin up
```

Note: `spin up` won't be able to reach a real SSE server unless `SSE_SERVER_URL` and `ORIGIN_URL` point to a reachable host.

## Project structure

```
vote-edge-function/
├── src/
│   ├── index.js                 # Router, handlers, JWT helpers
│   ├── config.js                # gitignored — real URLs/secrets
│   └── config.example.js        # template
├── html/
│   ├── voter.html               # Voter state machine
│   ├── admin.html               # Set picker → login → control panel
│   ├── display.html             # Live Chart.js bar chart
│   └── styles.css               # Shared stylesheet
├── spin.toml                    # Spin manifest, allowed_outbound_hosts
└── webpack.config.js            # raw-loader + Spin SDK plugin
```

## Routes

See [`docs/architecture.md`](../docs/architecture.md) for the full API reference with auth requirements.

## Spin/Wasm capabilities used

- `crypto.subtle` — HMAC-SHA256 for JWT signing/verification
- `crypto.randomUUID` and `crypto.getRandomValues` — supported
- `fetch` — for outbound calls to the SSE server (allowed hosts in `spin.toml`)
- `TextEncoder` / `TextDecoder` — for JWT body encoding
