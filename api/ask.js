import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";

const INSTRUCTIONS = fs.readFileSync(path.join(process.cwd(), "data/instructions.md"), "utf8");
const CORPUS = fs.readFileSync(path.join(process.cwd(), "data/corpus.md"), "utf8");

// cache_control on the last block caches everything up to and including it —
// instructions + corpus must stay byte-identical across requests or the cache misses.
const SYSTEM = [
  { type: "text", text: INSTRUCTIONS },
  { type: "text", text: CORPUS, cache_control: { type: "ephemeral", ttl: "1h" } },
];

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const maxDuration = 60;

const MODEL = "claude-sonnet-5";
// Hebrew runs ~2-3 tokens/word in this tokenizer vs ~1.3 for English; 700 was reasoned in
// English and was cutting off real answers (especially the longer depth-question cases).
const MAX_TOKENS = 4000;
const MAX_QUESTION_LENGTH = 600;
const MAX_HISTORY_TURNS = 8;
const HOURLY_LIMIT_PER_IP = 10;
const DAILY_LIMIT_PER_IP = 40;
const GLOBAL_DAILY_LIMIT = 300;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Per-warm-instance in-memory state. Single region, low traffic — no Redis needed.
const ipRequestLog = new Map();
let globalDayKey = null;
let globalDayCount = 0;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function checkIpRateLimit(ip) {
  const now = Date.now();
  const timestamps = (ipRequestLog.get(ip) || []).filter((t) => now - t < DAY_MS);
  const hourlyCount = timestamps.filter((t) => now - t < HOUR_MS).length;
  if (hourlyCount >= HOURLY_LIMIT_PER_IP) return { ok: false, reason: "hourly" };
  if (timestamps.length >= DAILY_LIMIT_PER_IP) return { ok: false, reason: "daily" };
  timestamps.push(now);
  ipRequestLog.set(ip, timestamps);
  return { ok: true };
}

function checkGlobalDailyCap() {
  const key = todayKey();
  if (key !== globalDayKey) {
    globalDayKey = key;
    globalDayCount = 0;
  }
  if (globalDayCount >= GLOBAL_DAILY_LIMIT) return false;
  globalDayCount += 1;
  return true;
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!isSameOrigin(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const ip = getClientIp(req);
  if (!checkIpRateLimit(ip).ok) {
    res.status(429).json({ error: "יותר מדי שאלות מהכתובת הזו. נסו שוב בעוד קצת זמן." });
    return;
  }

  if (!checkGlobalDailyCap()) {
    res.status(429).json({ error: "הסוכן הגיע למכסת השאלות היומית. אפשר לחזור מחר." });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.status(400).json({ error: "בקשה לא תקינה." });
    return;
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  const historyIn = Array.isArray(body.history) ? body.history : [];

  if (!question) {
    res.status(400).json({ error: "לא התקבלה שאלה." });
    return;
  }

  if (question.length > MAX_QUESTION_LENGTH) {
    res.status(400).json({ error: "השאלה ארוכה מדי. אפשר לנסח אותה בקצרה יותר?" });
    return;
  }

  const cleanHistory = historyIn
    .filter(
      (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
    )
    .slice(-MAX_HISTORY_TURNS * 2);

  const messages = [...cleanHistory, { role: "user", content: question }];

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages,
    });

    stream.on("text", (delta) => {
      res.write(delta);
    });

    const final = await stream.finalMessage();
    const usage = final.usage || {};
    console.log(
      "[ask] stop_reason=%s out=%d cache_read=%d cache_write=%d",
      final.stop_reason,
      usage.output_tokens ?? 0,
      usage.cache_read_input_tokens ?? 0,
      usage.cache_creation_input_tokens ?? 0
    );

    res.end();
  } catch (err) {
    console.error("[ask] stream error:", err);
    if (!res.headersSent) {
      res.status(500);
    }
    if (!res.writableEnded) {
      res.end("\n\n[מצטערים, קרתה תקלה. נסו שוב בעוד רגע.]");
    }
  }
}
