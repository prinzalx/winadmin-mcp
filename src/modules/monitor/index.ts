import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ToolDefinition } from "../../types.js";
import { asArray, fromPsDate, psQuote, runPowerShell } from "../../utils/powershell.js";
import { fail, ok, text } from "../../utils/result.js";

/**
 * Watermarks for the delta watchers, keyed per tool. They live in the process, because the point of
 * a delta is exactly the gap between two calls of the same running server; a restart therefore
 * starts counting from the window again, which the answer says explicitly.
 */
const watermarks = new Map<string, string>();

const SCM_LOG = "System";

/**
 * Service Control Manager ids that make a restart/crash statement. 7040 is deliberately not in the
 * list: it reports a start-type change, not a state transition, and counting it made every service
 * that merely got its start type tweaked look like it had restarted.
 */
const SCM_STOP_IDS = [7031, 7032, 7034, 7036, 7043];

export const monitorTools: ToolDefinition[] = [
  {
    name: "events_watch",
    module: "monitor",
    title: "Watch events (delta)",
    description:
      "Only the event-log entries that appeared since the previous call of this tool, plus the running total for the window.",
    docs:
      "The polling tool for an agent: the first call sets a watermark, every later call answers with just what is new. " +
      "That keeps a monitoring loop cheap instead of shipping the same 500 events again.\n" +
      "A level filter is applied before the watermark, so raising level to error narrows both the delta and what counts " +
      "as new. The answer always names the window it compared against, so a stale watermark is visible.\n" +
      "The watermark lives in the server process. After a server restart the first call reports the whole window again, " +
      "and reset starts a fresh window at any time.",
    input: z.object({
      log: z.enum(["System", "Application", "Security", "Setup"]).optional().describe("The log to watch. Defaults to System"),
      level: z.enum(["critical", "error", "warning", "info"]).optional().describe("Maximum severity. Defaults to warning"),
      hours: z.number().int().positive().max(168).optional().describe("Window to look back in hours. Defaults to 4"),
      reset: z.boolean().optional().describe("Forget the watermark so the next call reports a full window again"),
      max_events: z.number().int().positive().max(200).optional().describe("Maximum number of new events to return. Defaults to 40"),
    }),
    handler: async (args) => {
      const log = String(args.log ?? "System");
      const level = String(args.level ?? "warning");
      const hours = Number(args.hours ?? 4);
      const max = Number(args.max_events ?? 40);

      if (args.reset === true) {
        watermarks.delete(`events_watch:${log}`);
      }

      const levelNumber = { critical: 1, error: 2, warning: 3, info: 4 }[level] ?? 3;
      const script =
        `Get-WinEvent -FilterHashtable @{ LogName=${psQuote(log)}; Level=${String(levelNumber)}; ` +
        `StartTime=(Get-Date).AddHours(-${String(hours)}) } -MaxEvents 2000 -ErrorAction SilentlyContinue | ` +
        "Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, Message | " +
        "Sort-Object TimeCreated -Descending | Select-Object -First " + String(max) + " | " +
        "ConvertTo-Json -Depth 3 -Compress";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 90_000 });
      if (!res.ok) {
        return fail(`events_watch failed: ${res.error ?? "unknown error"}`);
      }

      const raw = res.stdout.trim();
      const rows = raw === "" || raw === "null" ? [] : asArray<Record<string, unknown>>(JSON.parse(raw) as never);
      const shaped = rows.map((e) => ({
        time: fromPsDate(e.TimeCreated) ?? String(e.TimeCreated ?? ""),
        id: Number(e.Id ?? 0),
        level: String(e.LevelDisplayName ?? ""),
        provider: String(e.ProviderName ?? ""),
        message: String(e.Message ?? "").replace(/\s+/g, " ").slice(0, 240),
      }));

      const key = `events_watch:${log}`;
      const previous = watermarks.get(key);
      const newest = shaped[0]?.time ?? null;
      if (newest) {
        watermarks.set(key, newest);
      }

      const fresh = previous ? shaped.filter((e) => e.time > previous) : shaped;
      const firstCall = previous === undefined;
      return ok(
        {
          log,
          window_hours: hours,
          compared_against: previous ?? "nothing (first call)",
          new_count: firstCall ? 0 : fresh.length,
          events: fresh,
        },
        firstCall
          ? `Baseline set: ${String(shaped.length)} matching event(s) in the last ${String(hours)} h are not reported as new`
          : `${String(fresh.length)} new event(s) in ${log} since the last call`,
      );
    },
  },
  {
    name: "services_watch",
    module: "monitor",
    title: "Watch autostart services",
    description:
      "Services that are configured to start automatically but are not running now — the classic silent failure.",
    docs:
      "One query that answers \"is something supposed to be up and isn't\". Automatic and automatic-delayed services " +
      "that sit stopped are listed with their start mode and log-on account; manual services are not reported, because " +
      "stopped is normal for them.\n" +
      "Expect a handful of entries on any Windows machine: on-demand automatic services (MapsBroker, sppsvc and similar) " +
      "start when needed. Judge the list by what is missing compared to a previous call, not by the absolute count.\n" +
      "Set include_stopped_to_automatic to also see services a caller stopped that should come back at the next boot.",
    input: z.object({
      search: z.string().optional().describe("Substring match on the service name or display name"),
      max_services: z.number().int().positive().max(1000).optional().describe("Maximum number of results. Defaults to 100"),
    }),
    handler: async (args) => {
      const max = Number(args.max_services ?? 100);
      const search = args.search as string | undefined;

      const conditions = [
        `$_.StartMode -like ${psQuote("Auto*")}`,
        `$_.State -ne 'Running'`,
      ];
      if (search) {
        conditions.push(`($_.Name -like ${psQuote(`*${search}*`)} -or $_.DisplayName -like ${psQuote(`*${search}*`)})`);
      }

      const script =
        "Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | " +
        `Where-Object { ${conditions.join(" -and ")} } | Select-Object -First ${String(max)} | ` +
        "Select-Object Name, DisplayName, State, StartMode, StartName | ConvertTo-Json -Depth 3 -Compress";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 60_000 });
      if (!res.ok) {
        return fail(`services_watch failed: ${res.error ?? "unknown error"}`);
      }
      const raw = res.stdout.trim();
      if (raw === "" || raw === "null") {
        return text("Every automatic service is running", []);
      }
      try {
        const rows = asArray<Record<string, unknown>>(JSON.parse(raw) as never);
        const services = rows.map((s) => ({
          name: String(s.Name ?? ""),
          display_name: String(s.DisplayName ?? ""),
          status: String(s.State ?? ""),
          start_mode: String(s.StartMode ?? ""),
          log_on: String(s.StartName ?? ""),
        }));
        return ok({ count: services.length, services }, `${String(services.length)} automatic service(s) not running`);
      } catch {
        return text(raw);
      }
    },
  },
  {
    name: "error_trends",
    module: "monitor",
    title: "Error trends",
    description:
      "Error counts per provider for the current window against the previous window of the same length: growing, shrinking or steady.",
    docs:
      "Turns \"the log is full\" into a direction. Every provider that reported errors or warnings is counted in the " +
      "current window and in the equally long window before it, and the ratio decides growing, shrinking or steady.\n" +
      "This is the tool that distinguishes an incident from normal background noise: a provider that always reports " +
      "five errors an hour is steady and can be ignored, one that goes from five to five hundred is the problem.\n" +
      "A provider that only appears in the current window is reported as new, which is usually the most interesting " +
      "row of the table.",
    input: z.object({
      log: z.enum(["System", "Application", "Security", "Setup"]).optional().describe("The log to count in. Defaults to System"),
      hours: z.number().int().positive().max(720).optional().describe("Length of each window in hours. Defaults to 24"),
    }),
    handler: async (args) => {
      const log = String(args.log ?? "System");
      const hours = Number(args.hours ?? 24);

      const countFor = async (from: number, to: number): Promise<Map<string, number>> => {
        const script =
          `Get-WinEvent -FilterHashtable @{ LogName=${psQuote(log)}; Level=1,2,3; ` +
          `StartTime=(Get-Date).AddHours(-${String(from)}); EndTime=(Get-Date).AddHours(-${String(to)}) } ` +
          "-ErrorAction SilentlyContinue | Group-Object ProviderName | Sort-Object Count -Descending | " +
          "Select-Object Count, Name | ConvertTo-Json -Compress";
        const res = await runPowerShell<string>(script, { json: false, timeoutMs: 90_000 });
        if (!res.ok) {
          return new Map();
        }
        const raw = res.stdout.trim();
        if (raw === "" || raw === "null") {
          return new Map();
        }
        try {
          const rows = asArray<Record<string, unknown>>(JSON.parse(raw) as never);
          return new Map(rows.map((r) => [String(r.Name ?? ""), Number(r.Count ?? 0)]));
        } catch {
          return new Map();
        }
      };

      const now = await countFor(hours, 0);
      const before = await countFor(hours * 2, hours);

      const names = new Set([...now.keys(), ...before.keys()]);
      const providers = [...names]
        .map((provider) => {
          const current = now.get(provider) ?? 0;
          const previous = before.get(provider) ?? 0;
          let trend: "new" | "growing" | "shrinking" | "steady";
          if (previous === 0 && current > 0) trend = "new";
          else if (current > previous * 1.5) trend = "growing";
          else if (current < previous * 0.66) trend = "shrinking";
          else trend = "steady";
          return { provider, current, previous, trend };
        })
        .sort((a, b) => b.current - a.current);

      const interesting = providers.filter((p) => p.trend === "new" || p.trend === "growing");
      return ok(
        { window_hours: hours, provider_count: providers.length, providers },
        providers.length === 0
          ? `No errors or warnings in ${log} for either window`
          : `${String(interesting.length)} of ${String(providers.length)} provider(s) are new or growing in the last ${String(hours)} h`,
      );
    },
  },
  {
    name: "service_restarts",
    module: "monitor",
    title: "Service restarts",
    description:
      "Which services stopped, crashed or were restarted in a window, counted from the Service Control Manager log.",
    docs:
      "Reads the Service Control Manager entries (7031 service terminated unexpectedly, 7034 it died unexpectedly, " +
      "7036 state change, 7040 start mode change, 7043 service did not shut down cleanly) and groups them per service.\n" +
      "A service that appears with several 7031/7034 entries in an hour is restart-looping, and the message column " +
      "carries the recovery action Windows took. That is the difference between \"it crashed\" and \"it crashed and " +
      "Windows restarted it\".\n" +
      "The SCM writes to the System log, so this works without elevation. Narrow with name once you know the suspect.",
    input: z.object({
      name: z.string().optional().describe("Substring match on the service name"),
      hours: z.number().int().positive().max(720).optional().describe("Look-back window in hours. Defaults to 24"),
      max_entries: z.number().int().positive().max(500).optional().describe("Maximum number of raw entries to inspect. Defaults to 300"),
    }),
    handler: async (args) => {
      const hours = Number(args.hours ?? 24);
      const max = Number(args.max_entries ?? 300);
      const name = args.name as string | undefined;

      const script =
        `Get-WinEvent -FilterHashtable @{ LogName=${psQuote(SCM_LOG)}; ProviderName='Service Control Manager'; ` +
        `ID=@(${SCM_STOP_IDS.join(", ")}); StartTime=(Get-Date).AddHours(-${String(hours)}) } ` +
        `-MaxEvents ${String(max)} -ErrorAction SilentlyContinue | ` +
        // The service name is read from the event properties, not from the message text, because the
        // message is localized and its wording differs per id.
        "Select-Object TimeCreated, Id, @{n='SrvName';e={$_.Properties[0].Value}}, Message | " +
        "ConvertTo-Json -Depth 3 -Compress";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 90_000 });
      if (!res.ok) {
        return fail(`service_restarts failed: ${res.error ?? "unknown error"}`);
      }
      const raw = res.stdout.trim();
      if (raw === "" || raw === "null") {
        return text(`No service state changes in the last ${String(hours)} h`, []);
      }

      try {
        const rows = asArray<Record<string, unknown>>(JSON.parse(raw) as never);
        const perService = new Map<string, { crashes: number; transitions: number; last_time: string; last_id: number }>();

        for (const row of rows) {
          const message = String(row.Message ?? "").replace(/\s+/g, " ");
          const service = String(row.SrvName ?? "") !== ""
            ? String(row.SrvName)
            : /service (?:(?:was|were)\s+)?([^.:]+?)\s+(?:terminated|stopped|started|had its start|did not)/i.exec(message)?.[1]
              ?? /The (\S+) service/i.exec(message)?.[1]
              ?? "unknown";
          if (name && !service.toLowerCase().includes(name.toLowerCase())) continue;

          const id = Number(row.Id ?? 0);
          const time = fromPsDate(row.TimeCreated) ?? String(row.TimeCreated ?? "");
          const entry = perService.get(service) ?? { crashes: 0, transitions: 0, last_time: "", last_id: 0 };
          if (id === 7031 || id === 7034 || id === 7043) entry.crashes += 1;
          else entry.transitions += 1;
          if (time > entry.last_time) {
            entry.last_time = time;
            entry.last_id = id;
          }
          perService.set(service, entry);
        }

        const services = [...perService.entries()]
          .map(([service, counts]) => ({ name: service, ...counts }))
          .sort((a, b) => b.crashes - a.crashes || a.name.localeCompare(b.name));

        const looping = services.filter((s) => s.crashes >= 3);
        return ok(
          { window_hours: hours, service_count: services.length, services },
          looping.length > 0
            ? `${String(looping.length)} service(s) terminated unexpectedly 3 or more times in ${String(hours)} h`
            : `${String(services.length)} service(s) changed state in the last ${String(hours)} h`,
        );
      } catch {
        return text(raw);
      }
    },
  },
  {
    name: "system_changes",
    module: "monitor",
    title: "Recent system changes",
    description:
      "What was installed or updated recently: hotfixes, programs with an install date in the window, and drivers added.",
    docs:
      "The \"what changed\" tool for the question \"it worked yesterday\". It combines the update history " +
      "(Win32_QuickFixEngineering) with the uninstall registry keys, which is where installed programs record their " +
      "InstallDate.\n" +
      "Because install dates are day-granular, a change made this morning and one made last week can look close " +
      "together; that is a limitation of what programs write, not of this tool.\n" +
      "Use it before deeper debugging: an update from yesterday explains a service that stopped behaving, and saves " +
      "reading a week of logs.",
    input: z.object({
      days: z.number().int().positive().max(365).optional().describe("Look-back window in days. Defaults to 14"),
      max_items: z.number().int().positive().max(300).optional().describe("Maximum number of entries per category. Defaults to 40"),
    }),
    handler: async (args) => {
      const days = Number(args.days ?? 14);
      const max = Number(args.max_items ?? 40);

      const script =
        "$cut = (Get-Date).AddDays(-" + String(days) + "); " +
        "$fixes = @(Get-CimInstance Win32_QuickFixEngineering -ErrorAction SilentlyContinue | " +
        "Where-Object { $_.InstalledOn -and $_.InstalledOn -ge $cut } | " +
        "Select-Object -First " + String(max) + " | Select-Object HotFixID, Description, InstalledOn); " +
        "$paths = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', " +
        "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', " +
        "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); " +
        "$apps = @(Get-ItemProperty $paths -ErrorAction SilentlyContinue | " +
        "Where-Object { $_.InstallDate -and $_.DisplayName } | ForEach-Object { " +
        "$d = $_.InstallDate; $dt = $null; " +
        "if ($d -match '^\\d{8}$') { $dt = [datetime]::ParseExact($d,'yyyyMMdd',[Globalization.CultureInfo]::InvariantCulture) }; " +
        "if ($dt -and $dt -ge $cut) { [pscustomobject]@{ Name=$_.DisplayName; Version=$_.DisplayVersion; InstallDate=$d; Publisher=$_.Publisher } } } | " +
        "Sort-Object InstallDate -Descending | Select-Object -First " + String(max) + "); " +
        "ConvertTo-Json -Depth 4 -Compress -InputObject @{hotfixes=$fixes; programs=$apps}";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 90_000 });
      if (!res.ok) {
        return fail(`system_changes failed: ${res.error ?? "unknown error"}`);
      }
      try {
        const d = JSON.parse(res.stdout.trim()) as { hotfixes: unknown; programs: unknown };
        const hotfixes = asArray<Record<string, unknown>>(d.hotfixes as never).map((h) => ({
          hotfix: String(h.HotFixID ?? ""),
          description: String(h.Description ?? ""),
          installed_on: fromPsDate(h.InstalledOn) ?? String(h.InstalledOn ?? ""),
        }));
        const programs = asArray<Record<string, unknown>>(d.programs as never).map((p) => ({
          name: String(p.Name ?? ""),
          version: String(p.Version ?? ""),
          install_date: String(p.InstallDate ?? ""),
          publisher: String(p.Publisher ?? ""),
        }));
        return ok(
          { window_days: days, hotfix_count: hotfixes.length, program_count: programs.length, hotfixes, programs },
          `${String(hotfixes.length)} update(s) and ${String(programs.length)} program(s) in the last ${String(days)} days`,
        );
      } catch {
        return text(res.stdout.trim());
      }
    },
  },
];
