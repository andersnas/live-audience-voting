import { AutoRouter } from 'itty-router';
import { SSE_SERVER_URL, ORIGIN_URL, INTERNAL_TOKEN } from './config.js';
import voterHTML from '../html/voter.html';
import adminHTML from '../html/admin.html';
import displayHTML from '../html/display.html';
import stylesCSS from '../html/styles.css';


const router = AutoRouter();
const SESSION_TTL = 3600; // 1 hour JWT expiry

// --- JWT helpers (WebCrypto HMAC-SHA256) ---

function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function getSigningKey() {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(INTERNAL_TOKEN),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

async function signJWT(payload) {
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await getSigningKey();
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${base64url(sig)}`;
}

async function verifyJWT(jwt) {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const key = await getSigningKey();
  const valid = await crypto.subtle.verify(
    'HMAC', key,
    base64urlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) return null;
  const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function hashToken(setId, email) {
  const data = new TextEncoder().encode(`${setId}:${email.toLowerCase()}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64url(hash).substring(0, 32);
}

async function requireAdmin(req) {
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  const payload = await verifyJWT(token);
  if (!payload || payload.role !== 'admin') return null;
  return payload;
}

function unauthorized(msg = "Admin authorization required") {
  return new Response(JSON.stringify({ error: msg }), {
    status: 401, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
  });
}

function internalFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "x-internal-token": INTERNAL_TOKEN,
    },
  });
}

function getBase(req) {
  const path = new URL(req.url).pathname;
  const markers = [
    '/api/vote', '/api/clear', '/api/totals', '/api/events', '/api/health',
    '/api/session/', '/api/question', '/api/admin/', '/api/voter/',
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

async function voterUI(base, setId) {
  let setName = '';
  if (setId) {
    try {
      const res = await internalFetch(ORIGIN_URL + '/api/question?set=' + encodeURIComponent(setId));
      const data = await res.json();
      setName = data.name || '';
    } catch {}
  }
  return new Response(
    voterHTML
      .replaceAll('__BASE__', base)
      .replaceAll('__SET_ID__', setId || '')
      .replaceAll('__SET_NAME__', setName),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function adminUI(base, setId) {
  return new Response(
    adminHTML
      .replaceAll('__BASE__', base)
      .replaceAll('__ORIGIN_URL__', ORIGIN_URL)
      .replaceAll('__INTERNAL_TOKEN__', INTERNAL_TOKEN)
      .replaceAll('__SET_ID__', setId || ''),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function displayUI(base, setId) {
  return new Response(
    displayHTML
      .replaceAll('__BASE__', base)
      .replaceAll('__ORIGIN_URL__', ORIGIN_URL)
      .replaceAll('__INTERNAL_TOKEN__', INTERNAL_TOKEN)
      .replaceAll('__SET_ID__', setId || ''),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function serveCSS() {
  return new Response(stylesCSS, {
    status: 200,
    headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" }
  });
}

async function handleVote(req) {
  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }); }

  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return new Response(JSON.stringify({ error: "Authorization header required" }), {
      status: 401, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
    });
  }

  const payload = await verifyJWT(token);
  if (!payload) {
    return new Response(JSON.stringify({ error: "Invalid or expired JWT" }), {
      status: 401, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
    });
  }

  try {
    const response = await fetch(SSE_SERVER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ option: body.option, token: payload.token, setId: payload.setId }),
    });
    const result = await response.json();
    return new Response(JSON.stringify(result), {
      status: response.status,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
    });
  } catch {
    return new Response(JSON.stringify({ error: "Upstream error" }), { status: 502, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
  }
}

router.options("*", () => new Response(null, {
  status: 204,
  headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "content-type, authorization" }
}));

router.all("*", async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const base = getBase(req);

  // --- API routes ---
  if (path.endsWith('/api/vote') && req.method === 'POST') return handleVote(req);
  if (path.endsWith('/api/health')) return new Response('ok', { status: 200, headers: { "content-type": "text/plain" } });

  // Voter register — edge function generates JWT
  if (path.endsWith('/api/voter/register') && req.method === 'POST') {
    try {
      const body = await req.json();
      const { email, setId } = body;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return new Response(JSON.stringify({ error: "Valid email is required" }), {
          status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
        });
      }
      if (!setId) {
        return new Response(JSON.stringify({ error: "setId is required" }), {
          status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
        });
      }

      // Register email on SSE server
      const upstream = await internalFetch(ORIGIN_URL + '/api/voter/register', {
        method: 'POST',
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, setId }),
      });
      const result = await upstream.json();
      if (!result.ok) {
        return new Response(JSON.stringify(result), {
          status: upstream.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
        });
      }

      // Generate JWT
      const token = await hashToken(setId, email);
      const now = Math.floor(Date.now() / 1000);
      const jwt = await signJWT({ sub: email.toLowerCase(), setId, token, iat: now, exp: now + SESSION_TTL });

      return new Response(JSON.stringify({ jwt, question: result.question, totals: result.totals, total: result.total }), {
        status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
      });
    } catch {
      return new Response(JSON.stringify({ error: "Registration failed" }), {
        status: 502, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
      });
    }
  }

  // Admin login — validates access code, issues admin JWT
  if (path.endsWith('/api/admin/login') && req.method === 'POST') {
    try {
      const body = await req.json();
      const { setId, accessCode } = body;
      if (!setId || !accessCode) {
        return new Response(JSON.stringify({ error: "setId and accessCode are required" }), {
          status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
        });
      }

      const upstream = await internalFetch(ORIGIN_URL + '/api/admin/login', {
        method: 'POST',
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setId, accessCode }),
      });
      const result = await upstream.json();
      if (!result.ok) {
        return new Response(JSON.stringify(result), {
          status: upstream.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
        });
      }

      const now = Math.floor(Date.now() / 1000);
      const jwt = await signJWT({ sub: "admin", setId, role: "admin", iat: now, exp: now + SESSION_TTL });

      return new Response(JSON.stringify({ jwt, name: result.name, questions: result.questions }), {
        status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
      });
    } catch {
      return new Response(JSON.stringify({ error: "Login failed" }), {
        status: 502, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
      });
    }
  }

  // Totals — requires voter or admin JWT
  if (path.endsWith('/api/totals') && req.method === 'GET') {
    const authHeader = req.headers.get('authorization') || '';
    const jwtToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!jwtToken) return unauthorized("Authorization required");
    const payload = await verifyJWT(jwtToken);
    if (!payload) return unauthorized("Invalid or expired JWT");
    const setId = url.searchParams.get('set');
    const qs = setId ? `?set=${encodeURIComponent(setId)}` : '';
    return proxyJSON(ORIGIN_URL + '/api/totals' + qs);
  }

  // Clear — requires admin JWT
  if (path.endsWith('/api/clear') && req.method === 'POST') {
    if (!await requireAdmin(req)) return unauthorized();
    const body = await req.text();
    return proxyJSON(ORIGIN_URL + '/api/clear', {
      method: 'POST',
      headers: { "content-type": "application/json" },
      body,
    });
  }

  // Session create — requires admin JWT
  if (path.endsWith('/api/session/create') && req.method === 'POST') {
    // Note: no setId-scoped JWT yet for create — just check for any admin JWT
    if (!await requireAdmin(req)) return unauthorized();
    const body = await req.text();
    return proxyJSON(ORIGIN_URL + '/api/session/create', {
      method: 'POST',
      headers: { "content-type": "application/json" },
      body,
    });
  }

  // Session update — requires admin JWT
  if (path.endsWith('/api/session/update') && req.method === 'POST') {
    if (!await requireAdmin(req)) return unauthorized();
    const body = await req.text();
    return proxyJSON(ORIGIN_URL + '/api/session/update', {
      method: 'POST',
      headers: { "content-type": "application/json" },
      body,
    });
  }

  // Session delete — requires admin JWT
  if (path.endsWith('/api/session/delete') && req.method === 'POST') {
    if (!await requireAdmin(req)) return unauthorized();
    const body = await req.text();
    return proxyJSON(ORIGIN_URL + '/api/session/delete', {
      method: 'POST',
      headers: { "content-type": "application/json" },
      body,
    });
  }

  // Question (get active) — requires voter or admin JWT
  if (path.endsWith('/api/question') && !path.includes('/activate') && req.method === 'GET') {
    const authHeader = req.headers.get('authorization') || '';
    const jwtToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!jwtToken) return new Response(JSON.stringify({ error: "Authorization required" }), {
      status: 401, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
    });
    const payload = await verifyJWT(jwtToken);
    if (!payload) return new Response(JSON.stringify({ error: "Invalid or expired JWT" }), {
      status: 401, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }
    });
    const setId = url.searchParams.get('set');
    let qs = setId ? `?set=${encodeURIComponent(setId)}` : '';
    if (payload.role === 'admin') qs += (qs ? '&' : '?') + 'include=all';
    return proxyJSON(ORIGIN_URL + '/api/question' + qs);
  }

  // Question activate — requires admin JWT
  if (path.endsWith('/api/question/activate') && req.method === 'POST') {
    if (!await requireAdmin(req)) return unauthorized();
    const body = await req.text();
    return proxyJSON(ORIGIN_URL + '/api/question/activate', {
      method: 'POST',
      headers: { "content-type": "application/json" },
      body,
    });
  }

  // --- UI routes ---
  if (path.endsWith('/admin') || path.endsWith('/admin/')) return adminUI(base, url.searchParams.get('set'));
  if (path.endsWith('/display') || path.endsWith('/display/')) return displayUI(base, url.searchParams.get('set'));
  if (path.endsWith('/styles.css')) return serveCSS();
  return voterUI(base, url.searchParams.get('set'));
});

addEventListener('fetch', (event) => {
  event.respondWith(router.fetch(event.request));
});
