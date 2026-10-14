import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AuditRecord {
  ts: string;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  error?: string;
  /** `mcp` for calls coming from an MCP client, `web` for calls from the web interface. */
  source: string;
}

export interface AuditLog {
  path: string;
  write(record: Omit<AuditRecord, "ts">): void;
  recent(limit?: number): AuditRecord[];
  /** Increments on every clear, so the web UI notices a view that went empty. */
  generation(): number;
  clear(): void;
}

function defaultAuditPath(): string {
  const override = process.env.WAMD_AUDIT;
  if (override) {
    return override;
  }
  const base = process.env.APPDATA ?? join(homedir(), ".winadmin-mcp");
  return join(base, "winadmin-mcp", "audit.jsonl");
}

/** Reads the last lines of an existing audit file, so the web UI survives a server restart. */
function loadTail(path: string, limit = 200): AuditRecord[] {
  try {
    if (!existsSync(path)) {
      return [];
    }
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .slice(-limit)
      .map((line) => JSON.parse(line) as AuditRecord);
  } catch {
    return [];
  }
}

/**
 * Append-only JSONL audit trail. The path is absolute on purpose: a relative path would
 * resolve against the MCP client's working directory, which differs per client.
 */
export function createAuditLog(): AuditLog {
  const path = defaultAuditPath();
  let buffer: AuditRecord[] = loadTail(path);
  if (buffer.length > 200) {
    buffer = buffer.slice(-200);
  }
  let generation = 0;

  return {
    path,
    write(record) {
      const entry: AuditRecord = { ts: new Date().toISOString(), ...record };
      buffer.push(entry);
      if (buffer.length > 200) {
        buffer = buffer.slice(-200);
      }
      try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
      } catch {
        // An audit failure must never take down a tool call.
      }
    },
    recent(limit = 50) {
      return buffer.slice(-limit).reverse();
    },
    generation() {
      return generation;
    },
    clear() {
      buffer = [];
      generation += 1;
      try {
        // Rewrite instead of append, otherwise the next start would reload the old entries.
        writeFileSync(path, "", "utf8");
      } catch {
        // Same rule as write(): never let the audit file break the server.
      }
    },
  };
}
