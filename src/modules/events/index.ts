import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ToolDefinition } from "../../types.js";
import { explainEventId } from "../../data/event-ids.js";
import { asArray, psQuote, runPowerShell } from "../../utils/powershell.js";
import { fail, ok, text } from "../../utils/result.js";

interface EventRow {
  TimeCreated: string;
  Id: number;
  LevelDisplayName: string;
  Provider: string;
  Message: string;
}

/**
 * `Get-WinEvent` needs a hashtable, so the filters are assembled as an inline literal.
 * Every value goes through `psQuote`, which keeps the literal single-quoted and therefore
 * inert.
 */
function buildFilter(input: {
  log?: string;
  level?: string;
  hours?: number;
  start?: string;
  end?: string;
  event_id?: number;
  source?: string;
}): string {
  const parts = [`LogName = ${psQuote(input.log ?? "System")}`];

  if (input.event_id !== undefined) {
    parts.push(`ID = ${String(input.event_id)}`);
  }
  if (input.level) {
    const levelNumber = { critical: 1, error: 2, warning: 3, info: 4, verbose: 5 }[input.level];
    if (levelNumber !== undefined) {
      parts.push(`Level = ${String(levelNumber)}`);
    }
  }
  if (input.source) {
    parts.push(`ProviderName = ${psQuote(input.source)}`);
  }
  if (input.start) {
    parts.push(`StartTime = [datetime]${psQuote(input.start)}`);
  }
  if (input.end) {
    parts.push(`EndTime = [datetime]${psQuote(input.end)}`);
  }
  if (!input.start && !input.end) {
    parts.push(`StartTime = ((Get-Date).AddHours(-${String(input.hours ?? 24)}))`);
  }

  return `@{ ${parts.join("; ")} }`;
}

async function readEvents(
  filter: string,
  max: number,
): Promise<{ rows: EventRow[]; error?: string }> {
  const script =
    `Get-WinEvent -FilterHashtable ${filter} -MaxEvents ${String(max)} -ErrorAction SilentlyContinue | ` +
    "Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, Message | ConvertTo-Json -Depth 3 -Compress";

  const res = await runPowerShell<string>(script, { json: false, timeoutMs: 60_000 });
  if (!res.ok) {
    return { rows: [], error: res.error };
  }

  const raw = res.stdout.trim();
  if (raw === "") {
    return { rows: [] };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return {
      rows: list.map((item) => {
        const e = item as Record<string, unknown>;
        return {
          TimeCreated: String(e.TimeCreated ?? ""),
          Id: Number(e.Id ?? 0),
          LevelDisplayName: String(e.LevelDisplayName ?? ""),
          Provider: String(e.ProviderName ?? ""),
          Message: String(e.Message ?? "").replace(/\s+/g, " ").trim(),
        };
      }),
    };
  } catch {
    return { rows: [], error: "Could not parse the event output" };
  }
}

function shape(row: EventRow) {
  return {
    time: row.TimeCreated,
    id: row.Id,
    level: row.LevelDisplayName,
    provider: row.Provider,
    message: row.Message.length > 400 ? `${row.Message.slice(0, 400)}...` : row.Message,
  };
}

export const eventTools: ToolDefinition[] = [
  {
    name: "query_events",
    module: "events",
    title: "Query events",
    description:
      "Query the Windows Event Log. Newest events first. Filters combine with AND.",
    input: z.object({
      log: z
        .enum(["System", "Application", "Security", "Setup"])
        .optional()
        .describe("The log to query. Defaults to System"),
      level: z.enum(["critical", "error", "warning", "info"]).optional().describe("Maximum severity"),
      hours: z.number().int().positive().max(8760).optional().describe("Look-back window in hours. Defaults to 24"),
      event_id: z.number().int().positive().optional().describe("Exact event id"),
      source: z.string().optional().describe("Provider name, e.g. Service Control Manager"),
      max_events: z.number().int().positive().max(1000).optional().describe("Maximum number of events. Defaults to 50"),
    }),
    handler: async (args) => {
      const max = Number(args.max_events ?? 50);
      const { rows, error } = await readEvents(buildFilter(args as never), max);
      if (error) {
        return fail(`query_events failed: ${error}`);
      }
      const shaped = rows.map(shape);
      return ok(
        { count: shaped.length, events: shaped },
        `${String(shaped.length)} event(s) in the selected window`,
      );
    },
  },
  {
    name: "summary_events",
    module: "events",
    title: "Summarize events",
    description:
      "Error and warning counts per provider for a log. A fast way to find which component is misbehaving.",
    input: z.object({
      log: z.enum(["System", "Application", "Security", "Setup"]).optional().describe("Defaults to System"),
      hours: z.number().int().positive().max(8760).optional().describe("Look-back window in hours. Defaults to 24"),
    }),
    handler: async (args) => {
      const filter = buildFilter({
        log: args.log as string | undefined,
        hours: args.hours as number | undefined,
      });
      const script =
        `Get-WinEvent -FilterHashtable ${filter} -ErrorAction SilentlyContinue | ` +
        "Where-Object { $_.Level -le 3 } | Group-Object ProviderName | Sort-Object Count -Descending | " +
        "Select-Object Count, Name | ConvertTo-Json -Compress";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 60_000 });
      if (!res.ok) {
        return fail(`summary_events failed: ${res.error ?? "unknown error"}`);
      }

      const raw = res.stdout.trim();
      if (raw === "") {
        return text("No errors or warnings in the selected window", []);
      }

      try {
        const parsed: unknown = JSON.parse(raw);
        const list = asArray<Record<string, unknown>>(parsed as never);
        const groups = list.map((g) => ({ count: Number(g.Count ?? 0), provider: String(g.Name ?? "") }));
        return ok(groups, `${String(groups.length)} provider(s) reported errors or warnings`);
      } catch {
        return text(res.stdout.trim());
      }
    },
  },
  {
    name: "explain_event_id",
    module: "events",
    title: "Explain event id",
    description:
      "Explain what a Windows event id usually means, including a likely cause. Offline lookup, costs no process start.",
    input: z.object({
      event_id: z.number().int().positive().describe("The event id to explain"),
      log: z.enum(["System", "Application", "Security", "Setup"]).optional().describe("Only used to word the answer"),
    }),
    handler: async (args) => {
      const id = Number(args.event_id);
      const info = explainEventId(id, args.log as string | undefined);
      return ok({ event_id: id, ...info });
    },
  },
];
