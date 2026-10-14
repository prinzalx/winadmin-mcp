import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ToolDefinition } from "../../types.js";
import { fail, ok, text } from "../../utils/result.js";
import { asArray, fromPsDate, psQuote, runPowerShell } from "../../utils/powershell.js";

/** Reads a registry value and returns it as a string, or `null` when it is absent. */
async function readRegistryValue(key: string, name: string): Promise<string | null> {
  const res = await runPowerShell<string>(
    `(Get-ItemProperty -Path ${psQuote(key)} -Name ${psQuote(name)} -ErrorAction SilentlyContinue).${name}`,
    { json: false },
  );
  const raw = res.stdout.trim();
  return res.ok && raw !== "" ? raw : null;
}

export const diagnosticTools: ToolDefinition[] = [
  {
    name: "system_health",
    module: "diagnostics",
    title: "System health",
    description:
      "One-shot health snapshot: uptime, CPU load, memory, the System drives and the count of errors in the last 24 hours.",
    input: z.object({}),
    handler: async () => {
      const script =
        "$os = Get-CimInstance Win32_OperatingSystem; " +
        "$cs = Get-CimInstance Win32_ComputerSystem; " +
        "$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; " +
        "$errors = (Get-WinEvent -FilterHashtable @{ LogName='System'; Level=2; StartTime=(Get-Date).AddHours(-24) } -ErrorAction SilentlyContinue | Measure-Object).Count; " +
        "$disk = Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | Select-Object DeviceID, Size, FreeSpace; " +
        "ConvertTo-Json -Depth 3 -Compress -InputObject @{" +
        "computername=$os.CSName; os=$os.Caption; version=$os.Version; build=$os.BuildNumber;" +
        "uptime_hours=[math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours,1);" +
        "last_boot=$os.LastBootUpTime; cpu_load_pct=$cpu;" +
        "total_gb=[math]::Round($os.TotalVisibleMemorySize/1MB,1);" +
        "free_gb=[math]::Round($os.FreePhysicalMemory/1MB,1);" +
        "users=$cs.NumberOfUsers; disks=$disk; error_count_24h=$errors}";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 45_000 });
      if (!res.ok) {
        return fail(`system_health failed: ${res.error ?? "unknown error"}`);
      }

      try {
        const d = JSON.parse(res.stdout.trim()) as {
          computername: string;
          os: string;
          version: string;
          build: string;
          uptime_hours: number;
          last_boot: string;
          cpu_load_pct: number | null;
          total_gb: number;
          free_gb: number;
          users: number;
          disks: Array<{ DeviceID: string; Size: number; FreeSpace: number }>;
          error_count_24h: number;
        };

        const drives = asArray(d.disks as never as Record<string, number | string>[]);
        const usedPct = d.total_gb > 0 ? Math.round(((d.total_gb - d.free_gb) / d.total_gb) * 100) : 0;
        const warnings: string[] = [];
        if (d.error_count_24h > 0) {
          warnings.push(`${String(d.error_count_24h)} System error(s) in the last 24 h`);
        }
        if (usedPct > 90) {
          warnings.push(`Memory pressure at ${String(usedPct)}%`);
        }
        if ((d.cpu_load_pct ?? 0) > 85) {
          warnings.push(`CPU load at ${String(d.cpu_load_pct)}%`);
        }

        return ok({
          computer_name: d.computername,
          os: `${d.os} (build ${d.build})`,
          uptime_hours: d.uptime_hours,
          last_boot: fromPsDate(d.last_boot) ?? d.last_boot,
          cpu_load_pct: d.cpu_load_pct,
          memory: { total_gb: d.total_gb, free_gb: d.free_gb, used_pct: usedPct },
          logged_in_users: d.users,
          drives: drives.map((x) => ({
            drive: String(x.DeviceID ?? ""),
            total_gb: Number((Number(x.Size) / 1024 ** 3).toFixed(0)),
            free_gb: Number((Number(x.FreeSpace) / 1024 ** 3).toFixed(1)),
          })),
          errors_last_24h: d.error_count_24h,
          warnings,
        });
      } catch {
        return text(res.stdout.trim());
      }
    },
  },
  {
    name: "diagnose_service",
    module: "diagnostics",
    title: "Diagnose service",
    description:
      "Deep check on one service: state, start mode, its process, dependencies and the recent log entries that mention it.",
    input: z.object({
      name: z.string().min(1).describe("The exact service name"),
    }),
    handler: async (args) => {
      const name = String(args.name);

      const script =
        `$svc = Get-CimInstance Win32_Service -Filter "Name = ${psQuote(name)}"; ` +
        "if (-not $svc) { Write-Output 'notfound'; exit }; " +
        "$deps = @(Get-CimInstance Win32_DependentService -Filter \"Antecedent=$($svc.Path)\" -ErrorAction SilentlyContinue); " +
        "$logs = @(Get-WinEvent -FilterHashtable @{ LogName='System'; StartTime=(Get-Date).AddDays(-2) } -ErrorAction SilentlyContinue | " +
        `Where-Object { $_.Message -like ('*' + $svc.Name + '*') -or $_.ProviderName -like ('*' + $svc.Name + '*') } | ` +
        "Select-Object -First 10 | Select-Object TimeCreated, Id, LevelDisplayName, Message); " +
        "ConvertTo-Json -Depth 4 -Compress -InputObject @{name=$svc.Name; display=$svc.DisplayName; status=$svc.State;" +
        "startmode=$svc.StartMode; account=$svc.StartName; pid=$svc.ProcessId; deps=$deps; logs=$logs}";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 60_000 });
      if (!res.ok) {
        return fail(`diagnose_service failed: ${res.error ?? "unknown error"}`);
      }

      const raw = res.stdout.trim();
      if (raw.toLowerCase() === "notfound") {
        return fail(`Service "${name}" not found`);
      }

      try {
        const d = JSON.parse(raw) as {
          name: string;
          display: string;
          status: string;
          startmode: string;
          account: string;
          pid: number;
          deps: Array<{ Name: string; State: string }>;
          logs: Array<{ TimeCreated: string; Id: number; LevelDisplayName: string; Message: string }>;
        };

        const problems: string[] = [];
        if (d.status !== "Running") {
          problems.push(`Service is ${d.status}, not Running`);
        }
        if (d.startmode === "Disabled") {
          problems.push("Start mode is Disabled");
        }
        const deps = asArray(d.deps as never as Array<{ Name: string; State: string }>);
        const stoppedDeps = deps.filter((x) => x.State !== "Running");
        if (stoppedDeps.length > 0) {
          problems.push(`${String(stoppedDeps.length)} dependent service(s) not running`);
        }
        const logs = asArray(d.logs as never as Array<{
          TimeCreated: string;
          Id: number;
          LevelDisplayName: string;
          Message: string;
        }>);
        const errors = logs.filter((l) => /error|critical/i.test(l.LevelDisplayName));
        if (errors.length > 0) {
          problems.push(`${String(errors.length)} error entry(ies) in the System log in the last 2 days`);
        }

        return ok({
          name: d.name,
          display_name: d.display,
          status: d.status,
          start_mode: d.startmode,
          account: d.account,
          pid: d.pid || null,
          dependents: deps.map((x) => ({ name: String(x.Name ?? ""), status: String(x.State ?? "") })),
          recent_log: logs.slice(0, 5).map((l) => ({
            time: l.TimeCreated,
            id: l.Id,
            level: l.LevelDisplayName,
            message: String(l.Message ?? "").replace(/\s+/g, " ").slice(0, 240),
          })),
          assessment: problems.length > 0 ? problems : ["No problems detected"],
        });
      } catch {
        return text(raw);
      }
    },
  },
  {
    name: "get_windows_update",
    module: "diagnostics",
    title: "Windows Update state",
    description:
      "Read the Windows Update state from the registry plus the most recent install results. Read-only.",
    input: z.object({
      count: z.number().int().positive().max(20).optional().describe("How many recent history entries to return. Defaults to 5"),
    }),
    handler: async (args) => {
      const count = Number(args.count ?? 5);

      const resultsKey =
        "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\Results";

      const [installed, searched] = await Promise.all([
        readRegistryValue(resultsKey, "LastInstallationSuccessTime"),
        readRegistryValue(resultsKey, "LastSearchSuccessTime"),
      ]);

      return ok(
        {
          last_installation_success: installed ?? "unknown",
          last_search_success: searched ?? "unknown",
          note:
            "The full update history needs the Windows Update COM API; this tool reports the registry state.",
        },
        installed
          ? `Last successful update install: ${installed}`
          : "No Windows Update result found in the registry",
      );
    },
  },
];
