import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ToolDefinition } from "../../types.js";
import { asArray, eventLevel, fromPsDate, psQuote, runPowerShell } from "../../utils/powershell.js";
import { fail, ok, text } from "../../utils/result.js";

/** The log the Task Scheduler writes its run history to. Enabled by default since Windows 8. */
const TASK_LOG = "Microsoft-Windows-TaskScheduler/Operational";

const nameField = z.string().min(1).describe("The task name, without the folder");
const pathField = z
  .string()
  .optional()
  .describe("The task folder, e.g. \\Microsoft\\Windows\\DiskDiagnostic\\. Defaults to the root folder");
const confirmationField = z
  .string()
  .optional()
  .describe("Set only when confirming a parked action; omit for a direct call");

/**
 * The `Where-Object` body that matches a task by name and, when given, by folder. Task Scheduler
 * addresses a task by both, so the folder is part of the identity, not decoration.
 */
function taskPredicate(name: string, path?: string): string {
  if (!path) {
    return `$_.TaskName -eq ${psQuote(name)}`;
  }
  const folder = path.endsWith("\\") ? path : `${path}\\`;
  return `$_.TaskName -eq ${psQuote(name)} -and $_.TaskPath -eq ${psQuote(folder)}`;
}

async function runTaskVerb(
  verb: "Start" | "Enable" | "Disable",
  name: string,
  path?: string,
): Promise<CallToolResult> {
  const script =
    `$t = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { ${taskPredicate(name, path)} }); ` +
    "if ($t.Count -eq 0) { Write-Output 'notfound'; exit }; " +
    `${verb}-ScheduledTask -TaskName $t[0].TaskName -TaskPath $t[0].TaskPath | Out-Null; ` +
    "$t = Get-ScheduledTask -TaskName $t[0].TaskName -TaskPath $t[0].TaskPath; " +
    "ConvertTo-Json -Compress -InputObject @{name=$t.TaskName; path=$t.TaskPath; state=[string]$t.State}";

  const res = await runPowerShell<string>(script, { json: false, timeoutMs: 60_000 });
  if (!res.ok) {
    return fail(`${verb}-ScheduledTask failed: ${res.error ?? "unknown error"}`);
  }
  const raw = res.stdout.trim();
  if (raw.toLowerCase() === "notfound") {
    return fail(`Scheduled task "${name}" not found`);
  }
  try {
    const d = JSON.parse(raw) as { name: string; path: string; state: string };
    return text(`${name} is now ${d.state}`, { name: d.name, path: d.path, state: d.state });
  } catch {
    return text(raw);
  }
}

export const schedulerTools: ToolDefinition[] = [
  {
    name: "list_tasks",
    module: "scheduler",
    title: "List scheduled tasks",
    description:
      "List scheduled tasks with state and run info, filtered by name substring, folder or state.",
    docs:
      "Reads the Task Scheduler store and returns name, folder, state plus — for a task that ran at least " +
      "once — the last run time, the last result code and the next run time.\n" +
      "Use it to answer whether a maintenance job ran at all. Result code 0 means success, 0x41303 means " +
      "the task is still running and 0x41306 means it was aborted.\n" +
      "The name filter matches anywhere in the name, so \"update\" finds every update job. The result list " +
      "is capped by max_tasks because a normal Windows install has a few hundred tasks.",
    input: z.object({
      name: z.string().optional().describe("Substring match on the task name"),
      path: z
        .string()
        .optional()
        .describe("Substring match on the task folder, e.g. \\Microsoft\\Windows\\UpdateOrchestrator\\"),
      state: z
        .enum(["Running", "Ready", "Disabled", "Queued", "Unknown"])
        .optional()
        .describe("Exact state filter"),
      max_tasks: z.number().int().positive().max(2000).optional().describe("Maximum number of tasks. Defaults to 200"),
    }),
    handler: async (args) => {
      const max = Number(args.max_tasks ?? 200);
      const conditions: string[] = [];
      if (args.name) conditions.push(`$_.TaskName -like ${psQuote(`*${String(args.name)}*`)}`);
      if (args.path) conditions.push(`$_.TaskPath -like ${psQuote(`*${String(args.path)}*`)}`);
      if (args.state) conditions.push(`$_.State -eq ${psQuote(String(args.state))}`);

      const script =
        "$out = @(); " +
        "Get-ScheduledTask -ErrorAction SilentlyContinue" +
        (conditions.length > 0 ? ` | Where-Object { ${conditions.join(" -and ")} }` : "") +
        " | ForEach-Object { " +
        "$i = $_ | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue; " +
        "$out += [pscustomobject]@{ TaskName=$_.TaskName; TaskPath=$_.TaskPath; State=[string]$_.State; " +
        "LastRunTime=$i.LastRunTime; LastTaskResult=$i.LastTaskResult; NextRunTime=$i.NextRunTime }; " +
        "if ($out.Count -ge " + String(max) + ") { break } }; " +
        "ConvertTo-Json -Depth 3 -Compress -InputObject $out";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 90_000 });
      if (!res.ok) {
        return fail(`list_tasks failed: ${res.error ?? "unknown error"}`);
      }

      const raw = res.stdout.trim();
      if (raw === "" || raw === "null") {
        return text("No scheduled tasks match the filter", []);
      }
      try {
        const rows = asArray<Record<string, unknown>>(JSON.parse(raw) as never);
        const tasks = rows.map((t) => ({
          name: String(t.TaskName ?? ""),
          path: String(t.TaskPath ?? ""),
          state: String(t.State ?? ""),
          last_run: fromPsDate(t.LastRunTime),
          last_result: t.LastTaskResult === undefined ? null : Number(t.LastTaskResult),
          next_run: fromPsDate(t.NextRunTime),
        }));
        return ok({ count: tasks.length, tasks }, `${String(tasks.length)} scheduled task(s) match the filter`);
      } catch {
        return text(raw);
      }
    },
  },
  {
    name: "get_task",
    module: "scheduler",
    title: "Get scheduled task",
    description:
      "Full definition of one task: schedule, action command, account, settings and the last run result.",
    docs:
      "The deep check for a single task. Answers \"what exactly does this task run, who owns it and how did it " +
      "end last time\" without opening taskschd.msc.\n" +
      "Account and logon type matter for failures: a task set to run whether the user is logged on or not, " +
      "without a stored password, runs non-interactive and cannot map a network drive or show a window.\n" +
      "Fails when the task does not exist — use list_tasks first if you only know part of the name.",
    input: z.object({ name: nameField, path: pathField }),
    handler: async (args) => {
      const name = String(args.name);
      const path = args.path as string | undefined;

      const script =
        `$t = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { ${taskPredicate(name, path)} })[0]; ` +
        "if (-not $t) { Write-Output 'notfound'; exit }; " +
        "$i = $t | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue; " +
        "ConvertTo-Json -Depth 6 -Compress -InputObject @{name=$t.TaskName; path=$t.TaskPath; state=[string]$t.State;" +
        "author=$t.Author; date=$t.Date; description=$t.Description;" +
        "user=$t.Principal.UserId; logon=$t.Principal.LogonType; runlevel=$t.Principal.RunLevel;" +
        "actions=@($t.Actions | Select-Object Execute, Arguments, WorkingDirectory);" +
        "triggers=@($t.Triggers | Select-Object CimClass, Enabled, StartBoundary, Repetition);" +
        "settings=@{hidden=$t.Settings.Hidden; multiple=$t.Settings.MultipleInstances;" +
        "disallow_on_battery=$t.Settings.DisallowStartIfOnBatteries; time_limit=$t.Settings.ExecutionTimeLimit;" +
        "restart_count=$t.Settings.RestartCount; start_when_available=$t.Settings.StartWhenAvailable};" +
        "last_run=$i.LastRunTime; last_result=$i.LastTaskResult; next_run=$i.NextRunTime;" +
        "run_count=$i.NumberOfExecutions}";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 60_000 });
      if (!res.ok) {
        return fail(`get_task failed: ${res.error ?? "unknown error"}`);
      }
      const raw = res.stdout.trim();
      if (raw.toLowerCase() === "notfound") {
        return fail(`Scheduled task "${name}" not found`);
      }
      try {
        const d = JSON.parse(raw) as Record<string, unknown>;
        return ok({
          name: d.name,
          path: d.path,
          state: d.state,
          description: d.description ?? "",
          author: d.author ?? null,
          account: d.user ?? null,
          logon_type: d.logon ?? null,
          run_level: d.runlevel ?? null,
          actions: asArray<Record<string, unknown>>(d.actions as never).map((a) => ({
            execute: String(a.Execute ?? ""),
            arguments: String(a.Arguments ?? ""),
            working_directory: String(a.WorkingDirectory ?? ""),
          })),
          triggers: asArray<Record<string, unknown>>(d.triggers as never).map((t) => ({
            enabled: t.Enabled !== false,
            start: t.StartBoundary ?? null,
            type: String((t.CimClass as { CimClassName?: string } | undefined)?.CimClassName ?? "unknown"),
          })),
          settings: d.settings ?? null,
          last_run: fromPsDate(d.last_run),
          last_result: d.last_result === undefined ? null : Number(d.last_result),
          next_run: fromPsDate(d.next_run),
          run_count: Number(d.run_count ?? 0) || null,
        });
      } catch {
        return text(raw);
      }
    },
  },
  {
    name: "run_task",
    module: "scheduler",
    title: "Run scheduled task",
    description: "Start a scheduled task right now instead of waiting for its trigger.",
    docs:
      "Starts the task and answers immediately, so the task usually is still running when this returns. Call " +
      "get_task afterwards for the state and the result code.\n" +
      "A task that is already running is not started a second time; the task's own \"multiple instances\" policy " +
      "decides what happens, and get_task reports it as settings.multiple.",
    input: z.object({ name: nameField, path: pathField, confirmation_id: confirmationField }),
    destructive: true,
    handler: (args) => runTaskVerb("Start", String(args.name), args.path as string | undefined),
  },
  {
    name: "enable_task",
    module: "scheduler",
    title: "Enable scheduled task",
    description: "Enable a disabled scheduled task so its triggers fire again.",
    docs:
      "A disabled task keeps its schedule but never fires. This is the reversible way to switch a job back on; " +
      "only deleting a task is irreversible.\n" +
      "Needs the same rights as the Task Scheduler UI, so an unprivileged server process may fail on tasks that " +
      "belong to another account.",
    input: z.object({ name: nameField, path: pathField, confirmation_id: confirmationField }),
    destructive: true,
    handler: (args) => runTaskVerb("Enable", String(args.name), args.path as string | undefined),
  },
  {
    name: "disable_task",
    module: "scheduler",
    title: "Disable scheduled task",
    description: "Disable a scheduled task without deleting it.",
    docs:
      "Preferred over deleting when you want to find out whether a task causes a problem: a disabled task can be " +
      "switched back on with one call.\n" +
      "The answer reports the state after the change, so a task that a group policy re-enables right away is still " +
      "visible as enabled in the result.",
    input: z.object({ name: nameField, path: pathField, confirmation_id: confirmationField }),
    destructive: true,
    handler: (args) => runTaskVerb("Disable", String(args.name), args.path as string | undefined),
  },
  {
    name: "task_history",
    module: "scheduler",
    title: "Scheduled task history",
    description:
      "Recent Task Scheduler log entries for one task: launches, completions with their result code, failures.",
    docs:
      "Reads the Microsoft-Windows-TaskScheduler/Operational log, which holds the run history of every task. " +
      "Event 100 is \"Action started\", 102 is \"Action completed\", 103 reports the result code and 200 is " +
      "\"Action encountered an error\".\n" +
      "The task is matched on the structured TaskName/TaskPath event properties, so the answer does not depend on " +
      "the language of the log messages.\n" +
      "The log is size-limited and rolls over, so on a busy machine it goes back only a few days. An empty answer " +
      "can also mean the operational log is switched off, which is the default unless it was enabled in Event " +
      "Viewer; query_events with that log name tells you which.",
    input: z.object({
      name: nameField,
      hours: z.number().int().positive().max(720).optional().describe("Look-back window in hours. Defaults to 72"),
      max_events: z.number().int().positive().max(200).optional().describe("Maximum number of entries. Defaults to 30"),
    }),
    handler: async (args) => {
      const name = String(args.name);
      const hours = Number(args.hours ?? 72);
      const max = Number(args.max_events ?? 30);

      // Matching on $_.Message alone breaks on a localized system, because the task name appears in the
      // message text only for some event ids. The properties carry it for every event of the provider,
      // with the trailing backslash that the provider appends, so the wildcard match strips it.
      const script =
        `$name = ${psQuote(name)}; ` +
        `Get-WinEvent -FilterHashtable @{ LogName=${psQuote(TASK_LOG)}; ` +
        `StartTime=(Get-Date).AddHours(-${String(hours)}) } -MaxEvents ${String(max * 20)} -ErrorAction SilentlyContinue | ` +
        `Where-Object { ($_.Properties | Where-Object { ([string]$_.Value).TrimEnd('\') -like ('*' + $name) }) -or ` +
        `($_.Message -like ('*' + $name + '*')) } | ` +
        `Select-Object -First ${String(max)} | ` +
        "Select-Object TimeCreated, Id, Level, LevelDisplayName, Message | ConvertTo-Json -Depth 3 -Compress";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 90_000 });
      if (!res.ok) {
        return fail(`task_history failed: ${res.error ?? "unknown error"}`);
      }
      const raw = res.stdout.trim();
      if (raw === "" || raw === "null") {
        return text(`No Task Scheduler entries mentioning "${name}" in the last ${String(hours)} h`, []);
      }
      try {
        const rows = asArray<Record<string, unknown>>(JSON.parse(raw) as never);
        const entries = rows.map((e) => ({
          time: fromPsDate(e.TimeCreated) ?? String(e.TimeCreated ?? ""),
          id: Number(e.Id ?? 0),
          level: eventLevel(e.Level, e.LevelDisplayName),
          message: String(e.Message ?? "").replace(/\s+/g, " ").slice(0, 240),
        }));
        return ok({ count: entries.length, entries }, `${String(entries.length)} task history entry(ies)`);
      } catch {
        return text(raw);
      }
    },
  },
];
