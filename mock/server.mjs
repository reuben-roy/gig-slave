// Scripted OpenAI-compatible upstream for offline Hired Gun tests (no tokens spent).
//
//   import { startMock } from "../mock/server.mjs";   // in tests
//   node mock/server.mjs                              // standalone, PORT or 8788
//
// Accepts one or more API keys (startMock({ apiKeys: [...] }), or the older
// startMock({ apiKey }), or MOCK_API_KEYS / MOCK_API_KEY when run standalone).
// Every request is recorded in `requests`, including the Authorization header it
// arrived with, so tests can check which key each route used.
//
// Scenarios are chosen from the text of the first user message:
//   "[e2e:slow]" -> always a bash call that sleeps 30s
//   anything else -> "organize" script:
//     bash mv -> write undo log -> submit_report tool call -> final text
// The step is the number of tool-result messages already in the request.

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_API_KEYS = ["mock-upstream-key"];

const ORGANIZE_COMMAND =
  "mkdir -p Pictures Documents Music && mv photo1.png photo2.jpg Pictures/ && mv report.pdf notes.txt Documents/ && mv song.mp3 Music/";

const UNDO_MOVES = [
  { from: "photo1.png", to: "Pictures/photo1.png" },
  { from: "photo2.jpg", to: "Pictures/photo2.jpg" },
  { from: "report.pdf", to: "Documents/report.pdf" },
  { from: "notes.txt", to: "Documents/notes.txt" },
  { from: "song.mp3", to: "Music/song.mp3" },
];

const REPORT_ARGS = {
  success: true,
  summary: "I sorted your Desktop into Pictures, Documents and Music.",
  answer: "Your Desktop had 5 files: 2 photos, 2 documents, 1 song.",
  findings: [{ label: "Files sorted", value: "5" }],
  changes: [
    "Moved 2 photos into Pictures/",
    "Moved 2 documents into Documents/",
    "Moved 1 song into Music/",
  ],
};

const FINAL_TEXT =
  "All done! I sorted your Desktop into 3 folders: Pictures (2 files), Documents (2 files) and Music (1 file). Nothing was deleted, and a list of every move is saved in .gigagent-undo.json.";

const USAGE = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
const PAUSE_MS = 20;

let responseCounter = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

function splitParts(s, n) {
  const size = Math.max(1, Math.ceil(s.length / n));
  const parts = [];
  for (let i = 0; i < s.length; i += size) parts.push(s.slice(i, i + size));
  return parts;
}

// Decide what the model "says" next.
function planStep(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const firstUser = messages.find((m) => m?.role === "user");
  const firstText = firstUser ? textOf(firstUser.content) : "";
  const step = messages.filter((m) => m?.role === "tool").length;

  if (firstText.includes("[e2e:slow]")) {
    return { kind: "tool", name: "bash", args: { command: "sleep 30" }, step };
  }
  if (step === 0) {
    return { kind: "tool", name: "bash", args: { command: ORGANIZE_COMMAND }, step };
  }
  if (step === 1) {
    return {
      kind: "tool",
      name: "write",
      args: { path: ".gigagent-undo.json", content: JSON.stringify(UNDO_MOVES, null, 2) },
      step,
    };
  }
  if (step === 2) {
    return { kind: "tool", name: "submit_report", args: REPORT_ARGS, step };
  }
  return { kind: "text", text: FINAL_TEXT, step };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function completionJson(plan, { id, created, model, callId }) {
  const isTool = plan.kind === "tool";
  const message = isTool
    ? {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: { name: plan.name, arguments: JSON.stringify(plan.args) },
          },
        ],
      }
    : { role: "assistant", content: plan.text };
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: isTool ? "tool_calls" : "stop" }],
    usage: USAGE,
  };
}

async function streamResponse(res, plan, { id, created, model, callId }) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  res.on("error", () => {
    closed = true;
  });

  // Returns false if the client has gone away, so the caller stops writing.
  const write = async (delta, finish = null, withUsage = false) => {
    if (closed) return false;
    const chunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    if (withUsage) chunk.usage = USAGE;
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    await sleep(PAUSE_MS);
    return !closed;
  };

  if (plan.kind === "text") {
    if (!(await write({ role: "assistant", content: "" }))) return;
    for (const part of splitParts(plan.text, 4)) {
      if (!(await write({ content: part }))) return;
    }
    if (!(await write({}, "stop", true))) return;
  } else {
    const first = {
      role: "assistant",
      tool_calls: [
        { index: 0, id: callId, type: "function", function: { name: plan.name, arguments: "" } },
      ],
    };
    if (!(await write(first))) return;
    for (const part of splitParts(JSON.stringify(plan.args), 2)) {
      if (!(await write({ tool_calls: [{ index: 0, function: { arguments: part } }] }))) return;
    }
    if (!(await write({}, "tool_calls", true))) return;
  }

  if (closed) return;
  res.write("data: [DONE]\n\n");
  res.end();
}

function bearerToken(auth) {
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length);
}

async function handleChat(req, res, ctx) {
  const raw = await readBody(req);
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const safe = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const messages = Array.isArray(safe.messages) ? safe.messages : [];
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : null;

  // Logged before the auth check so a leaked or wrong credential shows up in tests.
  ctx.requests.push({
    model: safe.model ?? null,
    auth,
    stream: safe.stream === true,
    toolCount: Array.isArray(safe.tools) ? safe.tools.length : 0,
    messageCount: messages.length,
    lastUserText: lastUser ? textOf(lastUser.content) : "",
  });

  if (!ctx.apiKeys.includes(bearerToken(auth))) {
    return sendJson(res, 401, { error: { message: "bad key" } });
  }
  if (!body || typeof body !== "object") {
    return sendJson(res, 400, { error: { message: "invalid JSON body" } });
  }

  const plan = planStep(safe);
  const meta = {
    id: `chatcmpl-mock-${++responseCounter}`,
    created: Math.floor(Date.now() / 1000),
    model: typeof safe.model === "string" ? safe.model : "mock-model",
    callId: plan.kind === "tool" ? `call_${plan.step}_${randomBytes(4).toString("hex")}` : null,
  };

  if (ctx.debug) {
    console.error(
      `[mock] chat step=${plan.step} kind=${plan.kind}${plan.name ? ` tool=${plan.name}` : ""} stream=${safe.stream === true}`,
    );
  }

  if (safe.stream === true) {
    return streamResponse(res, plan, meta);
  }
  return sendJson(res, 200, completionJson(plan, meta));
}

function makeHandler(ctx) {
  return async (req, res) => {
    try {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (ctx.debug) console.error(`[mock] ${req.method} ${pathname}`);
      if (req.method === "GET" && pathname === "/v1/models") {
        return sendJson(res, 200, {
          object: "list",
          data: [{ id: "mock-model", object: "model" }],
        });
      }
      if (req.method === "POST" && pathname === "/v1/chat/completions") {
        return await handleChat(req, res, ctx);
      }
      return sendJson(res, 404, { error: { message: `no route for ${req.method} ${pathname}` } });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message: String(err?.message ?? err) } });
      } else {
        res.destroy();
      }
    }
  };
}

export async function startMock({ port = 0, apiKey, apiKeys } = {}) {
  const keys = Array.isArray(apiKeys) && apiKeys.length > 0
    ? apiKeys
    : apiKey !== undefined
      ? [apiKey]
      : DEFAULT_API_KEYS;
  const requests = [];
  const ctx = { apiKeys: keys, requests, debug: process.env.MOCK_DEBUG === "1" };
  const server = createServer(makeHandler(ctx));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const actualPort = server.address().port;
  return {
    url: `http://127.0.0.1:${actualPort}/v1`,
    port: actualPort,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = Number(process.env.PORT) || 8788;
  const keys = process.env.MOCK_API_KEYS
    ? process.env.MOCK_API_KEYS.split(",").map((k) => k.trim()).filter(Boolean)
    : process.env.MOCK_API_KEY
      ? [process.env.MOCK_API_KEY]
      : DEFAULT_API_KEYS;
  const mock = await startMock({ port, apiKeys: keys });
  console.log(`mock upstream listening on ${mock.url}`);
}
