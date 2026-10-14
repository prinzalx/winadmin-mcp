#!/usr/bin/env node
/**
 * Proves the approval popup: a client that declares the elicitation capability is asked over the
 * same stdio connection, and the executed result comes back inside the original tools/call —
 * which is exactly what the old park-and-wait flow could not do.
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8805;
const CONFIG = join(tmpdir(), "winadmin-mcp-popup.json");
const AUDIT = join(tmpdir(), "winadmin-mcp-popup.audit.jsonl");
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

const queue = [];
const waiters = [];
let buffer = "";

/** What the next popup answers. Set per test. */
let answer = "accept";
let popupCount = 0;

server.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line !== "") void handle(JSON.parse(line));
    index = buffer.indexOf("\n");
  }
});

async function handle(msg) {
  // A server-to-client request: this is the approval popup.
  if (msg.id !== undefined && msg.method === "elicitation/create") {
    popupCount += 1;
    const content = answer === "accept" ? { approved: true } : answer === "unticked" ? { approved: false } : undefined;
    server.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      result: { action: answer === "cancel" ? "cancel" : answer === "decline" ? "decline" : "accept", ...(content ? { content } : {}) },
    })}\n`);
    return;
  }
  const waiter = waiters.shift();
  if (waiter) waiter(msg);
  else queue.push(msg);
}

let nextId = 1;

async function request(method, params) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), 30_000);
    const match = (m) => {
      if (m.id !== id) return false;
      clearTimeout(timer);
      return true;
    };
    const i = queue.findIndex(match);
    if (i >= 0) resolve(queue.splice(i, 1)[0]);
    else waiters.push((m) => match(m) && resolve(m));
  });
}

const patch = (body) =>
  fetch(`http://127.0.0.1:${String(PORT)}/api/tools`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await sleep(1500);

  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    // The capability that turns the gate into a popup instead of a parked action.
    capabilities: { elicitation: {} },
    clientInfo: { name: "popup-test", version: "0.0.0" },
  });
  check("initialize answered", init.result?.serverInfo?.name === "winadmin-mcp");
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const state = await (await fetch(`http://127.0.0.1:${String(PORT)}/api/state`)).json();
  await patch({ enabled: Object.fromEntries(state.tools.map((t) => [t.name, true])) });
  check("ask in agent is on by default", state.ask_in_agent === true);

  // Approved in the popup: the action runs and the result arrives in the same call.
  await patch({ requireApproval: { explain_event_id: true } });
  answer = "accept";
  const accepted = await request("tools/call", { name: "explain_event_id", arguments: { event_id: 6008 } });
  const acceptedText = (accepted.result?.content ?? []).map((c) => c.text ?? "").join(" ");
  check("the client was asked for approval", popupCount === 1, `${String(popupCount)} popup(s)`);
  check(
    "an approved call answers with its result",
    accepted.result?.isError !== true && acceptedText.includes("6008"),
    acceptedText.slice(0, 60),
  );
  check(
    "the answer records the decision",
    accepted.result?.structuredContent?.decision === "accepted",
    String(accepted.result?.structuredContent?.decision),
  );
  check(
    "nothing stays parked after an approved call",
    ((await request("tools/call", { name: "list_pending", arguments: {} })).result?.structuredContent?.result ?? []).length === 0,
  );

  // Declined in the popup: nothing runs, nothing parks, and the agent is told why.
  answer = "decline";
  const declined = await request("tools/call", { name: "explain_event_id", arguments: { event_id: 6008 } });
  const declinedText = (declined.result?.content ?? []).map((c) => c.text ?? "").join(" ");
  check(
    "a declined call is not executed",
    declined.result?.structuredContent?.decision === "declined" && declinedText.includes("declined"),
    declinedText.slice(0, 60),
  );
  check(
    "a declined call leaves nothing parked",
    ((await request("tools/call", { name: "list_pending", arguments: {} })).result?.structuredContent?.result ?? []).length === 0,
  );

  // The popup is a switch: with askInAgent off the action parks for the web interface again.
  await fetch(`http://127.0.0.1:${String(PORT)}/api/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ askInAgent: false }),
  });
  answer = "accept";
  const parked = await request("tools/call", { name: "explain_event_id", arguments: { event_id: 6008 } });
  check(
    "with the switch off the action parks for the web interface",
    Boolean(parked.result?.structuredContent?.confirmationId) && !("decision" in (parked.result?.structuredContent ?? {})),
    (parked.result?.content?.[0]?.text ?? "").slice(0, 60),
  );
  check("the off switch means no popup was sent", popupCount === 2, `${String(popupCount)} popup(s)`);
  await request("tools/call", { name: "confirm_action", arguments: { confirmation_id: parked.result.structuredContent.confirmationId } });
} finally {
  const closed = new Promise((resolve) => server.once("close", resolve));
  server.stdin.end();
  await closed;
  rmSync(CONFIG, { force: true });
  rmSync(AUDIT, { force: true });
}

console.log(failed === 0 ? "\nall checks passed" : `\n${String(failed)} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
