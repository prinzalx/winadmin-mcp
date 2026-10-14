import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ToolDefinition } from "../../types.js";
import { asArray, psQuote, runPowerShell } from "../../utils/powershell.js";
import { fail, ok, text } from "../../utils/result.js";

/** Only hostnames, IPv4 literals and simple interface names may reach the shell. */
const HOST = /^[\w.\-:]{1,253}$/;

function assertHost(host: string): string | undefined {
  return HOST.test(host) ? undefined : `"${host}" contains characters that are not allowed in a host name`;
}

export const networkTools: ToolDefinition[] = [
  {
    name: "ping_host",
    module: "network",
    title: "Ping host",
    description: "Ping a host name or IP address and report the round-trip time.",
    input: z.object({
      host: z.string().min(1).describe("Host name or IP address"),
      count: z.number().int().positive().max(10).optional().describe("Number of echo requests. Defaults to 4"),
    }),
    handler: async (args) => {
      const host = String(args.host);
      const invalid = assertHost(host);
      if (invalid) {
        return fail(invalid);
      }

      const res = await runPowerShell<string>(
        `$p = Test-Connection -ComputerName ${psQuote(host)} -Count ${String(args.count ?? 4)} -Quiet; ` +
          `if (-not $p) { Write-Output 'unreachable'; exit }; ` +
          `$r = Test-Connection -ComputerName ${psQuote(host)} -Count ${String(args.count ?? 4)} | ` +
          "Measure-Object -Property ResponseTime -Average; " +
          "ConvertTo-Json -Compress -InputObject @{reachable=$true; avg_ms=[math]::Round($r.Average,1)}",
        { json: false, timeoutMs: 30_000 },
      );

      if (!res.ok) {
        return fail(`ping_host failed: ${res.error ?? "unknown error"}`);
      }

      const raw = res.stdout.trim();
      if (raw.toLowerCase() === "unreachable") {
        return ok({ host, reachable: false }, `${host} is unreachable`);
      }
      try {
        const parsed = JSON.parse(raw) as { avg_ms?: number };
        return ok(
          { host, reachable: true, avg_ms: parsed.avg_ms },
          `${host} reachable in ${String(parsed.avg_ms)} ms on average`,
        );
      } catch {
        return text(raw);
      }
    },
  },
  {
    name: "test_port",
    module: "network",
    title: "Test remote port",
    description:
      "Open a TCP connection to a remote host and port. The fastest way to check firewall or service reachability.",
    input: z.object({
      host: z.string().min(1).describe("Host name or IP address"),
      port: z.number().int().positive().max(65535).describe("Remote TCP port"),
      timeout_ms: z.number().int().positive().max(30000).optional().describe("Connect timeout. Defaults to 3000"),
    }),
    handler: async (args) => {
      const host = String(args.host);
      const port = Number(args.port);
      const invalid = assertHost(host);
      if (invalid) {
        return fail(invalid);
      }

      const res = await runPowerShell<string>(
        "$c = New-Object System.Net.Sockets.TcpClient; " +
          `$ok = $c.ConnectAsync(${psQuote(host)}, ${String(port)}).Wait(${String(args.timeout_ms ?? 3000)}); ` +
          "$c.Close(); ConvertTo-Json -Compress -InputObject @{connected=$ok}",
        { json: false, timeoutMs: 35_000 },
      );

      if (!res.ok) {
        return fail(`test_port failed: ${res.error ?? "unknown error"}`);
      }

      const raw = res.stdout.trim();
      const connected = /"connected"\s*:\s*true/i.test(raw);
      return ok(
        { host, port, connected },
        `${host}:${String(port)} ${connected ? "accepted" : "rejected or timed out"} the TCP connection`,
      );
    },
  },
  {
    name: "resolve_dns",
    module: "network",
    title: "Resolve DNS",
    description: "Resolve a host name to its addresses, or look up the reverse name of an address.",
    input: z.object({
      name: z.string().min(1).describe("Host name or IP address"),
      record_type: z.enum(["A", "AAAA", "PTR", "MX", "TXT"]).optional().describe("Defaults to A"),
      server: z.string().optional().describe("DNS server to query. Defaults to the system resolver"),
    }),
    handler: async (args) => {
      const name = String(args.name);
      const invalid = assertHost(name);
      if (invalid) {
        return fail(invalid);
      }

      const type = (args.record_type as string | undefined) ?? "A";
      const serverArg = args.server ? ` -NameServer ${psQuote(String(args.server))}` : "";

      const res = await runPowerShell<string>(
        `Resolve-DnsName -Name ${psQuote(name)} -Type ${psQuote(type)}${serverArg} -ErrorAction Stop | ` +
          "Select-Object Name, Type, IPAddress, StringData, TTL | ConvertTo-Json -Compress",
        { json: false, timeoutMs: 30_000 },
      );

      if (!res.ok) {
        return fail(`resolve_dns failed: ${res.error ?? "unknown error"}`);
      }

      const raw = res.stdout.trim();
      if (raw === "" || raw === "null") {
        return fail(`resolve_dns returned no records for ${name}`);
      }

      try {
        const list = asArray<Record<string, unknown>>(JSON.parse(raw) as never);
        return ok(
          list.map((r) => ({
            name: String(r.Name ?? ""),
            type: String(r.Type ?? ""),
            address: r.IPAddress ? String(r.IPAddress) : String(r.StringData ?? ""),
            ttl: r.TTL === undefined ? null : Number(r.TTL),
          })),
          `${String(list.length)} ${type} record(s) for ${name}`,
        );
      } catch {
        return text(raw);
      }
    },
  },
  {
    name: "list_interfaces",
    module: "network",
    title: "List interfaces",
    description: "List the network interfaces with their status and addresses. Read-only.",
    input: z.object({
      only_up: z.boolean().optional().describe("Only report interfaces that are up"),
    }),
    handler: async (args) => {
      // `OperationalStatus` is empty on some drivers, so the filter uses `Status`.
      const where = args.only_up ? " | Where-Object { $_.Status -eq 'Up' }" : "";
      const res = await runPowerShell<string>(
        `Get-NetAdapter${where} | Select-Object Name, InterfaceDescription, Status, LinkSpeed, MacAddress | ` +
          "ConvertTo-Json -Compress",
        { json: false, timeoutMs: 45_000 },
      );
      if (!res.ok) {
        return fail(`list_interfaces failed: ${res.error ?? "unknown error"}`);
      }

      const raw = res.stdout.trim();
      if (raw === "") {
        return text("No network interfaces found", []);
      }

      try {
        const list = asArray<Record<string, unknown>>(JSON.parse(raw) as never);
        return ok(
          list.map((i) => ({
            name: String(i.Name ?? ""),
            description: String(i.InterfaceDescription ?? ""),
            status: String(i.Status ?? ""),
            link_speed: String(i.LinkSpeed ?? ""),
            mac: String(i.MacAddress ?? ""),
          })),
          `${String(list.length)} interface(s)`,
        );
      } catch {
        return text(raw);
      }
    },
  },
];
