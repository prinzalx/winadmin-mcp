export interface EventIdInfo {
  description: string;
  severity: "info" | "warning" | "error" | "critical";
  typical_cause?: string;
}

/**
 * A small knowledge base of the Windows event IDs that actually show up in daily
 * administration. `explain_event_id` reads from this table, so extending it is a plain
 * data change with no logic involved.
 */
export const EVENT_IDS: Record<string, EventIdInfo> = {
  "1": { description: "Process created", severity: "info" },
  "12": { description: "Session started (logon)", severity: "info" },
  "13": { description: "Session ended (logoff)", severity: "info" },
  "20": { description: "Special privileges assigned to new logon", severity: "info" },
  "41": {
    description: "Kernel-Power: the system rebooted without cleanly shutting down first",
    severity: "critical",
    typical_cause: "Hard reset, power loss, or a bugcheck",
  },
  "104": { description: "Session logged off", severity: "info" },
  "106": { description: "Credentials verified for user", severity: "info" },
  "153": {
    description: "Disk write cache was flushed from volatile media to the media",
    severity: "warning",
    typical_cause: "A volatile write cache lost its data, or the battery is failing",
  },
  "203": { description: "Winlogon authentication package determined the user", severity: "info" },
  "401": { description: "Terminal Services session reconnected", severity: "info" },
  "402": { description: "Terminal Services session disconnected", severity: "info" },
  "1149": { description: "RDS connection successfully negotiated", severity: "info" },
  "4624": {
    description: "Successful logon",
    severity: "info",
    typical_cause: "Logon type 2 is local, 3 is network, 10 is RDP",
  },
  "4625": {
    description: "Failed logon",
    severity: "warning",
    typical_cause: "Wrong password, locked account, or a service using a stale credential",
  },
  "4634": { description: "An account was logged off", severity: "info" },
  "4647": { description: "User initiated logoff", severity: "info" },
  "4648": { description: "Logon attempted with explicit credentials", severity: "info" },
  "4672": { description: "Special privileges assigned to new logon", severity: "info" },
  "4720": { description: "A user account was created", severity: "info" },
  "4725": { description: "A user account was disabled", severity: "info" },
  "4740": { description: "A user account was locked out", severity: "warning" },
  "5038": { description: "Code integrity determined the file is not executable", severity: "warning" },
  "6005": { description: "Event Log service started (system boot)", severity: "info" },
  "6006": { description: "Event Log service stopped (clean shutdown)", severity: "info" },
  "6008": {
    description: "Previous system shutdown was unexpected",
    severity: "error",
    typical_cause: "Look for Kernel-Power 41 in the System log around the same timestamp",
  },
  "6013": { description: "System uptime", severity: "info" },
  "7000": {
    description: "A service failed to start due to an error",
    severity: "error",
    typical_cause: "Missing dependency, bad binary path, or access denied",
  },
  "7001": {
    description: "A service dependency failed",
    severity: "error",
    typical_cause: "Start the dependency first",
  },
  "7009": {
    description: "Timeout waiting for a service to connect",
    severity: "warning",
    typical_cause: "The service hung during startup",
  },
  "7011": { description: "Timeout waiting for a service control request", severity: "warning" },
  "7023": { description: "The service terminated with an error", severity: "error" },
  "7024": { description: "The service stopped with a service-specific error", severity: "error" },
  "7031": {
    description: "A service terminated unexpectedly and was restarted",
    severity: "error",
    typical_cause: "Recurring 7031/7034 usually means a crashing service",
  },
  "7034": { description: "A service terminated unexpectedly", severity: "error" },
  "7036": { description: "The service entered the running or stopped state", severity: "info" },
  "10010": {
    description: "DCOM server did not register within the timeout",
    severity: "warning",
  },
  "10016": {
    description: "DCOM access permission denied",
    severity: "warning",
    typical_cause: "Mostly noise; only actionable when a specific feature misbehaves",
  },
  "3621": { description: "SChannel handshake failed", severity: "warning" },
  "36871": { description: "SChannel received a fatal alert", severity: "error" },
  "36880": { description: "SChannel failed to create credentials", severity: "error" },
  "9665": { description: "Windows Update succeeded", severity: "info" },
};

export function explainEventId(id: number, log?: string): EventIdInfo {
  const known = EVENT_IDS[String(id)];
  if (known) {
    return known;
  }
  return {
    description: `No entry for event id ${String(id)}${log ? ` in the ${log} log` : ""}`,
    severity: "info",
    typical_cause: "Open the event in Event Viewer to read its full description",
  };
}
