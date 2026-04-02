import { HandleRequest, HttpRequest, HttpResponse, Redis } from "@fermyon/spin-sdk";

const VOTES_CHANNEL = "votes";
const VOTER_KEY_PREFIX = "voter:";

export const handleRequest: HandleRequest = async (request: HttpRequest): Promise<HttpResponse> => {
  if (request.method !== "POST") {
    return { status: 405, body: "Method not allowed" };
  }
  let body: { option: string; token: string };
  try {
    body = JSON.parse(new TextDecoder().decode(request.body));
  } catch {
    return { status: 400, body: "Invalid JSON" };
  }
  const validOptions = ["A", "B", "C", "D"];
  if (!validOptions.includes(body.option)) {
    return { status: 400, body: "Invalid option" };
  }
  if (!body.token || body.token.length < 8) {
    return { status: 400, body: "Missing session token" };
  }
  const redisUrl = `redis://:${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST}:6379`;
  const ttl = parseInt(process.env.SESSION_TTL ?? "3600");
  const voterKey = `${VOTER_KEY_PREFIX}${body.token}`;
  const isNewVote = await Redis.set(redisUrl, voterKey, "1", { nx: true, ex: ttl });
  if (!isNewVote) {
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) };
  }
  await Redis.publish(redisUrl, VOTES_CHANNEL, JSON.stringify({ option: body.option, ts: Date.now() }));
  return {
    status: 200,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    body: JSON.stringify({ ok: true }),
  };
};
