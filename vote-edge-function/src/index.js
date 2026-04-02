import { AutoRouter } from 'itty-router';

const router = AutoRouter();

const SSE_SERVER_URL = "https://webservices.code4media.com/voterapp/vote";
const VALID_OPTIONS = ["A", "B", "C", "D"];

// Generate a dedup token from request headers
function getToken(req) {
  const ip = req.headers.get("x-forwarded-for") ??
             req.headers.get("true-client-ip") ??
             req.headers.get("x-real-ip") ??
             "unknown";
  const ua = req.headers.get("user-agent") ?? "unknown";
  return btoa(`${ip}:${ua}`).replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);
}

// CORS preflight
router.options("/vote", () => new Response(null, {
  status: 204,
  headers: {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  },
}));

// POST /vote — validate and forward to SSE server
router.post("/vote", async (req) => {
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // Validate option
  if (!body.option || !VALID_OPTIONS.includes(body.option)) {
    return new Response(JSON.stringify({ error: "Invalid option" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // Generate dedup token from request fingerprint
  const token = getToken(req);

  // Forward to SSE server
  try {
    const response = await fetch(SSE_SERVER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ option: body.option, token }),
    });
    const result = await response.json();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Upstream error" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
});

// Catch all
router.all("*", () => new Response("Not found", { status: 404 }));

addEventListener('fetch', (event) => {
  event.respondWith(router.fetch(event.request));
});
