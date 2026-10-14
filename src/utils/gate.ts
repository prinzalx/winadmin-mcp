import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ToolContext } from "../types.js";
import { fail, pending } from "./result.js";

/**
 * Handles the approval gate shared by every destructive tool.
 *
 * Without `confirmation_id` the call is either executed directly or parked as a pending
 * action, depending on the per-tool approval setting. With an id the parked action is
 * consumed and executed.
 */
export async function gate(
  tool: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  execute: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const id = args.confirmation_id;

  if (typeof id === "string") {
    if (!ctx.safety.take(id)) {
      return fail(`Unknown or expired confirmation_id "${id}"`);
    }
    return execute();
  }

  const action = ctx.safety.create(tool, args, "mcp");
  if (ctx.safety.needsApproval(tool)) {
    return pending(action);
  }
  ctx.safety.cancel(action.id);
  return execute();
}
