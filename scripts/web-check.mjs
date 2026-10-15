import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A private config and audit file, so the checks never touch the operator's files.
const CONFIG = join(tmpdir(), "winadmin-mcp-webcheck.json");
const AUDIT = join(tmpdir(), "winadmin-mcp-webcheck.audit.jsonl");
rmSync(CONFIG, { force: true });
rmSync(AUDIT, { force: true });

// stdin must stay open: a closed stdin is how a stdio MCP client signals shutdown.
const server = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, WAMD_PORT: "8802", WAMD_CONFIG: CONFIG, WAMD_AUDIT: AUDIT } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(`http://127.0.0.1:8802${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());

// Wait for the port instead of guessing how long the box needs to bind it.
for (let i = 0; i < 40; i++) {
  try { await fetch("http://127.0.0.1:8802/api/state"); break } catch { await sleep(500) }
}
await fetch("http://127.0.0.1:8802/api/tools", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ requireApproval: { stop_service: true } }) });

const gated = await post("/api/run", { tool: "stop_service", args: { name: "WSearch" } });
console.log("gated:", gated.output);

const state = await (await fetch("http://127.0.0.1:8802/api/state")).json();
const pid = state.pending[0]?.id;
console.log("pending id:", pid);

const confirmed = await post(`/api/pending/${pid}`, { action: "confirm" });
console.log("confirm status/output:", confirmed.ok, "|", (confirmed.output ?? "").slice(0, 50));

const after = await (await fetch("http://127.0.0.1:8802/api/state")).json();
console.log("pending after:", after.pending.length, "| audit entries:", after.audit.length);

// "Clear" in the web UI drops the recorded calls and rewrites the audit file.
await post("/api/audit/clear", {});
const cleared = await (await fetch("http://127.0.0.1:8802/api/state")).json();
console.log("audit entries after clear:", cleared.audit.length, "| generation:", cleared.audit_generation);

// The disabled/visible toggle round-trips through the config file.
await fetch("http://127.0.0.1:8802/api/tools", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: { resolve_dns: false } }) });
console.log("resolve_dns visible after toggle off:", (await (await fetch("http://127.0.0.1:8802/api/state")).json()).tools.find((t) => t.name === "resolve_dns").enabled);
server.kill();
await new Promise((r) => server.once("close", r));
rmSync(CONFIG, { force: true });
rmSync(AUDIT, { force: true });
