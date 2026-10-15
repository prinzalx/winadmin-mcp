import type { ModuleName, ToolDefinition } from "../types.js";

import { diagnosticTools } from "./diagnostics/index.js";
import { eventTools } from "./events/index.js";
import { learningsTools } from "./learnings/index.js";
import { monitorTools } from "./monitor/index.js";
import { networkTools } from "./network/index.js";
import { processTools } from "./processes/index.js";
import { registryTools } from "./registry/index.js";
import { schedulerTools } from "./scheduler/index.js";
import { securityTools } from "./security/index.js";
import { serviceTools } from "./services/index.js";

/** Every tool the server knows about, in the order the web interface lists them. */
export const ALL_TOOLS: ToolDefinition[] = [
  ...serviceTools,
  ...eventTools,
  ...processTools,
  ...networkTools,
  ...diagnosticTools,
  ...schedulerTools,
  ...registryTools,
  ...securityTools,
  ...monitorTools,
  ...learningsTools,
];

export const TOOLS_BY_NAME: Map<string, ToolDefinition> = new Map(
  ALL_TOOLS.map((tool) => [tool.name, tool]),
);

/**
 * One paragraph per module, shown under the tab bar of the web interface. It explains what the
 * group is for, which is more than the tab label can carry.
 */
export const MODULE_DOCS: Record<ModuleName, string> = {
  services:
    "Windows services: list and inspect them, start, stop and restart, and change the start mode. The write " +
    "tools are the ones worth gating behind an approval.",
  events:
    "The Windows Event Log. Query it by id, level or provider, summarize which component is misbehaving, and " +
    "explain what a single event id usually means without leaving the server.",
  processes: "Running processes and the ports they hold: find what eats memory, look one process up, kill it, check which port is taken.",
  network:
    "Outbound reachability from the machine itself: ping, a TCP port probe, a DNS lookup and the interface list. " +
    "Answers the questions a container on the same host cannot answer about Windows.",
  diagnostics:
    "One-shot snapshots: overall system health, a deep check on a single service, and the Windows Update state " +
    "read from the registry.",
  scheduler:
    "Task Scheduler. List, inspect, start and gate tasks, and read the run history of one task. The place where " +
    "maintenance jobs and vendor updaters hide.",
  registry:
    "Read a key or value, write and delete a value, export a subtree as .reg. Every write exports the key to a " +
    "backup file first, so a wrong change is recoverable.",
  security:
    "The security surface: whether this server runs elevated, the Security log narrowed to logon and process " +
    "events, kernel drivers, the filesystem minifilter stack and a static look at an executable's imports.",
  monitor:
    "Change detection for a polling agent. Event deltas since the last call, automatic services that are not " +
    "running, error counts against the previous window, restart loops and what was installed recently.",
  learnings:
    "A memory of what the team already decided about recurring findings. Store a verdict in plain words, search " +
    "the log by words, parse a mailed .evtx, and quote the stored note instead of investigating twice.",
};
