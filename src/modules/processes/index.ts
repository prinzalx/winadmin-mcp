import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ToolContext, ToolDefinition } from "../../types.js";
import { gate } from "../../utils/gate.js";
import { asArray, psQuote, runPowerShell } from "../../utils/powershell.js";
import { fail, ok, text } from "../../utils/result.js";

interface ProcessRow {
  ProcessId: number;
  Name: string;
  WorkingSetSize: number;
  CommandLine: string | null;
}

/**
 * Rejects anything that cannot be a process name before it reaches PowerShell, so a
 * malformed value can never turn into an unintended command.
 */
function assertProcessName(name: string): string | undefined {
  if (!/^[\w.$\-\[\]#~]{1,64}$/.test(name)) {
    return `"${name}" is not a valid process name (letters, digits, . $ - [ ] # ~ are allowed)`;
  }
  return undefined;
}

async function listProcesses(args: {
  name?: string;
  top?: number;
  sort?: "cpu" | "memory" | "name";
}): Promise<CallToolResult> {
  const top = args.top ?? 20;
  const sortKey = args.sort ?? "memory";
  const where = args.name ? ` | Where-Object { $_.Name -like ${psQuote(`*${args.name}*`)} }` : "";

  // Win32_Process has no LoadPercentage, so the CPU ranking uses kernel+user time.
  const sortProp =
    sortKey === "cpu"
      ? "{ $_.UserModeTime + $_.KernelModeTime }"
      : sortKey === "name"
        ? "Name"
        : "WorkingSetSize";

  const script =
    `Get-CimInstance Win32_Process${where} | Sort-Object ${sortProp} -Descending | ` +
    `Select-Object -First ${String(top)} | Select-Object ProcessId, Name, WorkingSetSize, CommandLine | ` +
    "ConvertTo-Json -Depth 3 -Compress";

  const res = await runPowerShell<string>(script, { json: false, timeoutMs: 45_000 });
  if (!res.ok) {
    return fail(`list_processes failed: ${res.error ?? "unknown error"}`);
  }

  const raw = res.stdout.trim();
  if (raw === "") {
    return text("No matching processes", []);
  }

  try {
    const list = asArray<ProcessRow>(JSON.parse(raw) as never);
    return ok(
      list.map((p) => ({
        pid: p.ProcessId,
        name: p.Name,
        memory_mb: Number((Number(p.WorkingSetSize) / 1024 / 1024).toFixed(1)),
        command_line: p.CommandLine ?? "",
      })),
      `${String(list.length)} process(es), sorted by ${sortKey}`,
    );
  } catch {
    return text(res.stdout.trim());
  }
}

export const processTools: ToolDefinition[] = [
  {
    name: "list_processes",
    module: "processes",
    title: "List processes",
    description: "List the top Windows processes with memory usage and command line.",
    input: z.object({
      name: z.string().optional().describe("Substring match on the process name"),
      top: z.number().int().positive().max(200).optional().describe("Maximum number of processes. Defaults to 20"),
      sort: z.enum(["cpu", "memory", "name"]).optional().describe("Sort order. Defaults to memory"),
    }),
    handler: (args) => listProcesses(args as Parameters<typeof listProcesses>[0]),
  },
  {
    name: "get_process",
    module: "processes",
    title: "Get process",
    description: "Get details for one or more processes by exact process name (without .exe).",
    input: z.object({
      name: z.string().min(1).describe("Exact process name, e.g. chrome"),
      max_instances: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("How many instances to return, heaviest first. Defaults to 10"),
    }),
    handler: async (args) => {
      const name = String(args.name).replace(/\.exe$/i, "");
      const invalid = assertProcessName(name);
      if (invalid) {
        return fail(invalid);
      }

      const script =
        `Get-CimInstance Win32_Process -Filter "Name = ${psQuote(`${name}.exe`)}" | ` +
        "Select-Object ProcessId, Name, WorkingSetSize, UserModeTime, CommandLine | ConvertTo-Json -Compress";

      const res = await runPowerShell<string>(script, { json: false });
      if (!res.ok) {
        return fail(`get_process failed: ${res.error ?? "unknown error"}`);
      }

      const raw = res.stdout.trim();
      if (raw === "" || raw === "null") {
        return fail(`No process named "${name}" is running`);
      }

      try {
        const list = asArray<{ ProcessId: number; Name: string; WorkingSetSize: number; CommandLine: string | null }>(
          JSON.parse(raw) as never,
        );
        const maxInstances = Number(args.max_instances ?? 10);
        const ranked = list
          .map((p) => ({
            pid: p.ProcessId,
            memory_mb: Number((Number(p.WorkingSetSize) / 1024 / 1024).toFixed(1)),
            command_line: p.CommandLine ?? "",
          }))
          .sort((a, b) => b.memory_mb - a.memory_mb);

        return ok({
          count: list.length,
          total_memory_mb: Number(
            (list.reduce((sum, p) => sum + Number(p.WorkingSetSize), 0) / 1024 / 1024).toFixed(1),
          ),
          instances: ranked.slice(0, maxInstances),
        });
      } catch {
        return text(raw);
      }
    },
  },
  {
    name: "kill_process",
    module: "processes",
    title: "Kill process",
    description:
      "Stop all instances of a process by name. Refuses the protected system processes (lsass, csrss, svchost, winlogon, smss).",
    input: z.object({
      name: z.string().min(1).describe("Exact process name, with or without .exe"),
      confirmation_id: z.string().optional().describe("Set only when confirming a pending action"),
    }),
    destructive: true,
    handler: (args, ctx: ToolContext) =>
      gate("kill_process", args, ctx, async () => {
        const name = String(args.name);
        const invalid = assertProcessName(name.replace(/\.exe$/i, ""));
        if (invalid) {
          return fail(invalid);
        }
        if (ctx.safety.isProtectedProcess(name)) {
          return fail(`${name} is a protected system process and will not be killed`);
        }

        const res = await runPowerShell<string>(
          `Stop-Process -Name ${psQuote(name.replace(/\.exe$/i, ""))} -Force -PassThru | ` +
            "Select-Object Id, Name | ConvertTo-Json -Compress",
          { json: false },
        );
        return res.ok
          ? text(`Killed ${name}`, res.stdout.trim())
          : fail(`Stop-Process failed: ${res.error ?? "unknown error"}`);
      }),
  },
  {
    name: "check_ports",
    module: "processes",
    title: "Check listening ports",
    description:
      "List listening TCP ports with the owning process, or check a single port. Read-only.",
    input: z.object({
      port: z.number().int().positive().max(65535).optional().describe("Check one specific local port"),
      protocol: z.enum(["TCP", "UDP"]).optional().describe("Defaults to TCP"),
    }),
    handler: async (args) => {
      const protocol = (args.protocol as "TCP" | "UDP" | undefined) ?? "TCP";
      const port = args.port as number | undefined;

      if (port !== undefined) {
        const script =
          `Get-NetTCPConnection -LocalPort ${String(port)} -State Listen -ErrorAction SilentlyContinue | ` +
          "Select-Object LocalAddress, LocalPort, OwningProcess | ConvertTo-Json -Compress";
        const res = await runPowerShell<string>(script, { json: false });
        if (!res.ok) {
          return fail(`check_ports failed: ${res.error ?? "unknown error"}`);
        }
        const raw = res.stdout.trim();
        if (raw === "" || raw === "null") {
          return text(`Port ${String(port)} is not listening`, { port, listening: false });
        }
        return text(`Port ${String(port)} is listening`, { port, listening: true, raw });
      }

      const script =
        `Get-${protocol}Connection${protocol === "TCP" ? " -State Listen" : ""} | ` +
        "Group-Object LocalPort | Sort-Object Name | " +
        "Select-Object Count, Name | ConvertTo-Json -Compress";
      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 45_000 });
      if (!res.ok) {
        return fail(`check_ports failed: ${res.error ?? "unknown error"}`);
      }

      const raw = res.stdout.trim();
      if (raw === "") {
        return text(`No ${protocol} connections found`, []);
      }

      try {
        const list = asArray<Record<string, unknown>>(JSON.parse(raw) as never);
        const ports = list.map((c) => ({
          port: Number(c.Name),
          connections: Number(c.Count),
        }));
        return ok({ protocol, count: ports.length, ports });
      } catch {
        return text(raw);
      }
    },
  },
];
