import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ToolDefinition } from "../../types.js";
import { asArray, psQuote, runPowerShell } from "../../utils/powershell.js";
import { fail, ok, text } from "../../utils/result.js";

interface ServiceRow {
  Name: string;
  DisplayName: string;
  State: string;
  StartMode: string | null;
  StartName: string;
  ProcessId: number;
}

const COLUMNS = "Name, DisplayName, State, StartMode, StartName, ProcessId";

const START_MODES = ["automatic", "automatic_delayed", "manual", "disabled"] as const;

type StartMode = (typeof START_MODES)[number];

/** `Win32_Service.StartMode` spells its values out, unlike the `Set-Service` enum. */
function wqlStartMode(mode: StartMode): string {
  return mode === "manual" ? "Manual" : mode === "disabled" ? "Disabled" : "Auto Start";
}

function apiStartMode(mode: StartMode): string {
  return mode === "automatic_delayed" ? "AutomaticDelayedStart" : mode === "manual" ? "Manual" : mode === "disabled" ? "Disabled" : "Automatic";
}

/** Reads one service through a WQL query, which filters on the CIM side instead of in PowerShell. */
async function findService(name: string): Promise<ServiceRow | undefined> {
  const wql = `SELECT ${COLUMNS} FROM Win32_Service WHERE Name = ${psQuote(name)}`;
  const res = await runPowerShell<string>(
    `Get-CimInstance -Query ${psQuote(wql)} | ConvertTo-Json -Depth 3 -Compress`,
    { json: false },
  );
  if (!res.ok) {
    return undefined;
  }
  const raw = res.stdout.trim();
  if (raw === "" || raw === "null") {
    return undefined;
  }
  try {
    return asArray<ServiceRow>(JSON.parse(raw) as never)[0];
  } catch {
    return undefined;
  }
}

function readJsonArray(res: { stdout: string }): unknown[] {
  const raw = res.stdout.trim();
  if (raw === "" || raw === "null") {
    return [];
  }
  try {
    return asArray<never>(JSON.parse(raw) as never);
  } catch {
    return [];
  }
}

/** `confirmation_id` is metadata for the gate, never part of the WQL input shape. */
const confirmationField = z
  .string()
  .optional()
  .describe("Set only when confirming a parked action; omit for a direct call");

async function listServices(args: {
  name?: string;
  status?: string;
  startmode?: StartMode;
  search?: string;
}): Promise<CallToolResult> {
  const conditions: string[] = [];

  if (args.name) {
    conditions.push(`Name LIKE ${psQuote(`%${args.name}%`)}`);
  }
  if (args.status) {
    conditions.push(`State = ${psQuote(args.status)}`);
  }
  if (args.startmode) {
    conditions.push(`StartMode = ${psQuote(wqlStartMode(args.startmode))}`);
  }
  if (args.search) {
    conditions.push(
      `(Name LIKE ${psQuote(`%${args.search}%`)} OR DisplayName LIKE ${psQuote(`%${args.search}%`)})`,
    );
  }

  const wql = `SELECT ${COLUMNS} FROM Win32_Service${conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : ""}`;
  const script =
    `Get-CimInstance -Query ${psQuote(wql)} | Sort-Object Name | ` +
    "ConvertTo-Json -Depth 3 -Compress";

  const res = await runPowerShell<string>(script, { json: false, timeoutMs: 60_000 });
  if (!res.ok) {
    return fail(`list_services failed: ${res.error ?? "unknown error"}`);
  }

  const rows = readJsonArray(res).map((item) => {
    const s = item as Partial<ServiceRow>;
    return {
      name: String(s.Name ?? ""),
      display_name: String(s.DisplayName ?? ""),
      status: String(s.State ?? ""),
      start_mode: String(s.StartMode ?? "n/a"),
      log_on: String(s.StartName ?? ""),
      pid: Number(s.ProcessId ?? 0) || null,
    };
  });

  return ok({ count: rows.length, services: rows }, `${String(rows.length)} service(s) match the filter`);
}

async function controlService(verb: "Start" | "Stop", name: string): Promise<CallToolResult> {
  const service = await findService(name);
  if (!service) {
    return fail(`Service "${name}" not found`);
  }

  const res = await runPowerShell<string>(
    `${verb}-Service -Name ${psQuote(name)}; Get-Service -Name ${psQuote(name)} | ` +
      "ConvertTo-Json -Compress",
    { json: false, timeoutMs: 90_000 },
  );
  if (!res.ok) {
    return fail(`${verb}-Service failed: ${res.error ?? "unknown error"}`);
  }

  const status = /"Status"\s*:\s*"([^"]+)"/.exec(res.stdout)?.[1] ?? "unknown";
  return text(`${name} is now ${status}`, { name, status });
}

export const serviceTools: ToolDefinition[] = [
  {
    name: "list_services",
    module: "services",
    title: "List services",
    description:
      "List Windows services with optional filters. Returns name, display name, status, start mode, log-on account and PID.",
    input: z.object({
      name: z.string().optional().describe("Substring match on the service name"),
      status: z.enum(["Running", "Stopped", "Paused"]).optional().describe("Exact state filter"),
      startmode: z.enum(START_MODES).optional().describe("Start mode filter"),
      search: z.string().optional().describe("Substring match on name or display name"),
    }),
    handler: (args) => listServices(args as Parameters<typeof listServices>[0]),
  },
  {
    name: "get_service",
    module: "services",
    title: "Get service",
    description: "Get the exact state of a single service by its service name.",
    input: z.object({
      name: z.string().min(1).describe("The exact service name, e.g. WSearch"),
    }),
    handler: async (args) => {
      const name = String(args.name);
      const service = await findService(name);
      if (!service) {
        return fail(`Service "${name}" not found`);
      }
      return ok({
        name: service.Name,
        display_name: service.DisplayName,
        status: service.State,
        start_mode: service.StartMode ?? "n/a",
        log_on: service.StartName,
        pid: service.ProcessId || null,
      });
    },
  },
  {
    name: "start_service",
    module: "services",
    title: "Start service",
    description: "Start a stopped Windows service.",
    input: z.object({
      name: z.string().min(1).describe("The exact service name"),
      confirmation_id: confirmationField,
    }),
    destructive: true,
    handler: (args) => controlService("Start", String(args.name)),
  },
  {
    name: "stop_service",
    module: "services",
    title: "Stop service",
    description: "Stop a running Windows service.",
    input: z.object({
      name: z.string().min(1).describe("The exact service name"),
      confirmation_id: confirmationField,
    }),
    destructive: true,
    handler: (args) => controlService("Stop", String(args.name)),
  },
  {
    name: "restart_service",
    module: "services",
    title: "Restart service",
    description: "Restart a Windows service.",
    input: z.object({
      name: z.string().min(1).describe("The exact service name"),
      confirmation_id: confirmationField,
    }),
    destructive: true,
    handler: async (args) => {
      const name = String(args.name);
      const res = await runPowerShell<string>(
        `Restart-Service -Name ${psQuote(name)}; Get-Service -Name ${psQuote(name)} | ` +
          "ConvertTo-Json -Compress",
        { json: false, timeoutMs: 90_000 },
      );
      return res.ok
        ? text(`${name} restarted`, { name, status: /"Status"\s*:\s*"([^"]+)"/.exec(res.stdout)?.[1] ?? "unknown" })
        : fail(`Restart-Service failed: ${res.error ?? "unknown error"}`);
    },
  },
  {
    name: "set_service_startmode",
    module: "services",
    title: "Set service start mode",
    description: "Change the start mode of a Windows service.",
    input: z.object({
      name: z.string().min(1).describe("The exact service name"),
      startmode: z.enum(START_MODES).describe("The new start mode"),
      confirmation_id: confirmationField,
    }),
    destructive: true,
    handler: async (args) => {
      const name = String(args.name);
      const mode = args.startmode as StartMode;
      const res = await runPowerShell<string>(
        `Set-Service -Name ${psQuote(name)} -StartupType ${psQuote(apiStartMode(mode))}; ` +
          `Get-Service -Name ${psQuote(name)} | Select-Object Name, StartType | ConvertTo-Json -Compress`,
        { json: false },
      );
      return res.ok
        ? text(`${name} start mode set to ${mode}`, res.stdout.trim())
        : fail(`Set-Service failed: ${res.error ?? "unknown error"}`);
    },
  },
];
