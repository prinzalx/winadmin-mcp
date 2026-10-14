import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ToolDefinition } from "./types.js";

export interface Settings {
  /** Never enabled: the tool is hidden from `tools/list` for MCP clients. */
  enabledTools: Record<string, boolean>;
  /** Requires an explicit approval through the web interface or `confirm_action`. */
  requireApprovalTools: Record<string, boolean>;
  /** Maximum number of objects a bulk action may touch at once. */
  maxBulkItems: number;
  /** Process names that may never be killed. */
  protectedProcesses: string[];
}

export interface ConfigStore {
  readonly settings: Settings;
  readonly path: string;
  save(): void;
  /** Subscribe to changes made through the web interface. */
  onChange(listener: () => void): void;
  /** Notify subscribers and persist. Called after any settings mutation. */
  commit(): void;
}

const DEFAULT_PROTECTED = ["lsass", "csrss", "svchost", "winlogon", "smss", "services"];

/**
 * Reads `--flag value` and bare `--flag` from the command line. Command line wins over the
 * environment, because an explicit invocation is the stronger signal.
 */
export function parseArgs(argv: readonly string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }
  return flags;
}

export const ARGS = parseArgs(process.argv.slice(2));

function defaultConfigPath(): string {
  const cli = ARGS.get("config");
  if (typeof cli === "string" && cli !== "") {
    return cli;
  }
  const override = process.env.WAMD_CONFIG;
  if (override) {
    return override;
  }
  const base = process.env.APPDATA ?? join(homedir(), ".windows-admin-mcp");
  return join(base, "windows-admin-mcp", "config.json");
}

/**
 * Tools are enabled by default so the server works out of the box. A tool is only hidden
 * once the config file (usually written by the web interface) explicitly disables it.
 */
export function loadConfig(tools: ToolDefinition[]): ConfigStore {
  const path = defaultConfigPath();

  const settings: Settings = {
    enabledTools: Object.fromEntries(tools.map((t) => [t.name, t.defaultEnabled ?? true])),
    requireApprovalTools: Object.fromEntries(
      tools.map((t) => [t.name, t.defaultRequiresApproval ?? false]),
    ),
    maxBulkItems: 20,
    protectedProcesses: [...DEFAULT_PROTECTED],
  };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    raw = undefined;
  }

  if (raw && typeof raw === "object") {
    const file = raw as Partial<Settings>;
    if (file.enabledTools) {
      for (const [name, value] of Object.entries(file.enabledTools)) {
        settings.enabledTools[name] = Boolean(value);
      }
    }
    if (file.requireApprovalTools) {
      for (const [name, value] of Object.entries(file.requireApprovalTools)) {
        settings.requireApprovalTools[name] = Boolean(value);
      }
    }
    if (typeof file.maxBulkItems === "number" && file.maxBulkItems > 0) {
      settings.maxBulkItems = file.maxBulkItems;
    }
    if (Array.isArray(file.protectedProcesses)) {
      settings.protectedProcesses = file.protectedProcesses.map(String);
    }
  }

  const listeners: Array<() => void> = [];

  return {
    settings,
    path,
    save() {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      } catch {
        // A read-only profile must not break the server.
      }
    },
    onChange(listener) {
      listeners.push(listener);
    },
    commit() {
      this.save();
      for (const listener of listeners) {
        listener();
      }
    },
  };
}
