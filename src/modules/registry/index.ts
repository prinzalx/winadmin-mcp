import { join } from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ToolDefinition, ToolContext } from "../../types.js";
import { asArray, psQuote, runPowerShell } from "../../utils/powershell.js";
import { fail, ok, text } from "../../utils/result.js";

/**
 * Registry paths are accepted both with and without the drive colon, because the Windows docs
 * write `HKLM\...` while PowerShell wants `HKLM:\...`.
 */
function toPsPath(key: string): string {
  const trimmed = key.trim();
  const match = /^(HKLM|HKCU|HKCR|HKU|HKCC)(:)?(.*)$/i.exec(trimmed);
  if (!match) {
    return trimmed;
  }
  const hive = (match[1] ?? "").toUpperCase();
  const rest = match[3] ?? "";
  return `${hive}:${rest.startsWith("\\") ? rest : `\\${rest}`}`;
}

const TYPE_NAMES = ["string", "expandstring", "dword", "qword", "binary", "multistring"] as const;

type RegistryType = (typeof TYPE_NAMES)[number];

/** Maps a tool argument to the `-PropertyType` name of the PowerShell registry provider. */
function propertyType(type: RegistryType | undefined): string | null {
  if (!type) {
    return null;
  }
  return type.toUpperCase();
}

/**
 * Dumps a value's raw content the way an operator wants to read it: a string as text, numbers as
 * hex, binary as a byte list. Everything is decided server-side so the model does not have to
 * guess from a provider object.
 */
function shapeValue(name: string, raw: unknown, type: string): Record<string, unknown> {
  if (type === "Binary" && Array.isArray(raw)) {
    return { name, type, value: raw.map((b) => Number(b).toString(16).padStart(2, "0")).join(" ") };
  }
  if ((type === "DWord" || type === "QWord") && typeof raw === "number") {
    return { name, type, value: raw, hex: `0x${(raw >>> 0).toString(16)}` };
  }
  return { name, type, value: raw };
}

/**
 * Writes a `.reg` backup of the key before a change, into the same folder as the config file.
 * Returns the file name, or `null` when the key did not exist yet — in which case there was
 * nothing to back up and the write creates the key.
 */
async function backupKey(ctx: ToolContext, psPath: string): Promise<string | null> {
  const exists = await runPowerShell<string>(
    `Test-Path -LiteralPath ${psQuote(psPath)}`,
    { json: false },
  );
  if (!exists.ok || exists.stdout.trim().toLowerCase() !== "true") {
    return null;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const leaf = psPath.split("\\").filter(Boolean).pop() ?? "key";
  const safeLeaf = leaf.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  const file = join(process.env.APPDATA ?? ".", "winadmin-mcp", "registry-backups", `${stamp}-${safeLeaf}.reg`);

  const script =
    `New-Item -ItemType Directory -Force -Path (Split-Path -Parent ${psQuote(file)}) | Out-Null; ` +
    `reg.exe export ${psQuote(psPath.replace(/^(HKLM|HKCU|HKCR|HKU|HKCC):/, "$1"))} ${psQuote(file)} /y`;

  const res = await runPowerShell<string>(script, { json: false, timeoutMs: 60_000 });
  return res.ok ? file : null;
}

const keyField = z
  .string()
  .min(3)
  .describe("Registry key with a hive, e.g. HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion");
const nameField = z.string().min(1).describe("The registry value name");

export const registryTools: ToolDefinition[] = [
  {
    name: "read_registry_key",
    module: "registry",
    title: "Read registry key",
    description:
      "Read one registry key: its value names with type and content, plus the names of its subkeys.",
    docs:
      "The registry equivalent of listing a folder. Values are shown with their type, and numbers are " +
      "additionally given in hexadecimal, which is how most Windows documentation quotes DWORDs.\n" +
      "Subkeys are listed by name only; read the subkey itself to get its values. Set include_values to " +
      "false when you only want the structure of a key with hundreds of values.\n" +
      "A key that exists but has no values answers with an empty list, which is different from a key that " +
      "does not exist at all — that is reported as an error.",
    input: z.object({
      key: keyField,
      name: z.string().optional().describe("Read only this single value instead of the whole key"),
      include_subkeys: z.boolean().optional().describe("List subkey names too. Defaults to true"),
    }),
    handler: async (args) => {
      const psPath = toPsPath(String(args.key));
      const single = args.name as string | undefined;

      const script =
        `if (-not (Test-Path -LiteralPath ${psQuote(psPath)})) { Write-Output 'notfound'; exit }; ` +
        "$p = Get-Item -LiteralPath " + psQuote(psPath) + "; " +
        "$vals = @($p.GetValueNames() | ForEach-Object { " +
        "$n = $_; $t = $p.GetValueKind($n); $v = $p.GetValue($n, $null, 'DoNotExpandEnvironmentNames'); " +
        "[pscustomobject]@{ Name=$n; Type=[string]$t; Raw=$v } }); " +
        "$subs = @($p.GetSubKeyNames()); " +
        "ConvertTo-Json -Depth 4 -Compress -InputObject @{path=$p.Name; values=$vals; subkeys=$subs}";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 60_000 });
      if (!res.ok) {
        return fail(`read_registry_key failed: ${res.error ?? "unknown error"}`);
      }
      const raw = res.stdout.trim();
      if (raw.toLowerCase() === "notfound") {
        return fail(`Registry key "${String(args.key)}" not found`);
      }
      try {
        const d = JSON.parse(raw) as { path: string; values: unknown; subkeys: unknown };
        let values = asArray<Record<string, unknown>>(d.values as never).map((v) =>
          shapeValue(String(v.Name ?? ""), v.Raw, String(v.Type ?? "")),
        );
        if (single) {
          values = values.filter((v) => v.name === single);
          if (values.length === 0) {
            return fail(`Registry value "${single}" not found under "${String(args.key)}"`);
          }
        }
        const subkeys = asArray<string>(d.subkeys as never).map(String);
        return ok({
          key: String(args.key),
          values,
          subkeys: args.include_subkeys === false ? undefined : subkeys.sort(),
        });
      } catch {
        return text(raw);
      }
    },
  },
  {
    name: "write_registry_value",
    module: "registry",
    title: "Write registry value",
    description:
      "Set a registry value, creating the key when needed. The key is exported to a .reg backup first.",
    docs:
      "Auto-backup is the point of this tool: before the write, the whole key is exported with " +
      "reg.exe to the backups folder next to the config file, and the answer names the file. If the change " +
      "turns out wrong, that .reg restores the previous state.\n" +
      "The type is inferred when you do not give one: an existing value keeps its type, a new value becomes a " +
      "string. Pass dword explicitly for the many settings that are numbers, because writing \"1\" as a string " +
      "instead of a DWORD is the classic silent failure.\n" +
      "Whether the write needs elevation depends on the key: HKCU usually works unprivileged, HKLM often does not.",
    input: z.object({
      key: keyField,
      name: nameField,
      value: z
        .union([z.string(), z.number(), z.array(z.string())])
        .describe("The new content. A number for dword/qword, a list of strings for multistring"),
      type: z.enum(TYPE_NAMES).optional().describe("Value type. Defaults to the existing type, else string"),
      confirmation_id: z.string().optional().describe("Set only when confirming a parked action; omit for a direct call"),
    }),
    destructive: true,
    handler: async (args, ctx) => {
      const psPath = toPsPath(String(args.key));
      const name = String(args.name);
      const type = propertyType(args.type as RegistryType | undefined);
      const value = args.value;

      const backup = await backupKey(ctx, psPath);

      const literal = Array.isArray(value)
        ? `@(${value.map((v) => psQuote(String(v))).join(",")})`
        : psQuote(String(value));

      const script =
        `if (-not (Test-Path -LiteralPath ${psQuote(psPath)})) { New-Item -Path ${psQuote(psPath)} -Force | Out-Null }; ` +
        (type
          ? `New-ItemProperty -LiteralPath ${psQuote(psPath)} -Name ${psQuote(name)} -PropertyType ${type} -Value ${literal} -Force | Out-Null;`
          : `$p = Get-Item -LiteralPath ${psQuote(psPath)}; $t = try { [string]$p.GetValueKind(${psQuote(name)}) } catch { $null }; ` +
            "if ($t) { New-ItemProperty -LiteralPath " + psQuote(psPath) + " -Name " + psQuote(name) +
            " -PropertyType $t -Value " + literal + " -Force | Out-Null } " +
            "else { New-ItemProperty -LiteralPath " + psQuote(psPath) + " -Name " + psQuote(name) +
            " -PropertyType String -Value " + literal + " -Force | Out-Null };") +
        " Get-ItemPropertyValue -LiteralPath " + psQuote(psPath) + " -Name " + psQuote(name) +
        " | ConvertTo-Json -Compress";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 60_000 });
      if (!res.ok) {
        return fail(
          `write_registry_value failed: ${res.error ?? "unknown error"}. ` +
            (backup ? `The previous state is in ${backup}.` : ""),
        );
      }
      return text(
        `${String(args.key)}\\${name} set to ${res.stdout.trim()}${backup ? ` (backup: ${backup})` : " (key created)"}`,
        { key: String(args.key), name, written: res.stdout.trim(), backup },
      );
    },
  },
  {
    name: "delete_registry_value",
    module: "registry",
    title: "Delete registry value",
    description: "Remove a single value from a registry key. The key is exported to a .reg backup first.",
    docs:
      "Deletes one value, not the key with its subkeys — that would need Remove-Item and is a much bigger " +
      "blunder, so this tool deliberately does not offer it.\n" +
      "Like every write here it exports the key first, so a wrong deletion is recoverable even though the " +
      "deleted content is not echoed back in full.\n" +
      "Deleting a value is often what a program means by \"back to the default\", because the absence of a " +
      "value makes the program fall back to its own default.",
    input: z.object({
      key: keyField,
      name: nameField,
      confirmation_id: z.string().optional().describe("Set only when confirming a parked action; omit for a direct call"),
    }),
    destructive: true,
    handler: async (args, ctx) => {
      const psPath = toPsPath(String(args.key));
      const name = String(args.name);
      const backup = await backupKey(ctx, psPath);

      const script =
        `if (-not (Test-Path -LiteralPath ${psQuote(psPath)})) { Write-Output 'notfound'; exit }; ` +
        `if (-not ((Get-Item -LiteralPath ${psQuote(psPath)}).GetValueNames() -contains ${psQuote(name)})) { Write-Output 'novalue'; exit }; ` +
        `Remove-ItemProperty -LiteralPath ${psQuote(psPath)} -Name ${psQuote(name)}; Write-Output 'done'`;

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 60_000 });
      if (!res.ok) {
        return fail(`delete_registry_value failed: ${res.error ?? "unknown error"}`);
      }
      const raw = res.stdout.trim().toLowerCase();
      if (raw === "notfound") {
        return fail(`Registry key "${String(args.key)}" not found`);
      }
      if (raw === "novalue") {
        return fail(`Registry value "${name}" not found under "${String(args.key)}"`);
      }
      return text(`${String(args.key)}\\${name} deleted${backup ? ` (backup: ${backup})` : ""}`, { key: String(args.key), name, backup });
    },
  },
  {
    name: "export_registry_key",
    module: "registry",
    title: "Export registry key",
    description: "Export a whole registry key subtree as .reg text, the format reg.exe understands.",
    docs:
      "Runs the same export as the registry editor and returns the text, so you can read or compare a subtree " +
      "without writing anything to disk. Pass a file name to have it stored instead of returned.\n" +
      "The output is the reg.exe text format, which uses UTF-16 for values it cannot represent in ASCII; large " +
      "binary values come back as long hex strings.\n" +
      "A subtree with many subkeys can be big, so a read of something like HKLM\\SOFTWARE can easily be several " +
      "hundred kilobytes of text.",
    input: z.object({
      key: keyField,
      file: z.string().optional().describe("Optional file path to store the export in, instead of returning the text"),
    }),
    handler: async (args) => {
      const psPath = toPsPath(String(args.key));
      const file = args.file as string | undefined;

      const script =
        `if (-not (Test-Path -LiteralPath ${psQuote(psPath)})) { Write-Output 'notfound'; exit }; ` +
        (file
          ? `reg.exe export ${psQuote(psPath.replace(/^(HKLM|HKCU|HKCR|HKU|HKCC):/, "$1"))} ${psQuote(file)} /y; Write-Output ${psQuote(file)}`
          : `$f = Join-Path ([System.IO.Path]::GetTempPath()) ('wamd-export-' + [guid]::NewGuid().ToString('N') + '.reg'); ` +
            `reg.exe export ${psQuote(psPath.replace(/^(HKLM|HKCU|HKCR|HKU|HKCC):/, "$1"))} $f /y | Out-Null; ` +
            `Get-Content -LiteralPath $f -Raw; Remove-Item -LiteralPath $f -Force`);

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 90_000 });
      if (!res.ok) {
        return fail(`export_registry_key failed: ${res.error ?? "unknown error"}`);
      }
      const raw = res.stdout.trim();
      if (raw.toLowerCase() === "notfound") {
        return fail(`Registry key "${String(args.key)}" not found`);
      }
      return file ? text(`Exported to ${raw}`, { key: String(args.key), file: raw }) : text(raw, { key: String(args.key) });
    },
  },
];
