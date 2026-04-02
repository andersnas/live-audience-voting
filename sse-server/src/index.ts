import http from "http";
import Redis from "ioredis";

const PORT = parseInt(process.env.PORT ?? "3000");
const REDIS_HOST = process.env.REDIS_HOST ?? "localhost";
const REDIS_PORT = parseInt(process.env.REDIS_PORT ?? "6379");
const REDIS_PASSWORD = process.env.REDIS_PASSWORD ?? "";
const VOTES_CHANNEL = "votes";

const clients = new Set<http.ServerResponse>();

const subscriber = new Redis({ host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD });

subscriber.subscribe(VOTES_CHANNEL, (err) => {
  if (err) { console.error("Failed to subscribe:", err); process.exit(1); }
  console.log(`Subscribed to ${VOTES_CHANNEL}`);
});

subscriber.on("message", (_channel: string, message: string) => {
  const data = `data: ${message}\n\n`;
  for (const client of clients) client.write(data);
});

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  clients.add(res);
  console.log(`Client connected. Total: ${clients.size}`);
  req.on("close", () => { clients.delete(res); console.log(`Client disconnected. Total: ${clients.size}`); });
});

server.listen(PORT, () => console.log(`SSE server listening on port ${PORT}`));

process.on("SIGTERM", async () => {
  for (const client of clients) client.end();
  await subscriber.quit();
  server.close(() => process.exit(0));
});
