#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { createAuditLog } from "./audit.js";
import { ARGS, loadConfig } from "./config.js";
import { ALL_TOOLS, TOOLS_BY_NAME } from "./modules/index.js";
import { createSafety } from "./safety.js";
import type { ToolContext, ToolDefinition } from "./types.js";
import { fail, pending, text } from "./utils/result.js";

const VERSION = "0.1.0";

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
 * Runs a tool with validation, the approval gate and auditing. Throws only on unexpected
 * handler bugs.
 *
 * The gate is central on purpose: *every* tool — not only a destructive one — parks when its
 * approval switch is on, so a switch flipped in the web UI always has an effect.
 */
async function invoke(tool: ToolDefinition, args: Record<string, unknown>, source: string): Promise<ToolResult> {
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
      result = pending(action);
    } else {
      result = await tool.handler(parsed.data as Record<string, unknown>, ctx);
    }

    const ms = Date.now() - started;
    const failed = result.isError === true;
    const errorText = failed
      ? String((result.content[0] as { text?: string } | undefined)?.text ?? "tool error")
      : undefined;

    audit.write({ tool: tool.name, args, ok: !failed, durationMs: ms, source, error: errorText });
    traceCall(tool.name, source, !failed, ms, result.structuredContent && "confirmationId" in result.structuredContent ? "parked, waiting for approval" : undefined);
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
  return invoke(tool, { ...pending.args, confirmation_id: id }, source);
}

type RegisteredToolRef = { enabled: boolean };

/**
 * Builds a fresh MCP server with every tool registered, plus the meta tools. The returned
 * sync function mirrors the current enable switches onto the live tool list.
 */
function buildMcpServer(): { server: McpServer; sync: (notify?: boolean) => void } {
  const server = new McpServer(
    { name: "winadmin-mcp", version: VERSION },
    { instructions: "Windows administration tools. Any tool can be switched off in the web interface; destructive tools can be gated behind an approval." },
  );

  const refs = new Map<string, RegisteredToolRef>();

  for (const tool of ALL_TOOLS) {
    const registered = server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: zodShape(tool) as never },
      ((args: Record<string, unknown>) => {
        if (!config.settings.enabledTools[tool.name]) {
          return fail(`${tool.name} is disabled in the web interface`);
        }
        return invoke(tool, args ?? {}, "mcp");
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

  return { server, sync };
}

function isEnabled(name: string): boolean {
  return Boolean(config.settings.enabledTools[name]);
}

// ---------------------------------------------------------------------------
// HTTP control plane (the web interface)
// ---------------------------------------------------------------------------

let lastHealth: unknown = null;

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
        enabled: isEnabled(t.name),
        requires_approval: config.settings.requireApprovalTools[t.name] === true,
      })),
      pending: safety.list(),
      audit: audit.recent(25),
      health: lastHealth,
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
        const { server } = buildMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
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

  if (webDisabled) {
    process.stderr.write("  web interface disabled (--no-web)\n");
  } else {
    await new Promise<void>((resolve) => http.listen(port, resolve));
    process.stderr.write(`  web interface   http://127.0.0.1:${String(port)}\n`);
  }
  process.stderr.write("  MCP transport   stdio — this terminal stays attached to the agent\n\n");

  // stdio is the MCP transport; the web interface keeps running in the same process.
  const { server, sync } = buildMcpServer();

  // Without this the terminal gives no hint that a client connected at all.
  server.server.oninitialized = () => {
    const client = server.server.getClientVersion();
    process.stderr.write(`  client connected: ${client?.name ?? "unknown"} ${client?.version ?? ""}\n`);
  };
  // A committed change (one PATCH, however many switches it touched) is exactly one notification.
  config.onChange(() => sync(true));
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
