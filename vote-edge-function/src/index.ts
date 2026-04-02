import { AutoRouter } from 'itty-router';

const router = AutoRouter();

const SSE_SERVER_URL = "https://webservices.code4media.com/vote";
const VALID_OPTIONS = ["A", "B", "C", "D"];

// Generate a session token from the request — use IP + User-Agent as fingerprint
function getToken(req: Request): string {
  const ip = req.headers.get("x-forwarded-for") ?? 
             req.headers.get("cf-connecting-ip") ?? 
             req.headers.get("x-real-ip") ?? 
             "unknown";
  const ua = req.headers.get("user-agent") ?? "unknown";
  // Simple hash — combine ip + ua into a token
  return btoa(`${ip}:${ua}`).replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);
}

// POST /vote — validate and forward to SSE server
router.post("/vote", async (req: Request) => {
  let body: { option?: string };
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

  // Generate session token from request fingerprint
  const token = getToken(req);

  // Forward to SSE server
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
});

// OPTIONS — CORS preflight
router.options("/vote", () => new Response(null, {
  status: 204,
  headers: {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  },
}));

// Catch all
router.all("*", () => new Response("Not found", { status: 404 }));

export default {
  fetch: router.fetch,
};
