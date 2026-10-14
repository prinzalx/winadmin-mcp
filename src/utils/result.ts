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

/** Returned when a destructive tool is gated behind an approval. */
export function pending(action: { id: string; tool: string }): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          `"${action.tool}" is gated behind an approval. ` +
          `Confirm it with confirm_action(id: "${action.id}") or in the web interface.`,
      },
    ],
    structuredContent: { confirmationId: action.id, tool: action.tool },
  };
}
