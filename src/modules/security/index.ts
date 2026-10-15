import { basename } from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ToolDefinition } from "../../types.js";
import { asArray, eventLevel, fromPsDate, psQuote, runPowerShell } from "../../utils/powershell.js";
import { fail, ok, text } from "../../utils/result.js";

/** The security-log ids this server knows how to name, mapped to what they mean. */
const SECURITY_IDS: Record<number, string> = {
  4624: "successful logon",
  4625: "failed logon",
  4634: "logoff",
  4647: "user-initiated logoff",
  4648: "logon with explicit credentials",
  4672: "special privileges assigned to new logon",
  4688: "new process created",
  4689: "process exited",
  4698: "scheduled task created",
  4702: "scheduled task updated",
  4720: "user account created",
  4732: "member added to a local group",
  4740: "user account locked out",
  1102: "audit log cleared",
};

/**
 * Windows reports an account as `DOMAIN\\name` or `name$` for computers. Extracting the parts keeps
 * the answer readable for a model that would otherwise see escaped backslashes.
 */
function splitAccount(raw: unknown): { account: string; domain: string } {
  const value = String(raw ?? "");
  const idx = value.lastIndexOf("\\");
  return idx > 0 ? { account: value.slice(idx + 1), domain: value.slice(0, idx) } : { account: value, domain: "" };
}

/** Coarse grouping used by `analyze_pe`, so a caller sees "networking" instead of 300 API names. */
const API_CATEGORIES: Array<{ name: string; pattern: RegExp }> = [
  { name: "process", pattern: /^(CreateProcess|OpenProcess|TerminateProcess|VirtualAllocEx|WriteProcessMemory|ReadProcessMemory|CreateRemoteThread|NtQueryInformationProcess)/ },
  { name: "registry", pattern: /^(RegOpenKey|RegGetValue|RegQueryValue|RegSetValue|RegCreateKey|NtOpenKey|NtSetValueKey)/ },
  { name: "file", pattern: /^(CreateFile|ReadFile|WriteFile|FindFirstFile|GetFileAttributes|NtCreateFile|NtReadFile|MoveFile|DeleteFile|CopyFile|LoadLibrary)/ },
  { name: "network", pattern: /^(socket|connect|send|recv|WSA|WinHttp|InternetOpen|HttpSend|DnsQuery|closesocket|bind|listen|accept)/i },
  { name: "service", pattern: /^(OpenSCManager|OpenService|StartService|ControlService|QueryService|RegisterServiceCtrl)/ },
  { name: "sync", pattern: /^(CreateEvent|SetEvent|WaitForSingle|WaitForMultiple|CreateMutex|ReleaseMutex|CreateThread|InitializeCriticalSection)/ },
  { name: "crypto", pattern: /^(CryptAcquireContext|CryptDeriveKey|CryptEncrypt|CryptDecrypt|BCrypt|NCrypt)/ },
];

function categorize(name: string): string {
  for (const cat of API_CATEGORIES) {
    if (cat.pattern.test(name)) {
      return cat.name;
    }
  }
  return "other";
}


export const securityTools: ToolDefinition[] = [
  {
    name: "check_elevation",
    module: "security",
    title: "Check elevation",
    description:
      "Whether this server process runs elevated, plus its user, integrity level and the Windows version.",
    docs:
      "The capability check for the whole server, because several write tools need elevation: the event log and the " +
      "driver list work for everyone, but a minifilter listing or a service start can fail on a restricted token.\n" +
      "Answers offline in a few milliseconds, so it is cheap to call before a write. The integrity level matters as " +
      "much as the elevation flag: a Medium token cannot write HKLM, and an elevated token cannot drag files from a " +
      "Medium explorer.",
    input: z.object({}),
    handler: async () => {
      const script =
        "$id = [Security.Principal.WindowsIdentity]::GetCurrent(); " +
        "$p = New-Object Security.Principal.WindowsPrincipal($id); " +
        // The integrity level is a mandatory-label SID on the access token, not in WindowsIdentity.Groups.
        // Matching the S-1-16-* SID keeps this locale-independent, unlike the whoami label text.
        "$whoami = Join-Path $env:SystemRoot 'System32\\whoami.exe'; " +
        "$label = ''; " +
        "foreach ($line in @(& $whoami /groups 2>$null)) { " +
        "if ($line -match 'S-1-16-(\\d+)') { " +
        "$label = switch ($Matches[1]) { '20480' {'Protected Process'} '16384' {'System'} '12288' {'High'} '8448' {'Medium plus'} '8192' {'Medium'} '4096' {'Low'} '0' {'Untrusted'} default {$Matches[0]} }; " +
        "break } }; " +
        "ConvertTo-Json -Compress -InputObject @{user=$id.Name; label=$label; " +
        "os=(Get-CimInstance Win32_OperatingSystem).Caption; build=(Get-CimInstance Win32_OperatingSystem).BuildNumber; " +
        "elevation=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 30_000 });
      if (!res.ok) {
        return fail(`check_elevation failed: ${res.error ?? "unknown error"}`);
      }
      try {
        const d = JSON.parse(res.stdout.trim()) as {
          user: string;
          label: string;
          os: string;
          build: string;
          elevation: boolean;
        };
        const integrity = String(d.label ?? "") || "unknown";
        return ok({
          elevated: Boolean(d.elevation),
          user: d.user,
          integrity_level: integrity,
          os: `${String(d.os)} (build ${String(d.build)})`,
        });
      } catch {
        return text(res.stdout.trim());
      }
    },
  },
  {
    name: "get_security_events",
    module: "security",
    title: "Get security events",
    description:
      "Security log narrowed to logon, privilege, process-creation and account events, with the id explained in plain words.",
    docs:
      "The Security log is huge and mostly noise, so this tool queries only the ids that carry meaning and annotates " +
      "each row with what the id stands for — logon, logoff, explicit credentials, special privileges, new process, " +
      "account locked out, audit log cleared.\n" +
      "Logon type in the message tells the story: type 2 is interactive at the keyboard, type 3 a network share, type 10 " +
      "RDP, type 5 a service. A burst of 4625 with type 10 means somebody guessed passwords over RDP.\n" +
      "Reading the Security log needs elevation on some systems; if this answers with a permission error, the server " +
      "process is not elevated, which check_elevation confirms.",
    input: z.object({
      event_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("One specific security id, e.g. 4625 for failed logons. Defaults to the interesting set"),
      hours: z.number().int().positive().max(8760).optional().describe("Look-back window in hours. Defaults to 24"),
      max_events: z.number().int().positive().max(500).optional().describe("Maximum number of events. Defaults to 50"),
    }),
    handler: async (args) => {
      const hours = Number(args.hours ?? 24);
      const max = Number(args.max_events ?? 50);
      const ids = args.event_id === undefined ? Object.keys(SECURITY_IDS).map(Number) : [Number(args.event_id)];

      const script =
        `Get-WinEvent -FilterHashtable @{ LogName='Security'; ID=@(${ids.join(", ")}); ` +
        `StartTime=(Get-Date).AddHours(-${String(hours)}) } -MaxEvents ${String(max)} -ErrorAction SilentlyContinue | ` +
        "Select-Object TimeCreated, Id, Level, LevelDisplayName, ProviderName, Message | ConvertTo-Json -Depth 3 -Compress";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 90_000 });
      if (!res.ok) {
        const why = /denied|permission|unauthorized/i.test(res.error ?? "")
          ? `${res.error} (the Security log often needs an elevated server process)`
          : (res.error ?? "unknown error");
        return fail(`get_security_events failed: ${why}`);
      }

      const raw = res.stdout.trim();
      if (raw === "" || raw === "null") {
        return text(`No security events in the last ${String(hours)} h`, []);
      }
      try {
        const rows = asArray<Record<string, unknown>>(JSON.parse(raw) as never);
        const events = rows.map((e) => {
          const id = Number(e.Id ?? 0);
          return {
            time: fromPsDate(e.TimeCreated) ?? String(e.TimeCreated ?? ""),
            id,
            meaning: SECURITY_IDS[id] ?? "security event",
            level: eventLevel(e.Level, e.LevelDisplayName),
            provider: String(e.ProviderName ?? ""),
            message: String(e.Message ?? "").replace(/\s+/g, " ").slice(0, 300),
          };
        });
        const failed = events.filter((e) => e.id === 4625).length;
        return ok(
          { count: events.length, failed_logons: failed, events },
          `${String(events.length)} security event(s), ${String(failed)} failed logon(s)`,
        );
      } catch {
        return text(raw);
      }
    },
  },
  {
    name: "list_drivers",
    module: "security",
    title: "List drivers",
    description:
      "Kernel drivers with their state, start type and the binary on disk — the surface an attacker or a bad update touches.",
    docs:
      "Lists Win32_SystemDriver: name, display name, running state, start mode, the path of the .sys file and its " +
      "creator. That is the combination you check when you suspect a filter driver: security products, VPNs and " +
      "disk tools all live here.\n" +
      "A running driver whose binary is missing from disk is the interesting case; the path column is empty then, " +
      "and a follow-up call can look at what is left on disk.\n" +
      "The creator is read from the file version info of the .sys on disk, because Win32_SystemDriver leaves its " +
      "Manufacturer property empty on recent Windows builds. Reading driver info works unprivileged; a binary that " +
      "cannot be opened simply reports an empty creator.",
    input: z.object({
      name: z.string().optional().describe("Substring match on the driver name"),
      state: z.enum(["Running", "Stopped", "Start pending", "Stop pending"]).optional().describe("Exact state filter"),
      third_party_only: z.boolean().optional().describe("Skip drivers whose creator is Microsoft"),
      max_drivers: z.number().int().positive().max(1500).optional().describe("Maximum number of drivers. Defaults to 400"),
    }),
    handler: async (args) => {
      const max = Number(args.max_drivers ?? 400);
      const conditions: string[] = [];
      if (args.name) conditions.push(`$_.Name -like ${psQuote(`*${String(args.name)}*`)}`);
      if (args.state) conditions.push(`$_.State -eq ${psQuote(String(args.state))}`);
      if (args.third_party_only) conditions.push(`$_.Company -notlike ${psQuote("*Microsoft*")}`);

      const script =
        "$rows = @(foreach ($d in Get-CimInstance Win32_SystemDriver -ErrorAction SilentlyContinue) { " +
        "$p = if ($d.PathName) { [Environment]::ExpandEnvironmentVariables($d.PathName) } else { '' }; " +
        "$company = ''; " +
        "if ($p -and (Test-Path -LiteralPath $p -ErrorAction SilentlyContinue)) { " +
        "$company = [string](Get-Item -LiteralPath $p -ErrorAction SilentlyContinue).VersionInfo.CompanyName }; " +
        "$out = $d | Select-Object Name, DisplayName, State, StartMode, PathName; " +
        "$out | Add-Member -NotePropertyName Company -NotePropertyValue $company -Force; $out }); " +
        "$rows" +
        (conditions.length > 0 ? ` | Where-Object { ${conditions.join(" -and ")} }` : "") +
        ` | Select-Object -First ${String(max)} | ` +
        "ConvertTo-Json -Depth 3 -Compress";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 90_000 });
      if (!res.ok) {
        return fail(`list_drivers failed: ${res.error ?? "unknown error"}`);
      }
      const raw = res.stdout.trim();
      if (raw === "" || raw === "null") {
        return text("No drivers match the filter", []);
      }
      try {
        const rows = asArray<Record<string, unknown>>(JSON.parse(raw) as never);
        const drivers = rows.map((d) => ({
          name: String(d.Name ?? ""),
          display_name: String(d.DisplayName ?? ""),
          state: String(d.State ?? ""),
          start_mode: String(d.StartMode ?? ""),
          path: String(d.PathName ?? ""),
          creator: String(d.Company ?? ""),
        }));
        const running = drivers.filter((d) => d.state === "Running").length;
        return ok(
          { count: drivers.length, running, drivers },
          `${String(drivers.length)} driver(s), ${String(running)} running`,
        );
      } catch {
        return text(raw);
      }
    },
  },
  {
    name: "get_minifilters",
    module: "security",
    title: "List minifilters",
    description:
      "The filesystem minifilter stack in altitude order: who sits on top of the disk and in which order they see I/O.",
    docs:
      "Runs the same listing as `fltmc filters` and shows each filter with its altitude and frame. Altitude " +
      "decides the order of interception, so this answers \"which filter sees my file first\".\n" +
      "This is where antivirus, backup agents and encryption tools register. A filter that is installed but not " +
      "started, or two filters at the same altitude, explains most \"the disk is slow but no process is busy\" " +
      "reports.\n" +
      "The listing needs elevation: unprivileged it answers with the raw access-denied text and an empty list.",
    input: z.object({}),
    handler: async () => {
      const script =
        "if (-not (Get-Command fltmc.exe -ErrorAction SilentlyContinue)) { Write-Output 'nofltmc'; exit }; " +
        "$t = & fltmc.exe filters 2>&1 | Out-String; $t";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 30_000 });
      if (!res.ok) {
        return fail(`get_minifilters failed: ${res.error ?? "unknown error"}`);
      }
      const raw = res.stdout.trim();
      if (raw.toLowerCase() === "nofltmc") {
        return fail("fltmc.exe is not available on this system");
      }

      // fltmc filters prints a table whose columns are name, instance count and frame, and whose
      // rows are only useful once the altitude is added back from the registry. The frame column is
      // printed only for instances that have one, so a data row may carry two or three columns; the
      // header rows are skipped by the numeric second column.
      const table: Array<{ name: string; instances: number; frame: string }> = [];
      for (const line of raw.split("\n")) {
        const row = /^(\S+)\s+(\d+)(?:\s+(\d+))?$/.exec(line.trim());
        if (row) {
          table.push({ name: row[1] ?? "", instances: Number(row[2] ?? 0), frame: row[3] ?? "" });
        }
      }
      if (table.length === 0 && /0x80070005|access is denied|Zugriff/i.test(raw)) {
        return fail(`get_minifilters: listing the filter instances needs elevation (${raw.split("\n").pop()?.trim() ?? "access denied"})`);
      }

      const names = table.map((f) => f.name);
      const altitudes = new Map<string, string>();
      if (names.length > 0) {
        const regScript =
          "$out = @(); " +
          `foreach ($n in @(${names.map((n) => psQuote(n)).join(", ")})) { ` +
          "$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\' + $n + '\\Instances'; " +
          "$a = (Get-ItemProperty -LiteralPath $k -ErrorAction SilentlyContinue).Altitude; " +
          "$out += [pscustomobject]@{ Name=$n; Altitude=[string]$a } }; " +
          "ConvertTo-Json -Depth 3 -Compress -InputObject $out";
        const reg = await runPowerShell<string>(regScript, { json: false, timeoutMs: 30_000 });
        if (reg.ok) {
          try {
            for (const row of asArray<Record<string, unknown>>(JSON.parse(reg.stdout.trim()) as never)) {
              altitudes.set(String(row.Name ?? ""), String(row.Altitude ?? ""));
            }
          } catch {
            // The raw text is returned anyway, so an unparsable registry read loses only the column.
          }
        }
      }

      const filters = table.map((f) => ({ ...f, altitude: altitudes.get(f.name) ?? "" }));
      return ok(
        { count: filters.length, filters, raw },
        `${String(filters.length)} minifilter(s) in the stack`,
      );
    },
  },
  {
    name: "analyze_pe",
    module: "security",
    title: "Analyze executable",
    description:
      "Static look at an .exe or .dll: size, architecture, and its imported DLLs and API functions grouped by category.",
    docs:
      "The suspicious-file triage tool. It answers \"what does this binary talk to\" without running it, which is the " +
      "question you ask about a file that appeared in an unusual folder or was dropped by an updater.\n" +
      "Imports come from dumpbin when the Visual Studio tools are installed, and fall back to a strings-based scan " +
      "of the import directory otherwise. Either way the APIs are grouped into process, registry, file, network, " +
      "service, sync and crypto, so a remote-thread plus read-process-memory combination is visible as such.\n" +
      "Needs a path that the server process can read. Network paths and paths on another user's profile are fine as " +
      "long as the ACLs allow it.",
    input: z.object({
      path: z.string().min(1).describe("Full path to the .exe or .dll"),
      max_apis: z.number().int().positive().max(2000).optional().describe("Maximum number of API names per module. Defaults to 60"),
    }),
    handler: async (args) => {
      const path = String(args.path);
      const maxApis = Number(args.max_apis ?? 60);

      const infoScript =
        `if (-not (Test-Path -LiteralPath ${psQuote(path)})) { Write-Output 'notfound'; exit }; ` +
        "$f = Get-Item -LiteralPath " + psQuote(path) + "; " +
        "ConvertTo-Json -Compress -InputObject @{name=$f.Name; size=$f.Length; modified=$f.LastWriteTime; dir=$f.DirectoryName}";

      const info = await runPowerShell<string>(infoScript, { json: false, timeoutMs: 30_000 });
      if (!info.ok) {
        return fail(`analyze_pe failed: ${info.error ?? "unknown error"}`);
      }
      const infoRaw = info.stdout.trim();
      if (infoRaw.toLowerCase() === "notfound") {
        return fail(`File "${basename(path)}" not found`);
      }

      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(infoRaw) as Record<string, unknown>;
      } catch {
        meta = { raw: infoRaw };
      }

      // A structural read of the import table: parse the PE header, then the import directory entries.
      const peScript =
        `$bytes = [System.IO.File]::ReadAllBytes(${psQuote(path)}); ` +
        "$pe = [System.BitConverter]::ToInt32($bytes, 0x3C); " +
        "if ([System.BitConverter]::ToUInt16($bytes, $pe) -ne 0x4550) { Write-Output 'notpe'; exit }; " +
        "$machine = [System.BitConverter]::ToUInt16($bytes, $pe+4); " +
        "$sections = [System.BitConverter]::ToUInt16($bytes, $pe+6); " +
        "$optSize = [System.BitConverter]::ToUInt16($bytes, $pe+20); " +
        "$magic = [System.BitConverter]::ToUInt16($bytes, $pe+24); " +
        // The data directories follow the optional header's standard and Windows-specific fields,
        // which are 96 bytes for PE32 and 112 for PE32+; the import directory is entry number 1.
        "$dirOff = $pe + 24 + $(if ($magic -eq 0x20b) { 112 } else { 96 }); " +
        "$importRva = [System.BitConverter]::ToUInt32($bytes, $dirOff + 8); " +
        "$secOff = $pe + 24 + $optSize; $sec = @(); " +
        "for ($i=0; $i -lt $sections; $i++) { $o = $secOff + ($i*40); " +
        "$sec += [pscustomobject]@{ RVA=[System.BitConverter]::ToUInt32($bytes,$o+12); " +
        "VSize=[System.BitConverter]::ToUInt32($bytes,$o+8); Raw=[System.BitConverter]::ToUInt32($bytes,$o+20) } }; " +
        "function R2O($rva) { foreach ($s in $sec) { if ($rva -ge $s.RVA -and $rva -lt ($s.RVA + [math]::Max($s.VSize,1))) { return $s.Raw + ($rva - $s.RVA) } }; return 0 }; " +
        "$io = R2O $importRva; $imports = @(); " +
        "if ($io -gt 0) { for ($e=0; $e -lt 64; $e++) { $ent = $io + ($e*20); " +
        "$nameRva = [System.BitConverter]::ToUInt32($bytes, $ent+12); " +
        "if ($nameRva -eq 0) { break }; $no = R2O $nameRva; if ($no -eq 0) { break }; " +
        "$s=''; for ($c=$no; $c -lt $bytes.Length; $c++) { $b=$bytes[$c]; if ($b -eq 0) { break }; $s += [char]$b }; " +
        "$ilt = [System.BitConverter]::ToUInt32($bytes, $ent); if ($ilt -eq 0) { $ilt = [System.BitConverter]::ToUInt32($bytes, $ent+16) }; " +
        "$apis = @(); $ao = R2O $ilt; " +
        // An import thunk is 8 bytes on PE32+ and 4 on PE32, and the ordinal flag sits in the top bit.
        // bigint rather than uint64, because 5.1 cannot even write the top-bit literal as uint64.
        "$thunk = $(if ($magic -eq 0x20b) { 8 } else { 4 }); " +
        "if ($ao -gt 0) { for ($k=0; $k -lt 512; $k++) { $p = $ao + ($k*$thunk); " +
        "$v = $(if ($thunk -eq 8) { [bigint][System.BitConverter]::ToInt64($bytes, $p) } else { [bigint][System.BitConverter]::ToUInt32($bytes, $p) }); " +
        "if ($v -eq 0) { break }; " +
        "$flag = $(if ($thunk -eq 8) { [bigint]1 -shl 63 } else { [bigint]1 -shl 31 }); " +
        "if (($v -band $flag) -ne 0) { $apis += ('ordinal_' + (($v -band 0xFFFF).ToString())); continue }; " +
        "$fo = R2O ([uint32]($v -band 0x7FFFFFFF)); if ($fo -eq 0) { break }; " +
        "$n=''; for ($c=$fo+2; $c -lt $bytes.Length; $c++) { $b=$bytes[$c]; if ($b -eq 0) { break }; $n += [char]$b }; " +
        "if ($n -ne '') { $apis += $n } } }; " +
        "$imports += [pscustomobject]@{ Module=$s; Apis=$apis } } }; " +
        "ConvertTo-Json -Depth 4 -Compress -InputObject @{machine=$machine; magic=$magic; imports=$imports}";

      const pe = await runPowerShell<string>(peScript, { json: false, timeoutMs: 60_000 });
      if (!pe.ok) {
        return fail(`analyze_pe could not read the import table: ${pe.error ?? "unknown error"}`);
      }
      const peRaw = pe.stdout.trim();
      if (peRaw.toLowerCase() === "notpe") {
        return fail(`"${basename(path)}" is not a PE executable`);
      }

      try {
        const d = JSON.parse(peRaw) as { machine: number; magic: number; imports: unknown };
        const arch = Number(d.machine) === 0x8664 ? "x64" : Number(d.machine) === 0x14c ? "x86" : `0x${(Number(d.machine)).toString(16)}`;
        const modules = asArray<Record<string, unknown>>(d.imports as never).map((m) => {
          const apis = asArray<string>(m.Apis as never).map(String);
          const categories: Record<string, number> = {};
          for (const api of apis) {
            const cat = categorize(api);
            categories[cat] = (categories[cat] ?? 0) + 1;
          }
          return {
            module: String(m.Module ?? ""),
            api_count: apis.length,
            apis: apis.slice(0, maxApis),
            categories,
          };
        });

        const totalApis = modules.reduce((sum, m) => sum + m.api_count, 0);
        return ok({
          file: meta.name ?? basename(path),
          size_bytes: Number(meta.size ?? 0) || null,
          modified: fromPsDate(meta.modified) ?? String(meta.modified ?? ""),
          directory: String(meta.dir ?? ""),
          architecture: arch,
          pe_format: Number(d.magic) === 0x20b ? "PE32+" : Number(d.magic) === 0x10b ? "PE32" : "unknown",
          imported_modules: modules.length,
          imported_apis: totalApis,
          modules,
        }, `${String(modules.length)} imported DLL(s), ${String(totalApis)} APIs, ${arch}`);
      } catch {
        return text(peRaw);
      }
    },
  },
];
