import { AutoRouter } from 'itty-router';
import { SSE_SERVER_URL, ORIGIN_URL, INTERNAL_TOKEN } from './config.js';
import voterHTML from '../html/voter.html';
import adminHTML from '../html/admin.html';
import displayHTML from '../html/display.html';
import stylesCSS from '../html/styles.css';


const router = AutoRouter();

function internalFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "x-internal-token": INTERNAL_TOKEN,
    },
  });
}

function getToken(req) {
  const ip = req.headers.get("true-client-ip") ??
             req.headers.get("x-forwarded-for") ??
             "unknown";
  const ua = req.headers.get("user-agent") ?? "unknown";
  return btoa(`${ip}:${ua}`).replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);
}

function getBase(req) {
  const path = new URL(req.url).pathname;
  const markers = [
    '/api/vote', '/api/clear', '/api/totals', '/api/events', '/api/health',
    '/api/session/', '/api/question',
    '/admin/', '/admin', '/display/', '/display',
  ];
  for (const m of markers) {
    if (path.includes(m)) return path.substring(0, path.indexOf(m));
  }
  return path.replace(/\/$/, '') || '';
}

// Generic JSON proxy: forwards request to origin with internal token
async function proxyJSON(upstreamUrl, options = {}) {
  try {
    const upstream = await internalFetch(upstreamUrl, options);
    const data = await upstream.text();
    return new Response(data, {
      status: upstream.status,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
    });
  } catch {
    return new Response(JSON.stringify({ error: "Upstream error" }), {
      status: 502, headers: { "content-type": "application/json" }
    });
  }
}

function voterUI(base) {
  return new Response(
    voterHTML.replaceAll('__BASE__', base),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function adminUI(base) {
  return new Response(
    adminHTML
      .replaceAll('__BASE__', base)
      .replaceAll('__ORIGIN_URL__', ORIGIN_URL)
      .replaceAll('__INTERNAL_TOKEN__', INTERNAL_TOKEN),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function displayUI(base) {
  return new Response(
    displayHTML
      .replaceAll('__BASE__', base)
      .replaceAll('__ORIGIN_URL__', ORIGIN_URL)
      .replaceAll('__INTERNAL_TOKEN__', INTERNAL_TOKEN),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function serveCSS() {
  return new Response(stylesCSS, {
    status: 200,
    headers: { "content-type": "text/css; charset=utf-8" }
  });
}

async function handleVote(req) {
  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "content-type": "application/json" } }); }

  const token = body.token || getToken(req);
  try {
    const response = await fetch(SSE_SERVER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ option: body.option, token, setId: body.setId }),
    });
    const result = await response.json();
    return new Response(JSON.stringify(result), {
      status: response.status,
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

  // --- API routes ---
  if (path.endsWith('/api/vote') && req.method === 'POST') return handleVote(req);
  if (path.endsWith('/api/health')) return new Response('ok', { status: 200, headers: { "content-type": "text/plain" } });

  // Totals — forward ?set= query param
  if (path.endsWith('/api/totals') && req.method === 'GET') {
    const setId = url.searchParams.get('set');
    const qs = setId ? `?set=${encodeURIComponent(setId)}` : '';
    return proxyJSON(ORIGIN_URL + '/api/totals' + qs);
  }

  // Clear — forward JSON body
  if (path.endsWith('/api/clear') && req.method === 'POST') {
    const body = await req.text();
    return proxyJSON(ORIGIN_URL + '/api/clear', {
      method: 'POST',
      headers: { "content-type": "application/json" },
      body,
    });
  }

  // Session create
  if (path.endsWith('/api/session/create') && req.method === 'POST') {
    const body = await req.text();
    return proxyJSON(ORIGIN_URL + '/api/session/create', {
      method: 'POST',
      headers: { "content-type": "application/json" },
      body,
    });
  }

  // Session update
  if (path.endsWith('/api/session/update') && req.method === 'POST') {
    const body = await req.text();
    return proxyJSON(ORIGIN_URL + '/api/session/update', {
      method: 'POST',
      headers: { "content-type": "application/json" },
      body,
    });
  }

  // Session delete
  if (path.endsWith('/api/session/delete') && req.method === 'POST') {
    const body = await req.text();
    return proxyJSON(ORIGIN_URL + '/api/session/delete', {
      method: 'POST',
      headers: { "content-type": "application/json" },
      body,
    });
  }

  // Question (get active)
  if (path.endsWith('/api/question') && !path.includes('/activate') && req.method === 'GET') {
    const setId = url.searchParams.get('set');
    const qs = setId ? `?set=${encodeURIComponent(setId)}` : '';
    return proxyJSON(ORIGIN_URL + '/api/question' + qs);
  }

  // Question activate
  if (path.endsWith('/api/question/activate') && req.method === 'POST') {
    const body = await req.text();
    return proxyJSON(ORIGIN_URL + '/api/question/activate', {
      method: 'POST',
      headers: { "content-type": "application/json" },
      body,
    });
  }

  // --- UI routes ---
  if (path.endsWith('/admin') || path.endsWith('/admin/')) return adminUI(base);
  if (path.endsWith('/display') || path.endsWith('/display/')) return displayUI(base);
  if (path.endsWith('/styles.css')) return serveCSS();
  return voterUI(base);
});

addEventListener('fetch', (event) => {
  event.respondWith(router.fetch(event.request));
});
