import { randomUUID } from "node:crypto";

import type { ConfigStore } from "./config.js";

export interface PendingAction {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  source: string;
  createdAt: string;
  expiresAt: string;
}

export interface SafetyManager {
  /** Whether a tool call has to be approved before it is executed. */
  needsApproval(tool: string): boolean;
  create(tool: string, args: Record<string, unknown>, source: string): PendingAction;
  list(): PendingAction[];
  /** Returns the pending action without removing it, or `undefined` if it is unknown or expired. */
  peek(id: string): PendingAction | undefined;
  /** Removes and returns the pending action, or `undefined` if it is unknown or expired. */
  take(id: string): PendingAction | undefined;
  cancel(id: string): boolean;
  isProtectedProcess(name: string): boolean;
}

const TTL_MS = 10 * 60 * 1000;

export function createSafety(config: ConfigStore): SafetyManager {
  const pending = new Map<string, PendingAction>();

  const isLive = (action: PendingAction): boolean =>
    new Date(action.expiresAt).getTime() > Date.now();

  return {
    needsApproval(tool) {
      return config.settings.requireApprovalTools[tool] === true;
    },

    create(tool, args, source) {
      const now = Date.now();
      const action: PendingAction = {
        id: randomUUID().slice(0, 8),
        tool,
        args,
        source,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + TTL_MS).toISOString(),
      };
      pending.set(action.id, action);
      return action;
    },

    list() {
      for (const [id, action] of pending) {
        if (!isLive(action)) {
          pending.delete(id);
        }
      }
      return [...pending.values()];
    },

    peek(id) {
      const action = pending.get(id);
      return action && isLive(action) ? action : undefined;
    },

    take(id) {
      const action = pending.get(id);
      if (!action) {
        return undefined;
      }
      pending.delete(id);
      return isLive(action) ? action : undefined;
    },

    cancel(id) {
      return pending.delete(id);
    },

    isProtectedProcess(name) {
      const clean = name.replace(/\.exe$/i, "").toLowerCase();
      return config.settings.protectedProcesses.some(
        (p) => p.replace(/\.exe$/i, "").toLowerCase() === clean,
      );
    },
  };
}
