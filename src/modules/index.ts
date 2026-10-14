import type { ToolDefinition } from "../types.js";

import { diagnosticTools } from "./diagnostics/index.js";
import { eventTools } from "./events/index.js";
import { networkTools } from "./network/index.js";
import { processTools } from "./processes/index.js";
import { serviceTools } from "./services/index.js";

/** Every tool the server knows about, in the order the web interface lists them. */
export const ALL_TOOLS: ToolDefinition[] = [
  ...serviceTools,
  ...eventTools,
  ...processTools,
  ...networkTools,
  ...diagnosticTools,
];

export const TOOLS_BY_NAME: Map<string, ToolDefinition> = new Map(
  ALL_TOOLS.map((tool) => [tool.name, tool]),
);
