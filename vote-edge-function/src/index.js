import { AutoRouter } from 'itty-router';
import { SSE_SERVER_URL, ORIGIN_URL } from './config.js';
import voterHTML from '../html/voter.html';
import adminHTML from '../html/admin.html';
import displayHTML from '../html/display.html';

const router = AutoRouter();
const VALID_OPTIONS = ["A", "B", "C", "D"];

function getToken(req) {
  const ip = req.headers.get("true-client-ip") ??
             req.headers.get("x-forwarded-for") ??
             "unknown";
  const ua = req.headers.get("user-agent") ?? "unknown";
  return btoa(`${ip}:${ua}`).replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);
}

function getBase(req) {
  const path = new URL(req.url).pathname;
  const markers = ['/api/vote', '/api/clear', '/api/totals', '/api/events', '/api/health', '/admin/', '/admin'];
  for (const m of markers) {
    if (path.includes(m)) return path.substring(0, path.indexOf(m));
  }
  return path.replace(/\/$/, '') || '';
}

function voterUI(base) {
  return new Response(
    voterHTML.replace('__BASE__', base),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function adminUI() {
  return new Response(
    adminHTML.replace('__ORIGIN_URL__', ORIGIN_URL),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function displayUI() {
  const sseUrl = SSE_SERVER_URL.replace('/api/vote', '/api/events');
  return new Response(
    displayHTML.replace('"__SSE_URL__"', JSON.stringify(sseUrl)),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

async function handleVote(req) {
  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "content-type": "application/json" } }); }
  if (!body.option || !VALID_OPTIONS.includes(body.option)) {
    return new Response(JSON.stringify({ error: "Invalid option" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const token = body.token || getToken(req);
  try {
    const response = await fetch(SSE_SERVER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ option: body.option, token }),
    });
    const result = await response.json();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
    });
  } catch {
    return new Response(JSON.stringify({ error: "Upstream error" }), { status: 502, headers: { "content-type": "application/json" } });
  }
}

router.options("*", () => new Response(null, {
  status: 204,
  headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "content-type" }
}));

router.all("*", async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const base = getBase(req);

  if (path.endsWith('/api/vote') && req.method === 'POST') return handleVote(req);
  if (path.endsWith('/api/health')) return new Response('ok', { status: 200, headers: { "content-type": "text/plain" } });
  if (path.endsWith('/admin') || path.endsWith('/admin/')) return adminUI();
  if (path.endsWith('/display') || path.endsWith('/display/')) return displayUI();
  return voterUI(base);
});

addEventListener('fetch', (event) => {
  event.respondWith(router.fetch(event.request));
});
