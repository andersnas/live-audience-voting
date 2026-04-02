import { AutoRouter } from 'itty-router';

const router = AutoRouter();
const SSE_SERVER = "https://services.code4media.com";
const VALID_OPTIONS = ["A", "B", "C", "D"];

function getToken(req) {
  const ip = req.headers.get("true-client-ip") ??
             req.headers.get("x-forwarded-for") ??
             "unknown";
  const ua = req.headers.get("user-agent") ?? "unknown";
  return btoa(`${ip}:${ua}`).replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);
}

// Voter UI
router.get("/voterapp", () => voterUI());
router.get("/voterapp/", () => voterUI());

function voterUI() {
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0"/>
  <title>Vote</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f0f0f;color:#fff;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem 1.5rem}
    h1{font-size:1.6rem;font-weight:600;text-align:center;margin-bottom:.5rem}
    #question{font-size:1.1rem;color:#aaa;text-align:center;margin-bottom:2.5rem}
    .options{display:flex;flex-direction:column;gap:1rem;width:100%;max-width:360px}
    button{padding:1.1rem;font-size:1.1rem;font-weight:600;border:none;border-radius:12px;cursor:pointer;color:#fff;transition:opacity .15s,transform .1s}
    button:active{transform:scale(.97);opacity:.85}
    button[data-option="A"]{background:#5b8dee}
    button[data-option="B"]{background:#e8593c}
    button[data-option="C"]{background:#1d9e75}
    button[data-option="D"]{background:#ef9f27}
    button:disabled{opacity:.4;cursor:not-allowed}
    #confirmation{display:none;text-align:center;padding:2rem}
    #confirmation .check{font-size:4rem;margin-bottom:1rem}
    #confirmation p{font-size:1.2rem;color:#aaa}
    #confirmation strong{color:#fff;font-size:1.4rem;display:block;margin-top:.5rem}
    #error{color:#e24b4a;font-size:.9rem;text-align:center;margin-top:1rem;display:none}
  </style>
</head>
<body>
  <div id="vote-screen">
    <h1>Live Vote</h1>
    <div id="question">Select your answer</div>
    <div class="options">
      <button data-option="A" onclick="vote('A')">Option A</button>
      <button data-option="B" onclick="vote('B')">Option B</button>
      <button data-option="C" onclick="vote('C')">Option C</button>
      <button data-option="D" onclick="vote('D')">Option D</button>
    </div>
    <div id="error">Something went wrong. Please try again.</div>
  </div>
  <div id="confirmation">
    <div class="check">✓</div>
    <p>You voted for</p>
    <strong id="voted-option"></strong>
  </div>
  <script>
    function getToken(){let t=sessionStorage.getItem('vt');if(!t){t=Math.random().toString(36).substring(2)+Date.now().toString(36);sessionStorage.setItem('vt',t);}return t;}
    async function vote(option){
      document.querySelectorAll('button').forEach(b=>b.disabled=true);
      document.getElementById('error').style.display='none';
      try{
        const res=await fetch('/voterapp/vote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({option,token:getToken()})});
        if(res.ok){
          document.getElementById('vote-screen').style.display='none';
          document.getElementById('voted-option').textContent='Option '+option;
          document.getElementById('confirmation').style.display='block';
        }else{throw new Error();}
      }catch{
        document.getElementById('error').style.display='block';
        document.querySelectorAll('button').forEach(b=>b.disabled=false);
      }
    }
  </script>
</body>
</html>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

// Admin UI
router.get("/voterapp/admin", () => adminUI());
router.get("/voterapp/admin/", () => adminUI());

function adminUI() {
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Vote Admin</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f0f0f;color:#fff;min-height:100vh;padding:2rem}
    h1{font-size:1.8rem;font-weight:600;margin-bottom:.5rem}
    .subtitle{color:#666;font-size:.9rem;margin-bottom:2rem}
    .totals{display:grid;grid-template-columns:repeat(2,1fr);gap:1rem;max-width:500px;margin-bottom:2rem}
    .card{background:#1a1a1a;border-radius:12px;padding:1.5rem;text-align:center}
    .card .label{font-size:.9rem;color:#666;margin-bottom:.5rem}
    .card .count{font-size:3rem;font-weight:700}
    .card .pct{font-size:.85rem;color:#555;margin-top:.3rem}
    .card[data-option="A"] .count{color:#5b8dee}
    .card[data-option="B"] .count{color:#e8593c}
    .card[data-option="C"] .count{color:#1d9e75}
    .card[data-option="D"] .count{color:#ef9f27}
    .total-row{color:#555;font-size:.95rem;margin-bottom:2rem}
    .total-row strong{color:#fff}
    .bar-container{max-width:500px;margin-bottom:2rem}
    .bar-row{display:flex;align-items:center;gap:.75rem;margin-bottom:.6rem}
    .bar-label{width:70px;font-size:.85rem;color:#aaa}
    .bar-track{flex:1;background:#1a1a1a;border-radius:4px;height:28px;overflow:hidden}
    .bar-fill{height:100%;border-radius:4px;transition:width .4s ease;min-width:0}
    .bar-fill[data-option="A"]{background:#5b8dee}
    .bar-fill[data-option="B"]{background:#e8593c}
    .bar-fill[data-option="C"]{background:#1d9e75}
    .bar-fill[data-option="D"]{background:#ef9f27}
    .bar-count{width:30px;font-size:.85rem;color:#aaa;text-align:right}
    .actions{display:flex;gap:1rem;max-width:500px}
    .btn{padding:.75rem 1.5rem;border:none;border-radius:8px;font-size:.95rem;font-weight:600;cursor:pointer;transition:opacity .15s}
    .btn-clear{background:#e24b4a;color:#fff}
    .btn-refresh{background:#1a1a1a;color:#aaa;border:1px solid #333}
    .btn:hover{opacity:.8}
    .status{margin-top:1rem;font-size:.85rem;color:#555}
    .status.ok{color:#1d9e75}
    .status.err{color:#e24b4a}
  </style>
</head>
<body>
  <h1>Vote Admin</h1>
  <p class="subtitle">Live vote results and session management</p>

  <div class="totals">
    <div class="card" data-option="A"><div class="label">Option A</div><div class="count" id="count-A">0</div><div class="pct" id="pct-A">0%</div></div>
    <div class="card" data-option="B"><div class="label">Option B</div><div class="count" id="count-B">0</div><div class="pct" id="pct-B">0%</div></div>
    <div class="card" data-option="C"><div class="label">Option C</div><div class="count" id="count-C">0</div><div class="pct" id="pct-C">0%</div></div>
    <div class="card" data-option="D"><div class="label">Option D</div><div class="count" id="count-D">0</div><div class="pct" id="pct-D">0%</div></div>
  </div>

  <div class="total-row">Total votes: <strong id="total">0</strong></div>

  <div class="bar-container">
    <div class="bar-row"><span class="bar-label">Option A</span><div class="bar-track"><div class="bar-fill" data-option="A" id="bar-A" style="width:0%"></div></div><span class="bar-count" id="bar-count-A">0</span></div>
    <div class="bar-row"><span class="bar-label">Option B</span><div class="bar-track"><div class="bar-fill" data-option="B" id="bar-B" style="width:0%"></div></div><span class="bar-count" id="bar-count-B">0</span></div>
    <div class="bar-row"><span class="bar-label">Option C</span><div class="bar-track"><div class="bar-fill" data-option="C" id="bar-C" style="width:0%"></div></div><span class="bar-count" id="bar-count-C">0</span></div>
    <div class="bar-row"><span class="bar-label">Option D</span><div class="bar-track"><div class="bar-fill" data-option="D" id="bar-D" style="width:0%"></div></div><span class="bar-count" id="bar-count-D">0</span></div>
  </div>

  <div class="actions">
    <button class="btn btn-refresh" onclick="fetchTotals()">↻ Refresh</button>
    <button class="btn btn-clear" onclick="clearVotes()">✕ Clear all votes</button>
  </div>
  <div class="status" id="status"></div>

  <script>
    const API = 'https://webservices.code4media.com/voterapp';

    function updateUI(totals, total) {
      ['A','B','C','D'].forEach(o => {
        const count = totals[o] || 0;
        const pct = total > 0 ? Math.round(count / total * 100) : 0;
        document.getElementById('count-'+o).textContent = count;
        document.getElementById('pct-'+o).textContent = pct + '%';
        document.getElementById('bar-'+o).style.width = pct + '%';
        document.getElementById('bar-count-'+o).textContent = count;
      });
      document.getElementById('total').textContent = total;
    }

    async function fetchTotals() {
      try {
        const res = await fetch(API + '/totals');
        const data = await res.json();
        updateUI(data.totals, data.total);
        setStatus('Updated', 'ok');
      } catch {
        setStatus('Failed to fetch totals', 'err');
      }
    }

    async function clearVotes() {
      if (!confirm('Clear all votes and voter tokens? This cannot be undone.')) return;
      try {
        const res = await fetch(API + '/admin/clear', { method: 'POST' });
        const data = await res.json();
        updateUI({ A:0, B:0, C:0, D:0 }, 0);
        setStatus('Cleared ' + data.cleared + ' voter tokens', 'ok');
      } catch {
        setStatus('Failed to clear', 'err');
      }
    }

    function setStatus(msg, type) {
      const el = document.getElementById('status');
      el.textContent = msg;
      el.className = 'status ' + type;
      setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 3000);
    }

    // Auto-refresh every 5 seconds
    fetchTotals();
    setInterval(fetchTotals, 5000);

    // Also listen to SSE stream for real-time updates
    const es = new EventSource(API + '/events');
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.reset) { updateUI({ A:0, B:0, C:0, D:0 }, 0); return; }
        if (event.totals) { updateUI(event.totals, Object.values(event.totals).reduce((a,b)=>a+b,0)); return; }
        // Single vote event — increment locally
        if (event.option) fetchTotals();
      } catch {}
    };
  </script>
</body>
</html>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

// CORS preflight
router.options("*", () => new Response(null, {
  status: 204,
  headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "content-type" }
}));

// Vote endpoint
async function handleVote(req) {
  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "content-type": "application/json" } }); }
  if (!body.option || !VALID_OPTIONS.includes(body.option)) {
    return new Response(JSON.stringify({ error: "Invalid option" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const token = body.token || getToken(req);
  try {
    const response = await fetch(`${SSE_SERVER}/voterapp/vote`, {
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

router.post("/voterapp/vote", handleVote);
router.post("/vote", handleVote);

router.all("*", (req) => new Response("Not found: " + req.url, { status: 404 }));

addEventListener('fetch', (event) => {
  event.respondWith(router.fetch(event.request));
});
