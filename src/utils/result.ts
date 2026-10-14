import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Successful result carrying pretty-printed JSON plus a short human summary. */
export function ok(data: unknown, summary?: string): CallToolResult {
  return {
    content: [{ type: "text", text: summary ?? JSON.stringify(data, null, 2) }],
    structuredContent: { result: data },
  };
}

/** Successful result carrying plain text. */
export function text(message: string, data?: unknown): CallToolResult {
  const content = [{ type: "text" as const, text: message }];
  return data === undefined
    ? { content }
    : { content, structuredContent: { result: data } };
}

/** Failure result: the MCP layer stays happy, the model sees the problem. */
export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Returned when a tool is gated behind an approval.
 *
 * `self_confirm` says whether the calling agent is allowed to grant the approval itself; when it
 * is not, the text keeps the agent from trying, which would be a permission it gave itself.
 */
export function pending(action: { id: string; tool: string }, selfConfirm = true): CallToolResult {
  const text = selfConfirm
    ? `"${action.tool}" is gated behind an approval. Confirm it with confirm_action(id: "${action.id}") or in the web interface.`
    : `"${action.tool}" is parked for approval and waits for a human to run it in the web interface (id "${action.id}"). Do not confirm it yourself.`;
  return {
    content: [{ type: "text", text }],
    structuredContent: { confirmationId: action.id, tool: action.tool },
  };
}
