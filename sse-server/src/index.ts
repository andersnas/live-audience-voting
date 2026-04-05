import http from "http";
import Redis from "ioredis";

const PORT = parseInt(process.env.PORT ?? "3000");
const REDIS_HOST = process.env.REDIS_HOST ?? "localhost";
const REDIS_PORT = parseInt(process.env.REDIS_PORT ?? "6379");
const REDIS_PASSWORD = process.env.REDIS_PASSWORD ?? "";
const VOTES_CHANNEL = "votes";
const VOTER_KEY_PREFIX = "voter:";
const SESSION_TTL = parseInt(process.env.SESSION_TTL ?? "3600");
const VALID_OPTIONS = ["A", "B", "C", "D"];
const BASE = "/voterapp/api";

const publisher = new Redis({ host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD });
const subscriber = new Redis({ host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD });

const clients = new Set<http.ServerResponse>();
const totals: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };

subscriber.subscribe(VOTES_CHANNEL, (err) => {
  if (err) { console.error("Failed to subscribe:", err); process.exit(1); }
  console.log(`Subscribed to ${VOTES_CHANNEL}`);
});

subscriber.on("message", (_channel: string, message: string) => {
  try {
    const event = JSON.parse(message);
    if (event.option && totals.hasOwnProperty(event.option)) totals[event.option]++;
  } catch {}
  const data = `data: ${message}\n\n`;
  for (const client of clients) client.write(data);
});

publisher.on("error", (err) => console.error("Redis publisher error:", err));
subscriber.on("error", (err) => console.error("Redis subscriber error:", err));

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Health check
  if (url === `${BASE}/health` && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok"); return;
  }

  // Totals
  if (url === `${BASE}/totals` && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ totals, total: Object.values(totals).reduce((a, b) => a + b, 0) }));
    return;
  }

  // SSE stream
  if (url === `${BASE}/events` && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    res.write(`data: ${JSON.stringify({ totals, ts: Date.now() })}\n\n`);
    clients.add(res);
    console.log(`SSE client connected. Total: ${clients.size}`);
    
    // Keepalive heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 30000);

    req.on("close", () => {
      clients.delete(res);
      console.log(`SSE client disconnected. Total: ${clients.size}`);
    });
    return;
  }

  // Clear all voter tokens
  if (url === `${BASE}/clear` && req.method === "POST") {
    try {
      const keys = await publisher.keys(`${VOTER_KEY_PREFIX}*`);
      if (keys.length > 0) await publisher.del(...keys);
      totals.A = 0; totals.B = 0; totals.C = 0; totals.D = 0;
      const data = `data: ${JSON.stringify({ reset: true, ts: Date.now() })}\n\n`;
      for (const client of clients) client.write(data);
      console.log(`Cleared ${keys.length} voter tokens`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, cleared: keys.length }));
    } catch (err) {
      console.error("Clear error:", err);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to clear" }));
    }
    return;
  }

  // Vote
  if (url === `${BASE}/vote` && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { option, token } = JSON.parse(body);
        if (!VALID_OPTIONS.includes(option)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid option" })); return;
        }
        if (!token || token.length < 8) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Missing token" })); return;
        }
        const voterKey = `${VOTER_KEY_PREFIX}${token}`;
        const isNew = await publisher.set(voterKey, "1", "EX", SESSION_TTL, "NX");
        if (isNew) {
          await publisher.publish(VOTES_CHANNEL, JSON.stringify({ option, ts: Date.now() }));
          console.log(`Vote recorded: ${option}`);
        } else {
          console.log(`Duplicate vote ignored: ${token}`);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error("Vote error:", err);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => console.log(`SSE server listening on port ${PORT}`));

process.on("SIGTERM", async () => {
  for (const client of clients) client.end();
  await subscriber.quit();
  await publisher.quit();
  server.close(() => process.exit(0));
});
