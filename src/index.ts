#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { createAuditLog } from "./audit.js";
import { ARGS, loadConfig } from "./config.js";
import { ALL_TOOLS, MODULE_DOCS, TOOLS_BY_NAME } from "./modules/index.js";
import { createSafety } from "./safety.js";
import type { ToolContext, ToolDefinition } from "./types.js";
import { fail, gated, pending, text } from "./utils/result.js";

// Read from package.json so a release bump has exactly one place to be updated. The file sits
// next to dist/ in every install, including a global npm one.
const VERSION = (() => {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");
    return String((JSON.parse(raw) as { version?: string }).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

const RELEASES_URL = "https://github.com/prinzalx/winadmin-mcp/releases";
const LATEST_URL = "https://api.github.com/repos/prinzalx/winadmin-mcp/releases/latest";

/** Set by {@link checkForUpdate} when GitHub offers a newer release. */
let latestVersion: string | null = null;

/** Compares `1.2.3` style versions; a `v` prefix is tolerated on both sides. */
function isNewer(candidate: string, current: string): boolean {
  const parts = (s: string) => s.replace(/^v/i, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/**
 * One lookup of the newest release, so the UI can point at an update.
 *
 * Off the critical path: the server starts whether or not GitHub answers, and
 * `WAMD_NO_UPDATE_CHECK=1` skips it entirely (CI, machines without egress).
 */
async function checkForUpdate(): Promise<void> {
  try {
    const res = await fetch(LATEST_URL, {
      headers: { "user-agent": "winadmin-mcp", accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return;
    }
    const body = (await res.json()) as { tag_name?: string };
    const tag = String(body.tag_name ?? "").replace(/^v/i, "");
    if (tag !== "" && isNewer(tag, VERSION)) {
      latestVersion = tag;
      process.stderr.write(`  update available: ${tag} — running ${VERSION}\n`);
    }
  } catch {
    // No egress or a GitHub hiccup; the version line already printed is enough.
  }
}

const config = loadConfig(ALL_TOOLS);
const audit = createAuditLog();
const safety = createSafety(config);
const ctx: ToolContext = { config, safety, audit };

type ToolResult = Awaited<ReturnType<ToolDefinition["handler"]>>;

function zodShape(tool: ToolDefinition): Record<string, unknown> {
  return (tool.input as unknown as { shape?: Record<string, unknown> }).shape ?? {};
}

/** One compact line per call: what ran, from where, how long it took. */
function traceCall(tool: string, source: string, okFlag: boolean, ms: number, note?: string): void {
  const mark = okFlag ? "ok" : "err";
  process.stderr.write(`  ${mark.padEnd(4)} ${tool} (${source}) ${String(ms)} ms${note ? ` ${note}` : ""}\n`);
}

/**
 * The stdio MCP server, set once in `main()`. Used as a fallback for the approval popup when a
 * call is not tied to a specific connection.
 */
let mcpServer: McpServer | null = null;

/**
 * Asks for approval through the client's own popup (`elicitation/create`) and — if the human
 * accepts — runs the action right here, so the result reaches the agent in the same call.
 *
 * Returns `undefined` when the client cannot or may not be asked (no elicitation capability,
 * the `askInAgent` switch off, or the request failed); the caller then parks the action for the
 * web interface like before.
 */
async function askInClientPopup(
  tool: ToolDefinition,
  parsedArgs: Record<string, unknown>,
  action: { id: string; tool: string },
  from: McpServer | undefined,
  requestId?: string | number,
): Promise<ToolResult | undefined> {
  const elicit = (from ?? mcpServer)?.server;
  // An empty `elicitation: {}` still means the client can answer a form; the SDK itself insists on
  // the `form` sub-flag, and a throw there falls through to parking below.
  if (!elicit?.getClientCapabilities()?.elicitation) {
    return undefined;
  }

  let answer: Awaited<ReturnType<typeof elicit.elicitInput>>;
  try {
    answer = await elicit.elicitInput(
      {
        mode: "form",
        message: `Run ${tool.name} ${JSON.stringify(parsedArgs)}?`,
        requestedSchema: {
          type: "object",
          properties: { approved: { type: "boolean", title: "Approve", default: true } },
        },
      },
      // Over HTTP the answer must go back on the stream of this very call, which the SDK finds
      // through relatedRequestId; stdio does not need it.
      requestId === undefined ? { timeout: POPUP_TIMEOUT_MS } : { timeout: POPUP_TIMEOUT_MS, relatedRequestId: requestId },
    );
  } catch (cause) {
    // A client that claimed elicitation but cannot answer one must not lose the call: park instead.
    process.stderr.write(`  popup failed (${String(cause instanceof Error ? cause.message : cause)}), parking instead\n`);
    return undefined;
  }

  // A form can also be submitted with the box unticked, which counts as a decline.
  const approved = answer.action === "accept" && answer.content?.approved !== false;
  if (!approved) {
    // Decline and cancel both drop the parked action; nothing ran.
    safety.cancel(action.id);
    return gated(action, answer.action === "cancel" ? "cancelled" : "declined", fail("not executed"));
  }
  // `take` so a simultaneous "Run" in the web UI cannot execute the action a second time.
  if (!safety.take(action.id)) {
    return gated(action, "accepted", fail("already executed through the web interface"));
  }
  try {
    return gated(action, "accepted", await tool.handler(parsedArgs, ctx));
  } catch (cause) {
    return gated(action, "accepted", fail(cause instanceof Error ? cause.message : String(cause)));
  }
}

/**
 * Runs a tool with validation, the approval gate and auditing. Throws only on unexpected
 * handler bugs.
 *
 * The gate is central on purpose: *every* tool — not only a destructive one — is gated when its
 * approval switch is on, so a switch flipped in the web UI always has an effect.
 */
async function invoke(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  source: string,
  from?: McpServer,
  requestId?: string | number,
): Promise<ToolResult> {
  const started = Date.now();

  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    audit.write({ tool: tool.name, args, ok: false, durationMs: Date.now() - started, source, error: message });
    traceCall(tool.name, source, false, Date.now() - started, "invalid input");
    return fail(`Invalid input for ${tool.name} — ${message}`);
  }

  try {
    let result: ToolResult;
    const confirmationId = (args ?? {}).confirmation_id;

    if (typeof confirmationId === "string") {
      // An agent that parks an action and confirms it itself has granted itself permission, so
      // the human in front of the web interface is asked by default. See allowAgentConfirm.
      if (source === "mcp" && !config.settings.allowAgentConfirm) {
        const message = `${tool.name}: approval is for the human in the web interface. The parked action stays pending.`;
        audit.write({ tool: tool.name, args, ok: false, durationMs: Date.now() - started, source, error: message });
        traceCall(tool.name, source, false, Date.now() - started, "agent may not confirm");
        return fail(message);
      }
      // The confirmation consumes the parked action; a second path with the same id must fail.
      if (!safety.take(confirmationId)) {
        const message = `Unknown or expired confirmation_id "${confirmationId}"`;
        audit.write({ tool: tool.name, args, ok: false, durationMs: Date.now() - started, source, error: message });
        traceCall(tool.name, source, false, Date.now() - started, message);
        return fail(message);
      }
      result = await tool.handler(parsed.data as Record<string, unknown>, ctx);
    } else if (safety.needsApproval(tool.name)) {
      const action = safety.create(tool.name, args ?? {}, source);
      if (source === "mcp" && config.settings.askInAgent) {
        // First choice: the popup lives in the agent's TUI and the result comes back in this call.
        const popup = await askInClientPopup(tool, parsed.data as Record<string, unknown>, action, from, requestId);
        if (popup) {
          result = popup;
        } else {
          result = pending(action, config.settings.allowAgentConfirm);
        }
      } else {
        // Over HTTP the caller is the web interface, i.e. a human, so it always may confirm.
        result = pending(action, source !== "mcp" || config.settings.allowAgentConfirm);
      }
    } else {
      result = await tool.handler(parsed.data as Record<string, unknown>, ctx);
    }

    const ms = Date.now() - started;
    const failed = result.isError === true;
    const errorText = failed
      ? String((result.content[0] as { text?: string } | undefined)?.text ?? "tool error")
      : undefined;

    audit.write({ tool: tool.name, args, ok: !failed, durationMs: ms, source, error: errorText });
    traceCall(tool.name, source, !failed, ms, result.structuredContent && "confirmationId" in result.structuredContent ? ("decision" in result.structuredContent ? "answered in client popup" : "parked, waiting for approval") : undefined);
    return result;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    audit.write({ tool: tool.name, args, ok: false, durationMs: Date.now() - started, source, error: message });
    traceCall(tool.name, source, false, Date.now() - started, message);
    return fail(`${tool.name} threw: ${message}`);
  }
}

/**
 * Executes a parked action by id. Used by both the `confirm_action` MCP tool and the web
 * "Run" button.
 */
async function confirmById(id: string, source: string): Promise<ToolResult> {
  // Peek only: the tool's own gate consumes the id, so exactly one path can execute it.
  const pending = safety.peek(id);
  if (!pending) {
    return fail(`Unknown or expired confirmation_id "${id}"`);
  }
  const tool = TOOLS_BY_NAME.get(pending.tool);
  if (!tool) {
    return fail(`Unknown tool "${pending.tool}"`);
  }
  return invoke(tool, { ...pending.args, confirmation_id: id }, source, undefined);
}

type RegisteredToolRef = { enabled: boolean };

/**
 * Builds a fresh MCP server with every tool registered, plus the meta tools. The returned
 * sync function mirrors the current enable switches onto the live tool list.
 */
function buildMcpServer(): { server: McpServer; sync: (notify?: boolean) => void; dispose: () => void } {
  const server = new McpServer(
    { name: "winadmin-mcp", version: VERSION },
    { instructions: "Windows administration tools. Any tool can be switched off in the web interface. A tool whose approval switch is on asks the human in a popup when the client supports elicitation, and then answers with the real result; otherwise it returns a confirmation_id and waits for the human, and the agent must not confirm it itself unless the operator allows that." },
  );

  const refs = new Map<string, RegisteredToolRef>();

  for (const tool of ALL_TOOLS) {
    const registered = server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: zodShape(tool) as never },
      ((args: Record<string, unknown>, extra: { requestId?: string | number }) => {
        if (!config.settings.enabledTools[tool.name]) {
          return fail(`${tool.name} is disabled in the web interface`);
        }
        return invoke(tool, args ?? {}, "mcp", server, extra?.requestId);
      }) as never,
    );
    refs.set(tool.name, registered);
  }

  server.registerTool(
    "list_pending",
    {
      title: "List pending actions",
      description: "List destructive actions waiting for approval.",
      inputSchema: {},
    },
    async () => {
      const items = safety.list();
      return text(items.map((a) => `${a.id}  ${a.tool}  ${JSON.stringify(a.args)}`).join("\n") || "No pending actions", items);
    },
  );

  server.registerTool(
    "confirm_action",
    {
      title: "Confirm action",
      description: "Executes a destructive action that is waiting for approval, by its confirmation_id.",
      inputSchema: { confirmation_id: z.string().describe("The id returned by the original tool call") },
    },
    async (args: { confirmation_id?: string }) => {
      const id = args?.confirmation_id;
      if (!id) {
        return fail("confirm_action needs a confirmation_id");
      }
      return confirmById(id, "mcp");
    },
  );

  // Writing `enabled` directly changes the list without a notification per tool; the single
  // `list_changed` for a whole config commit is sent separately. One PATCH must not print 22
  // notifications in the terminal.
  const sync = (notify = false) => {
    for (const [name, ref] of refs) {
      ref.enabled = Boolean(config.settings.enabledTools[name]);
    }
    // Without a connected client the SDK would throw on `notification()`.
    if (notify && server.isConnected()) void server.server.sendToolListChanged();
  };
  sync();

  // A session that ends must also stop listening: otherwise every web change would walk a list of
  // servers that are long gone.
  const unsubscribe = config.onChange(() => sync(true));

  return { server, sync, dispose: unsubscribe };
}

function isEnabled(name: string): boolean {
  return Boolean(config.settings.enabledTools[name]);
}

// ---------------------------------------------------------------------------
// HTTP control plane (the web interface)
// ---------------------------------------------------------------------------

let lastHealth: unknown = null;

/**
 * A client that declares `elicitation: {}` means the original form mode; only the SDK's
 * `elicitInput` insists on the `form` sub-flag being spelled out. Filling it in keeps such a
 * client from falling back to parking.
 */
function normalizeElicitationCaps(server: McpServer): void {
  const elicitation = server.server.getClientCapabilities()?.elicitation as Record<string, unknown> | undefined;
  if (elicitation && elicitation.form === undefined && elicitation.url === undefined) {
    elicitation.form = {};
  }
}

/**
 * One MCP-over-HTTP session. The streamable transport has to be stateful here: a request that
 * arrives later (the `tools/call`) still needs the capabilities the client reported at
 * `initialize`, and it needs an open stream so the server can ask something back.
 */
interface McpHttpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  /** Stops the config subscription this session registered. */
  dispose: () => void;
  lastSeen: number;
}

const httpSessions = new Map<string, McpHttpSession>();

/** Parked approvals wait for a human, so a sweep of idle sessions is done on every request. */
const SESSION_IDLE_MS = 30 * 60 * 1000;

/** How long a human may take over the approval popup before the action parks instead. */
const POPUP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * MCP over Streamable HTTP, with real sessions. Stateless-per-request would answer every
 * `tools/call` with a server that never saw the client's `initialize`, so the client capabilities
 * — and with them the approval popup — would always look absent.
 */
async function handleMcpHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  for (const [id, session] of httpSessions) {
    if (Date.now() - session.lastSeen > SESSION_IDLE_MS) {
      httpSessions.delete(id);
      session.dispose();
      await session.transport.close();
      await session.server.close();
    }
  }

  const wanted = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(wanted) ? wanted[0] : wanted;

  let session = sessionId ? httpSessions.get(sessionId) : undefined;
  if (sessionId && !session) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Unknown MCP session" }));
    return;
  }

  if (!session) {
    const built = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    // The session must outlive the request that created it, so nothing is closed on `res.close`.
  transport.onclose = () => {
      const id = transport.sessionId;
      if (id && httpSessions.has(id)) {
        httpSessions.delete(id);
        built.dispose();
        void built.server.close();
      }
    };
    await built.server.connect(transport);
    await transport.handleRequest(req, res);
    normalizeElicitationCaps(built.server);
    if (transport.sessionId) {
      httpSessions.set(transport.sessionId, { server: built.server, transport, dispose: built.dispose, lastSeen: Date.now() });
    } else {
      // A failed handshake: nothing to keep.
      await transport.close();
      await built.server.close();
    }
    return;
  }

  session.lastSeen = Date.now();
  if (req.method === "DELETE") {
    await session.transport.handleRequest(req, res);
    httpSessions.delete(sessionId!);
    session.dispose();
    await session.server.close();
    return;
  }
  await session.transport.handleRequest(req, res);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = async (): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  };

  if (url.pathname === "/api/state") {
    return send(200, {
      version: VERSION,
      config_path: config.path,
      audit_path: audit.path,
      tools: ALL_TOOLS.map((t) => ({
        name: t.name,
        module: t.module,
        title: t.title,
        description: t.description,
        destructive: t.destructive === true,
        docs: t.docs ?? "",
        enabled: isEnabled(t.name),
        requires_approval: config.settings.requireApprovalTools[t.name] === true,
      })),
      module_docs: MODULE_DOCS,
      pending: safety.list(),
      audit: audit.recent(25),
      audit_generation: audit.generation(),
      health: lastHealth,
      releases_url: RELEASES_URL,
      latest_version: latestVersion,
      allow_agent_confirm: config.settings.allowAgentConfirm,
      ask_in_agent: config.settings.askInAgent,
    });
  }

  if (url.pathname === "/api/tools" && req.method === "PATCH") {
    const body = await readBody();
    const enabled = (body.enabled ?? {}) as Record<string, boolean>;
    const approval = (body.requireApproval ?? {}) as Record<string, boolean>;

    for (const [name, value] of Object.entries(enabled)) {
      if (!TOOLS_BY_NAME.has(name)) return send(400, { error: `Unknown tool "${name}"` });
      config.settings.enabledTools[name] = Boolean(value);
    }
    for (const [name, value] of Object.entries(approval)) {
      if (!TOOLS_BY_NAME.has(name)) return send(400, { error: `Unknown tool "${name}"` });
      config.settings.requireApprovalTools[name] = Boolean(value);
    }

    config.commit();
    return send(200, { ok: true, saved_to: config.path });
  }

  if (url.pathname === "/api/settings" && req.method === "PATCH") {
    const body = await readBody();
    if (typeof body.allowAgentConfirm === "boolean") {
      config.settings.allowAgentConfirm = body.allowAgentConfirm;
    }
    if (typeof body.askInAgent === "boolean") {
      config.settings.askInAgent = body.askInAgent;
    }
    config.commit();
    return send(200, {
      ok: true,
      allow_agent_confirm: config.settings.allowAgentConfirm,
      ask_in_agent: config.settings.askInAgent,
    });
  }

  if (url.pathname === "/api/audit/clear" && req.method === "POST") {
    audit.clear();
    return send(200, { ok: true, audit_path: audit.path });
  }

  const pendingMatch = /^\/api\/pending\/([\w-]+)$/.exec(url.pathname);
  if (pendingMatch && req.method === "POST") {
    const id = pendingMatch[1]!;
    const body = await readBody();
    if (String(body.action ?? "confirm") === "cancel") {
      safety.cancel(id);
      return send(200, { ok: true, cancelled: id });
    }
    const result = await confirmById(id, "web");
    return send(result.isError ? 409 : 200, {
      ok: result.isError !== true,
      output: result.content.map((c) => ("text" in c ? c.text : "")).join("\n"),
    });
  }

  if (url.pathname === "/api/run" && req.method === "POST") {
    const body = await readBody();
    const tool = TOOLS_BY_NAME.get(String(body.tool ?? ""));
    if (!tool) return send(404, { error: `Unknown tool "${String(body.tool)}"` });
    const result = await invoke(tool, (body.args as Record<string, unknown>) ?? {}, "web");
    return send(200, {
      ok: result.isError !== true,
      output: result.content.map((c) => ("text" in c ? c.text : "")).join("\n"),
    });
  }

  return send(404, { error: `No API route for ${url.pathname}` });
}

async function refreshHealth(): Promise<void> {
  const tool = TOOLS_BY_NAME.get("system_health");
  if (!tool) return;
  const result = await tool.handler({}, ctx);
  if (result.structuredContent) {
    lastHealth = (result.structuredContent as { result?: unknown }).result ?? null;
  }
}

function serveHtml(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(readFileSync(fileURLToPath(new URL("./webui.html", import.meta.url)), "utf8"));
}

const BANNER = String.raw`
██╗    ██╗██╗███╗   ██╗ █████╗ ██████╗ ███╗   ███╗██╗███╗   ██╗  ███╗   ███╗ ██████╗██████╗
██║    ██║██║████╗  ██║██╔══██╗██╔══██╗████╗ ████║██║████╗  ██║  ████╗ ████║██╔═════██╔══██╗
██║ █╗ ██║██║██╔██╗ ██║███████║██║  ██║██╔████╔██║██║██╔██╗ ██║  ██╔████╔██║██║     ██████╔╝
██║███╗██║██║██║╚██╗██║██╔══██║██║  ██║██║╚██╔╝██║██║██║╚██╗██║  ██║╚██╔╝██║██║     ██╔═══╝
╚███╔███╔╝██║██║ ╚████║██║  ██║██████╔╝██║ ╚═╝ ██║██║██║ ╚████║  ██║ ╚═╝ ██║╚██████╗██║
 ╚══╝╚══╝ ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═════╝ ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝  ╚═╝     ╚═╝ ╚═════╝╚═╝
`;

const HELP = `winadmin-mcp — Windows administration MCP server

usage: node dist/index.js [options]

  --port <n>     web interface port (default 8787, env WAMD_PORT)
  --no-web       do not start the web interface; stdio only
  --config <p>   path to the JSON config file (env WAMD_CONFIG)
  --help         show this text
`;

async function main(): Promise<void> {
  if (ARGS.get("help") === true) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const webDisabled = ARGS.get("no-web") === true || process.env.WAMD_NO_WEB === "1";
  const port = Number(ARGS.get("port") ?? process.env.WAMD_PORT ?? 8787);

  await refreshHealth().catch(() => undefined);

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      if (url.pathname === "/mcp") {
        await handleMcpHttp(req, res);
        return;
      }
      if (req.method === "GET") {
        serveHtml(res);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    } catch (cause) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(cause instanceof Error ? cause.message : cause));
    }
  });

  process.stderr.write(`\n${BANNER}\n`);
  process.stderr.write(`  version         v${VERSION}\n`);

  if (webDisabled) {
    process.stderr.write("  web interface disabled (--no-web)\n");
  } else {
    await new Promise<void>((resolve) => http.listen(port, resolve));
    process.stderr.write(`  web interface   http://127.0.0.1:${String(port)}\n`);
  }
  process.stderr.write("  MCP transport   stdio — this terminal stays attached to the agent\n");

  // Printed after the transport lines so the update hint lands last, and never blocks startup.
  if (process.env.WAMD_NO_UPDATE_CHECK !== "1") void checkForUpdate();
  process.stderr.write("\n");

  // stdio is the MCP transport; the web interface keeps running in the same process.
  const { server, sync } = buildMcpServer();
  mcpServer = server;

  // Without this the terminal gives no hint that a client connected at all, and the popup needs
  // to know whether the client can show one.
  server.server.oninitialized = () => {
    normalizeElicitationCaps(server);
    const client = server.server.getClientVersion();
    process.stderr.write(
      `  client connected: ${client?.name ?? "unknown"} ${client?.version ?? ""}` +
        ` — popup ${server.server.getClientCapabilities()?.elicitation ? "supported" : "not supported by this client"}\n`,
    );
  };
  // The stdio server lives as long as the process, so its config subscription (registered inside
  // buildMcpServer) is never removed.
  const stdio = new StdioServerTransport();
  await server.connect(stdio);

  const shutdown = () => {
    http.close();
    void server.close();
    process.exit(0);
  };

  // When the MCP client closes stdin, the web interface must not keep the process alive.
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((cause) => {
  process.stderr.write(`fatal: ${String(cause instanceof Error ? cause.message : cause)}\n`);
  process.exit(1);
});

export { buildMcpServer, config, audit, safety, ctx, invoke };
