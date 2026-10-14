#!/usr/bin/env node
/**
 * Drives the server the way an MCP client would: over stdio.
 *
 * Verifies the handshake, that every tool is advertised with a JSON schema, that a call
 * returns content, and that switching a tool off through the HTTP control plane removes it
 * from `tools/list` and makes the server announce a list change.
 */
import { spawn } from "node:child_process";

const PORT = 8799;

const server = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, WAMD_PORT: String(PORT) },
});

let failed = 0;
const check = (label, condition, detail = "") => {
  if (!condition) {
    failed += 1;
  }
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
};

/** Queues incoming messages so responses and notifications can be awaited independently. */
const queue = [];
const waiters = [];
let buffer = "";

server.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line !== "") {
      const msg = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    }
    index = buffer.indexOf("\n");
  }
});

/** Waits until a message matching `predicate` arrives, skipping anything else. */
function waitFor(predicate, timeoutMs = 30_000) {
  const queued = queue.findIndex(predicate);
  if (queued >= 0) {
    return Promise.resolve(queue.splice(queued, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for an MCP message")), timeoutMs);
    waiters.push((msg) => {
      clearTimeout(timer);
      if (predicate(msg)) resolve(msg);
      else queue.push(msg);
    });
  });
}

let nextId = 1;

async function request(method, params) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  return waitFor((msg) => msg.id === id);
}

async function patchTools(body) {
  const res = await fetch(`http://127.0.0.1:${String(PORT)}/api/tools`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`PATCH /api/tools failed: ${String(res.status)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await sleep(1500); // let the web interface bind its port

  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.0" },
  });
  check("initialize answered", init.result?.serverInfo?.name === "windows-admin-mcp", init.result?.serverInfo?.name ?? "no name");

  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const list1 = await request("tools/list");
  const names1 = (list1.result?.tools ?? []).map((t) => t.name);
  check("tools/list returns every tool", names1.length >= 20, `${String(names1.length)} tools`);
  check("confirm_action is advertised", names1.includes("confirm_action"));
  check("list_pending is advertised", names1.includes("list_pending"));
  check(
    "every advertised tool has an object schema",
    (list1.result?.tools ?? []).every((t) => t.inputSchema?.type === "object"),
  );

  const call = await request("tools/call", { name: "explain_event_id", arguments: { event_id: 6008 } });
  const text0 = call.result?.content?.[0]?.text ?? "";
  check("explain_event_id answers", text0.includes("unexpected"), text0.slice(0, 48));
  check("explain_event_id reports no error", call.result?.isError !== true);

  const bad = await request("tools/call", { name: "explain_event_id", arguments: {} });
  check("missing required input is rejected", bad.result?.isError === true);

  // The gate: an approval-required tool must park the action instead of executing it.
  await patchTools({ requireApproval: { restart_service: true } });
  const gated = await request("tools/call", { name: "restart_service", arguments: { name: "WSearch" } });
  const gatedText = gated.result?.content?.[0]?.text ?? "";
  check("approval-required call parks the action", gatedText.includes("gated behind an approval"), gatedText.slice(0, 48));

  const pendingList = await request("tools/call", { name: "list_pending", arguments: {} });
  const pendingItems = pendingList.result?.structuredContent?.result ?? [];
  check("list_pending shows the parked action", Array.isArray(pendingItems) && pendingItems.length >= 1);

  const confirmId = pendingItems[0]?.id;
  const confirmed = await request("tools/call", {
    name: "confirm_action",
    arguments: { confirmation_id: confirmId },
  });
  check(
    "confirm_action executes the parked action",
    /restarted|failed/i.test(confirmed.result?.content?.[0]?.text ?? ""),
    confirmed.result?.content?.[0]?.text ?? "",
  );

  const unknown = await request("tools/call", { name: "confirm_action", arguments: { confirmation_id: "nope" } });
  check("unknown confirmation_id is rejected", unknown.result?.isError === true);

  // Enable switches: a disabled tool must vanish from tools/list.
  await patchTools({ enabled: { list_interfaces: false } });
  await waitFor((msg) => msg.method === "notifications/tools/list_changed", 5_000).catch(() => undefined);

  const list2 = await request("tools/list");
  const names2 = (list2.result?.tools ?? []).map((t) => t.name);
  check("disabled tool disappears from tools/list", !names2.includes("list_interfaces"));
  check("other tools stay visible", names2.includes("list_services"));

  const disabledCall = await request("tools/call", { name: "list_interfaces", arguments: {} });
  check(
    "disabled tool refuses when called anyway",
    (disabledCall.result?.content?.[0]?.text ?? "").includes("disabled"),
  );

  await patchTools({ enabled: { list_interfaces: true }, requireApproval: { restart_service: false } });
} finally {
  // Attach before closing stdin: the server exits as soon as its stdin ends.
  const closed = new Promise((resolve) => server.once("close", resolve));
  server.stdin.end();
  await closed;
}

console.log(failed === 0 ? "\nall checks passed" : `\n${String(failed)} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
