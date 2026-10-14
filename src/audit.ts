import { appendFileSync, mkdirSync } from "node:fs";
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
}

function defaultAuditPath(): string {
  const override = process.env.WAMD_AUDIT;
  if (override) {
    return override;
  }
  const base = process.env.APPDATA ?? join(homedir(), ".windows-admin-mcp");
  return join(base, "windows-admin-mcp", "audit.jsonl");
}

/**
 * Append-only JSONL audit trail. The path is absolute on purpose: a relative path would
 * resolve against the MCP client's working directory, which differs per client.
 */
export function createAuditLog(): AuditLog {
  const path = defaultAuditPath();
  let buffer: AuditRecord[] = [];

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
  };
}
