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

// Separate Redis connections — one for pub, one for sub
const publisher = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
});

const subscriber = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
});

// Track open SSE connections
const clients = new Set<http.ServerResponse>();

subscriber.subscribe(VOTES_CHANNEL, (err) => {
  if (err) { console.error("Failed to subscribe:", err); process.exit(1); }
  console.log(`Subscribed to ${VOTES_CHANNEL}`);
});

subscriber.on("message", (_channel: string, message: string) => {
  const data = `data: ${message}\n\n`;
  for (const client of clients) client.write(data);
});

publisher.on("error", (err) => console.error("Redis publisher error:", err));
subscriber.on("error", (err) => console.error("Redis subscriber error:", err));

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // Vote endpoint
  if (req.url === "/vote" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const { option, token } = JSON.parse(body);

        // Validate option
        if (!VALID_OPTIONS.includes(option)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid option" }));
          return;
        }

        // Validate token
        if (!token || token.length < 8) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Missing token" }));
          return;
        }

        // Deduplicate — SET NX returns 1 if key was newly set, 0 if already exists
        const voterKey = `${VOTER_KEY_PREFIX}${token}`;
        const isNew = await publisher.set(voterKey, "1", "EX", SESSION_TTL, "NX");

        if (isNew) {
          // Publish vote event
          await publisher.publish(
            VOTES_CHANNEL,
            JSON.stringify({ option, ts: Date.now() })
          );
          console.log(`Vote recorded: ${option}`);
        } else {
          console.log(`Duplicate vote ignored: ${token}`);
        }

        // Always return 200 — don't reveal duplicate status to client
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

  // SSE stream
  if (req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    clients.add(res);
    console.log(`SSE client connected. Total: ${clients.size}`);
    req.on("close", () => {
      clients.delete(res);
      console.log(`SSE client disconnected. Total: ${clients.size}`);
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`SSE server listening on port ${PORT}`));

process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  for (const client of clients) client.end();
  await subscriber.quit();
  await publisher.quit();
  server.close(() => process.exit(0));
});
