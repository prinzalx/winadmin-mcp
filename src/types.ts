import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import type { AuditLog } from "./audit.js";
import type { ConfigStore } from "./config.js";
import type { SafetyManager } from "./safety.js";

export type ModuleName =
  | "services"
  | "events"
  | "processes"
  | "network"
  | "diagnostics"
  | "scheduler"
  | "registry"
  | "security"
  | "monitor"
  | "learnings";

export const MODULE_NAMES: ModuleName[] = [
  "services",
  "events",
  "processes",
  "network",
  "diagnostics",
  "scheduler",
  "registry",
  "security",
  "monitor",
  "learnings",
];

export interface ToolContext {
  config: ConfigStore;
  safety: SafetyManager;
  audit: AuditLog;
}

export interface ToolDefinition {
  name: string;
  module: ModuleName;
  /** Human friendly label shown in the web interface. */
  title: string;
  description: string;
  input: z.ZodType;
  /** Marks tools that change system state; surfaced as a badge in the web interface. */
  destructive?: boolean;
  /** Used when the config file does not mention a tool yet. */
  defaultEnabled?: boolean;
  /**
   * Whether a call has to be approved through `confirm_action` or the web interface before
   * it runs. Off by default so MCP clients get an immediate answer; the web interface can
   * switch it on per tool.
   */
  defaultRequiresApproval?: boolean;
  /**
   * Longer explanation shown in the web interface when the operator hovers over the tool. Plain
   * text; newlines separate paragraphs. Kept out of `description`, which the model sees and which
   * should stay short enough to fit a tool list.
   */
  docs?: string;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<CallToolResult>;
}
