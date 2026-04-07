import http from "http";
import crypto from "crypto";
import Redis from "ioredis";

// --- Types ---

interface QuestionOption {
  key: string;
  label: string;
}

interface Question {
  id: string;
  label: string;
  options: QuestionOption[];
}

interface QuestionSet {
  name: string;
  accessCodeHash: string;
  questions: Question[];
  createdAt: string;
}

// --- Config ---

const PORT = parseInt(process.env.PORT ?? "3000");
const REDIS_HOST = process.env.REDIS_HOST ?? "localhost";
const REDIS_PORT = parseInt(process.env.REDIS_PORT ?? "6379");
const REDIS_PASSWORD = process.env.REDIS_PASSWORD ?? "";
const SESSION_TTL = parseInt(process.env.SESSION_TTL ?? "3600");
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? "";
const BASE = "/voterapp/api";

// --- Redis ---

const publisher = new Redis({ host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD });
const subscriber = new Redis({ host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD });

// --- SSE clients scoped per set ---

const clients = new Map<string, Set<http.ServerResponse>>();

function broadcast(setId: string, message: string) {
  const data = `data: ${message}\n\n`;
  const setClients = clients.get(setId);
  if (setClients) {
    for (const client of setClients) client.write(data);
  }
}

// --- Redis pub/sub (pattern subscribe for set-scoped channels) ---

subscriber.psubscribe("votes:*", (err) => {
  if (err) { console.error("Failed to psubscribe:", err); process.exit(1); }
  console.log("Subscribed to votes:* pattern");
});

subscriber.on("pmessage", (_pattern: string, channel: string, message: string) => {
  const setId = channel.replace("votes:", "");
  broadcast(setId, message);
});

publisher.on("error", (err) => console.error("Redis publisher error:", err));
subscriber.on("error", (err) => console.error("Redis subscriber error:", err));

// --- Helpers ---

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function getSet(setId: string): Promise<QuestionSet | null> {
  const raw = await publisher.get(`set:${setId}`);
  return raw ? JSON.parse(raw) : null;
}

async function getActiveQuestionId(setId: string): Promise<string | null> {
  return await publisher.get(`set:${setId}:active`);
}

async function getTotals(setId: string, questionId: string): Promise<Record<string, number>> {
  const raw = await publisher.hgetall(`set:${setId}:${questionId}:votes`);
  const totals: Record<string, number> = {};
  for (const [key, val] of Object.entries(raw)) {
    totals[key] = parseInt(val, 10);
  }
  return totals;
}

// --- Server ---

const server = http.createServer(async (req, res) => {
  const rawUrl = req.url ?? "/";
  const parsedUrl = new URL(rawUrl, `http://${req.headers.host}`);
  const url = parsedUrl.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Token validation — skip health and vote (vote uses JWT in Phase 2)
  if (INTERNAL_TOKEN && url !== `${BASE}/health` && url !== `${BASE}/vote`) {
    const fromHeader = req.headers["x-internal-token"] as string | undefined;
    const fromQuery = parsedUrl.searchParams.get("token");
    if (fromHeader !== INTERNAL_TOKEN && fromQuery !== INTERNAL_TOKEN) {
      json(res, 403, { error: "Forbidden" });
      return;
    }
  }

  // Health check
  if (url === `${BASE}/health` && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok"); return;
  }

  // --- Admin/login ---
  if (url === `${BASE}/admin/login` && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const { setId, accessCode } = body;
      if (!setId) return json(res, 400, { error: "setId is required" });
      if (!accessCode || typeof accessCode !== "string") return json(res, 400, { error: "accessCode is required" });

      const questionSet = await getSet(setId);
      if (!questionSet) return json(res, 404, { error: "Set not found" });

      const hash = crypto.createHash("sha256").update(accessCode).digest("hex");
      if (hash !== questionSet.accessCodeHash) return json(res, 403, { error: "Invalid access code" });

      console.log(`Admin login for set ${setId}`);
      json(res, 200, { ok: true, name: questionSet.name, questions: questionSet.questions });
    } catch (err: any) {
      console.error("Admin login error:", err);
      json(res, 400, { error: err.message || "Invalid request" });
    }
    return;
  }

  // --- Voter/register ---
  if (url === `${BASE}/voter/register` && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const { email, setId } = body;
      if (!email || typeof email !== "string") return json(res, 400, { error: "email is required" });
      if (!setId) return json(res, 400, { error: "setId is required" });

      const questionSet = await getSet(setId);
      if (!questionSet) return json(res, 404, { error: "Set not found" });

      await publisher.sadd(`set:${setId}:voters`, email.toLowerCase());

      const activeId = await getActiveQuestionId(setId);
      let question = null;
      let totals: Record<string, number> = {};
      let total = 0;
      if (activeId) {
        question = questionSet.questions.find(q => q.id === activeId) || null;
        totals = await getTotals(setId, activeId);
        total = Object.values(totals).reduce((a, b) => a + b, 0);
      }

      console.log(`Voter registered: ${email} for set ${setId}`);
      json(res, 200, { ok: true, name: questionSet.name, question, totals, total });
    } catch (err: any) {
      console.error("Voter register error:", err);
      json(res, 400, { error: err.message || "Invalid request" });
    }
    return;
  }

  // --- Session/create ---
  if (url === `${BASE}/session/create` && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const { name, accessCode, questions } = body;
      if (!name || typeof name !== "string") return json(res, 400, { error: "name is required" });
      if (!accessCode || typeof accessCode !== "string") return json(res, 400, { error: "accessCode is required" });
      if (!Array.isArray(questions) || questions.length === 0) return json(res, 400, { error: "questions array is required" });

      const setId = crypto.randomUUID();
      const accessCodeHash = crypto.createHash("sha256").update(accessCode).digest("hex");

      const builtQuestions: Question[] = questions.map((q: any, i: number) => {
        if (!q.label || !Array.isArray(q.options) || q.options.length < 2) {
          throw new Error(`Invalid question at index ${i}`);
        }
        return {
          id: `q${i}`,
          label: q.label,
          options: q.options.map((o: any) => ({ key: o.key, label: o.label })),
        };
      });

      const questionSet: QuestionSet = {
        name,
        accessCodeHash,
        questions: builtQuestions,
        createdAt: new Date().toISOString(),
      };

      await publisher.set(`set:${setId}`, JSON.stringify(questionSet));
      console.log(`Session created: ${setId} "${name}" with ${builtQuestions.length} questions`);
      json(res, 201, { id: setId, name, questions: builtQuestions });
    } catch (err: any) {
      console.error("Session create error:", err);
      json(res, 400, { error: err.message || "Invalid request" });
    }
    return;
  }

  // --- Session/update ---
  if (url === `${BASE}/session/update` && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const { setId, name, accessCode, questions } = body;
      if (!setId) return json(res, 400, { error: "setId is required" });

      const existing = await getSet(setId);
      if (!existing) return json(res, 404, { error: "Set not found" });

      if (name && typeof name === "string") existing.name = name;
      if (accessCode && typeof accessCode === "string") {
        existing.accessCodeHash = crypto.createHash("sha256").update(accessCode).digest("hex");
      }
      if (Array.isArray(questions) && questions.length > 0) {
        existing.questions = questions.map((q: any, i: number) => {
          if (!q.label || !Array.isArray(q.options) || q.options.length < 2) {
            throw new Error(`Invalid question at index ${i}`);
          }
          return {
            id: q.id || `q${i}`,
            label: q.label,
            options: q.options.map((o: any) => ({ key: o.key, label: o.label })),
          };
        });
      }

      await publisher.set(`set:${setId}`, JSON.stringify(existing));
      console.log(`Session updated: ${setId}`);
      json(res, 200, { ok: true, name: existing.name, questions: existing.questions });
    } catch (err: any) {
      console.error("Session update error:", err);
      json(res, 400, { error: err.message || "Invalid request" });
    }
    return;
  }

  // --- Session/delete ---
  if (url === `${BASE}/session/delete` && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const { setId } = body;
      if (!setId) return json(res, 400, { error: "setId is required" });

      const existing = await getSet(setId);
      if (!existing) return json(res, 404, { error: "Set not found" });

      // Delete all related keys
      const keysToDelete = [`set:${setId}`, `set:${setId}:active`, `set:${setId}:voters`];
      for (const q of existing.questions) {
        keysToDelete.push(`set:${setId}:${q.id}:votes`);
      }
      const voterKeys = await publisher.keys(`voter:${setId}:*`);
      keysToDelete.push(...voterKeys);

      if (keysToDelete.length > 0) await publisher.del(...keysToDelete);

      // Disconnect SSE clients for this set
      const setClients = clients.get(setId);
      if (setClients) {
        for (const client of setClients) client.end();
        clients.delete(setId);
      }

      console.log(`Session deleted: ${setId} (${keysToDelete.length} keys removed)`);
      json(res, 200, { ok: true, deleted: keysToDelete.length });
    } catch (err: any) {
      console.error("Session delete error:", err);
      json(res, 500, { error: "Failed to delete" });
    }
    return;
  }

  // --- Question (get active) ---
  if (url === `${BASE}/question` && req.method === "GET") {
    const setId = parsedUrl.searchParams.get("set");
    if (!setId) return json(res, 400, { error: "set query param is required" });

    const questionSet = await getSet(setId);
    if (!questionSet) return json(res, 404, { error: "Set not found" });

    const activeId = await getActiveQuestionId(setId);
    const includeAll = parsedUrl.searchParams.get("include") === "all";
    const base_response: any = { setId, name: questionSet.name };
    if (includeAll) base_response.questions = questionSet.questions;

    if (!activeId) return json(res, 200, { ...base_response, active: null });

    const question = questionSet.questions.find(q => q.id === activeId);
    if (!question) return json(res, 200, { ...base_response, active: null });

    const totals = await getTotals(setId, activeId);
    const total = Object.values(totals).reduce((a, b) => a + b, 0);
    json(res, 200, { ...base_response, question, totals, total });
    return;
  }

  // --- Question/activate ---
  if (url === `${BASE}/question/activate` && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const { setId, questionId } = body;
      if (!setId) return json(res, 400, { error: "setId is required" });

      const questionSet = await getSet(setId);
      if (!questionSet) return json(res, 404, { error: "Set not found" });

      if (questionId === null || questionId === undefined) {
        await publisher.del(`set:${setId}:active`);
        await publisher.publish(`votes:${setId}`, JSON.stringify({ type: "deactivate", ts: Date.now() }));
        console.log(`Deactivated question for set ${setId}`);
        return json(res, 200, { ok: true, active: null });
      }

      const question = questionSet.questions.find(q => q.id === questionId);
      if (!question) return json(res, 400, { error: "Question not found in set" });

      await publisher.set(`set:${setId}:active`, questionId);
      const totals = await getTotals(setId, questionId);
      const total = Object.values(totals).reduce((a, b) => a + b, 0);
      await publisher.publish(`votes:${setId}`, JSON.stringify({
        type: "activate", questionId, question, totals, total, ts: Date.now(),
      }));
      console.log(`Activated question ${questionId} for set ${setId}`);
      json(res, 200, { ok: true, active: questionId });
    } catch (err: any) {
      console.error("Activate error:", err);
      json(res, 400, { error: err.message || "Invalid request" });
    }
    return;
  }

  // --- Totals ---
  if (url === `${BASE}/totals` && req.method === "GET") {
    const setId = parsedUrl.searchParams.get("set");
    if (!setId) return json(res, 400, { error: "set query param is required" });

    const questionSet = await getSet(setId);
    if (!questionSet) return json(res, 404, { error: "Set not found" });

    const activeId = await getActiveQuestionId(setId);
    if (!activeId) return json(res, 200, { setId, totals: {}, total: 0 });

    const totals = await getTotals(setId, activeId);
    const total = Object.values(totals).reduce((a, b) => a + b, 0);
    json(res, 200, { setId, questionId: activeId, totals, total });
    return;
  }

  // --- SSE stream ---
  if (url === `${BASE}/events` && req.method === "GET") {
    const setId = parsedUrl.searchParams.get("set");
    if (!setId) {
      json(res, 400, { error: "set query param is required" });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");

    // Send current state on connect
    const questionSet = await getSet(setId);
    const activeId = questionSet ? await getActiveQuestionId(setId) : null;
    if (questionSet && activeId) {
      const question = questionSet.questions.find(q => q.id === activeId);
      const totals = await getTotals(setId, activeId);
      const total = Object.values(totals).reduce((a, b) => a + b, 0);
      res.write(`data: ${JSON.stringify({ type: "activate", questionId: activeId, question, totals, total, ts: Date.now() })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ type: "waiting", ts: Date.now() })}\n\n`);
    }

    if (!clients.has(setId)) clients.set(setId, new Set());
    clients.get(setId)!.add(res);
    console.log(`SSE client connected for set ${setId}. Total: ${clients.get(setId)!.size}`);

    const heartbeat = setInterval(() => { res.write(": heartbeat\n\n"); }, 30000);

    req.on("close", () => {
      clearInterval(heartbeat);
      const setClients = clients.get(setId);
      if (setClients) {
        setClients.delete(res);
        if (setClients.size === 0) clients.delete(setId);
      }
      console.log(`SSE client disconnected for set ${setId}.`);
    });
    return;
  }

  // --- Clear ---
  if (url === `${BASE}/clear` && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const { setId, questionId } = body;
      if (!setId) return json(res, 400, { error: "setId is required" });

      let cleared = 0;

      if (questionId) {
        // Clear specific question votes
        await publisher.del(`set:${setId}:${questionId}:votes`);
        const voterKeys = await publisher.keys(`voter:${setId}:*`);
        if (voterKeys.length > 0) { await publisher.del(...voterKeys); cleared = voterKeys.length; }
      } else {
        // Clear all questions in set
        const questionSet = await getSet(setId);
        if (questionSet) {
          for (const q of questionSet.questions) {
            await publisher.del(`set:${setId}:${q.id}:votes`);
          }
        }
        const voterKeys = await publisher.keys(`voter:${setId}:*`);
        if (voterKeys.length > 0) { await publisher.del(...voterKeys); cleared = voterKeys.length; }
      }

      broadcast(setId, JSON.stringify({ type: "reset", questionId: questionId || null, ts: Date.now() }));
      console.log(`Cleared votes for set ${setId}${questionId ? ` question ${questionId}` : ""}: ${cleared} voter keys`);
      json(res, 200, { ok: true, cleared });
    } catch (err: any) {
      console.error("Clear error:", err);
      json(res, 500, { error: "Failed to clear" });
    }
    return;
  }

  // --- Vote ---
  if (url === `${BASE}/vote` && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const { option, token, setId } = body;

      if (!setId) return json(res, 400, { error: "setId is required" });
      if (!token || token.length < 8) return json(res, 400, { error: "Missing token" });

      const activeId = await getActiveQuestionId(setId);
      if (!activeId) return json(res, 400, { error: "No active question" });

      const questionSet = await getSet(setId);
      if (!questionSet) return json(res, 404, { error: "Set not found" });

      const question = questionSet.questions.find(q => q.id === activeId);
      if (!question) return json(res, 400, { error: "Active question not found" });

      const validKeys = question.options.map(o => o.key);
      if (!option || !validKeys.includes(option)) return json(res, 400, { error: "Invalid option" });

      const voterKey = `voter:${setId}:${activeId}:${token}`;
      const isNew = await publisher.set(voterKey, "1", "EX", SESSION_TTL, "NX");
      if (isNew) {
        await publisher.hincrby(`set:${setId}:${activeId}:votes`, option, 1);
        const totals = await getTotals(setId, activeId);
        const total = Object.values(totals).reduce((a, b) => a + b, 0);
        await publisher.publish(`votes:${setId}`, JSON.stringify({
          type: "vote", option, questionId: activeId, totals, total, ts: Date.now(),
        }));
        console.log(`Vote recorded: set=${setId} q=${activeId} option=${option}`);
      } else {
        console.log(`Duplicate vote ignored: ${token}`);
      }
      json(res, 200, { ok: true });
    } catch (err: any) {
      console.error("Vote error:", err);
      json(res, 400, { error: "Invalid JSON" });
    }
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`SSE server listening on port ${PORT}`);
  if (!INTERNAL_TOKEN) console.warn("WARNING: INTERNAL_TOKEN not set, all requests allowed");
});

process.on("SIGTERM", async () => {
  for (const [, setClients] of clients) {
    for (const client of setClients) client.end();
  }
  await subscriber.quit();
  await publisher.quit();
  server.close(() => process.exit(0));
});
