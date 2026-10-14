#!/usr/bin/env node
/**
 * The approval popup over Streamable HTTP, which is how a client in another environment (a WSL
 * agent, for instance) reaches the server.
 *
 * This is the case that broke before: a transport per HTTP request meant the `tools/call` was
 * served by a server that had never seen `initialize`, so the client capabilities looked absent
 * and the popup was never attempted. A session has to survive between requests, and the popup has
 * to come back on the stream of the call that is waiting for an answer.
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8806;
const BASE = `http://127.0.0.1:${String(PORT)}`;
const CONFIG = join(tmpdir(), "winadmin-mcp-http.json");
const AUDIT = join(tmpdir(), "winadmin-mcp-http.audit.jsonl");
rmSync(CONFIG, { force: true });
rmSync(AUDIT, { force: true });

const server = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, WAMD_PORT: String(PORT), WAMD_CONFIG: CONFIG, WAMD_AUDIT: AUDIT, WAMD_NO_UPDATE_CHECK: "1" },
});

let failed = 0;
const check = (label, condition, detail = "") => {
  if (!condition) failed += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sessionId = "";
let nextId = 1;

/** Collects the JSON messages of an SSE body so a request can be answered mid-stream. */
async function* sse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (data !== "") yield JSON.parse(data);
    }
  }
}

/** Sends one MCP message; returns the HTTP response plus its body, stream or parsed JSON. */
async function send(method, params, notify = false) {
  const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: nextId++, method, params };
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!notify && !sessionId) sessionId = res.headers.get("mcp-session-id") ?? "";
  if (notify) return { res, body: null };
  // An answer can arrive as a single JSON document or on an SSE stream that stays open.
  const streamed = (res.headers.get("content-type") ?? "").includes("text/event-stream");
  return { res, body: streamed ? sse(res) : await res.json() };
}

/** Reads the first message of a response, whether it was streamed or answered as JSON. */
async function firstMessage(response) {
  if (response.body === null) return null;
  if (typeof response.body[Symbol.asyncIterator] === "function") {
    for await (const msg of response.body) return msg;
    return null;
  }
  return response.body;
}

/** Answers the popup the server pushes onto the stream, then returns the call's real result. */
async function answerPopup(action) {
  let popupId = null;
  for await (const msg of popupStream) {
    if (msg.method === "elicitation/create") {
      popupCount += 1;
      popupId = msg.id;
      popupMessage = msg.params?.message ?? "";
      await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: action === "decline" ? { action: "decline" } : { action: "accept", content: { approved: true } },
        }),
      });
      continue;
    }
    // The echo of the popup answer is not the result of the call.
    if (msg.id !== undefined && msg.id !== popupId) return msg;
  }
  return undefined;
}

let popupStream = null;
let popupCount = 0;
let popupMessage = "";

const patch = (path, body) =>
  fetch(`${BASE}${path}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

try {
  await sleep(1500);

  const init = await firstMessage(await send("initialize", {
    protocolVersion: "2025-06-18",
    // Deliberately bare: no `form` sub-object, the way several clients declare it.
    capabilities: { elicitation: {} },
    clientInfo: { name: "http-popup-test", version: "0.0.0" },
  }));
  check("initialize answered over HTTP", init?.result?.serverInfo?.name === "winadmin-mcp");
  check("the server issued a session id", sessionId !== "", sessionId);
  await send("notifications/initialized", undefined, true);

  const state = await (await fetch(`${BASE}/api/state`)).json();
  await patch("/api/tools", { enabled: Object.fromEntries(state.tools.map((t) => [t.name, true])) });
  await patch("/api/tools", { requireApproval: { explain_event_id: true } });

  const call = await send("tools/call", { name: "explain_event_id", arguments: { event_id: 6008 } });
  popupStream = call.body;
  const answered = await answerPopup("accept");

  check("the popup reached the client over HTTP", popupCount === 1, `${String(popupCount)} popup(s)`);
  check("the popup names the tool and its arguments", popupMessage.includes("explain_event_id") && popupMessage.includes("6008"), popupMessage);
  const text0 = (answered?.result?.content ?? []).map((c) => c.text ?? "").join(" ");
  check(
    "the approved call answered with its result on the same stream",
    text0.includes("6008") && answered?.result?.isError !== true,
    text0.slice(0, 60),
  );

  // Decline: the same connection must run nothing and park nothing.
  const second = await send("tools/call", { name: "explain_event_id", arguments: { event_id: 6008 } });
  popupStream = second.body;
  const declined = await answerPopup("decline");
  check(
    "a declined HTTP call is not executed",
    declined?.result?.structuredContent?.decision === "declined",
    String(declined?.result?.structuredContent?.decision),
  );
  const pendingAfter = await (await fetch(`${BASE}/api/state`)).json();
  check("nothing parked itself on the way", pendingAfter.pending.length === 0, `${String(pendingAfter.pending.length)} pending`);

  // A second session must not inherit the first one's state.
  const unknown = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "not-a-session" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
  });
  check("an unknown session is refused", unknown.status === 404, String(unknown.status));
} finally {
  const closed = new Promise((resolve) => server.once("close", resolve));
  server.stdin.end();
  await closed;
  rmSync(CONFIG, { force: true });
  rmSync(AUDIT, { force: true });
}

console.log(failed === 0 ? "\nall checks passed" : `\n${String(failed)} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
