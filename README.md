# winadmin-mcp

[![CI](https://github.com/prinzalx/winadmin-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/prinzalx/winadmin-mcp/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A Windows-admin MCP server for agents (Claude Code, Codex, Hermes, …): **services, event logs,
processes, network and diagnostics** through 20 sharply typed tools — without the agent having to
build PowerShell quotes itself.

Plus a **web interface** (`http://127.0.0.1:8787`), in which **every tool can be switched on and
off individually**. What is off disappears from `tools/list` at runtime — the agent simply no longer
sees the function and cannot call it either.

**Contents** · [Quick Start](#quick-start) · [Why So Tightly Built](#why-so-tightly-built) ·
[Tools](#tools) · [Approval Gate](#approval-gate-and-switches) · [Web UI](#the-web-ui) ·
[Hermes](#hermes-agent) · [Configuration](#configuration) · [Development](#development)

## Quick Start

```bash
npm ci
npm run build
node dist/index.js
```

```
windows-admin-mcp web interface: http://127.0.0.1:8787
```

**stdio** is the MCP transport; the same process starts the HTTP interface. Both transports share
the same tool list, the same switches and the same audit trail — so the web UI can take tools away
from a running agent live, without the agent having to restart.

It is two roles in one process: **stdio belongs to the agent**, which spawns the server itself at
startup and reads and writes within it. The HTTP interface is aimed at the human and is deliberately
not a second server with its own configuration.

Binding happens to `127.0.0.1`: the UI triggers administrative actions; access from the network
would only be safe after TLS plus authentication.

### What It Feels Like

A real call, a real machine:

```jsonc
// tools/call: get_service { "name": "Spooler" }
{
  "name": "Spooler",
  "display_name": "Druckwarteschlange",
  "status": "Running",
  "start_mode": "Auto",
  "log_on": "LocalSystem",
  "pid": 6924
}
```

Every response consists of two parts: a readable short text for the chat and `structuredContent`
with the data. Agents can rely on the text, models with schema awareness on the structure.

## Why So Tightly Built

| Rule | Reason |
|---|---|
| **One wrapper, one process** | Every action goes through `src/utils/powershell.ts`, which starts exactly one `powershell.exe` process with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`, forces UTF-8 and sets `$ErrorActionPreference = 'Stop'`. Only one place where escape problems can arise. |
| **Local only** | All tools work against the local machine. There is no `ComputerName` parameter and therefore no remote-surprise potential. |
| **Validation before process start** | Zod checks the input *before* PowerShell starts. A typo in an enum does not cost 300 ms, only an error message with path and reason. |
| **Escaping centralized** | Every input that is interpolated into a PowerShell command goes through `psQuote` (single quotes, doubled inside) — the values stay inert inside single-quote literals. |
| **Structured errors** | `isError: true` plus text; the MCP layer stays happy, the model sees the problem. Failed calls land in the audit log with exit code, duration and reason. |
| **No streaming** | Results are one-shot JSON documents. Anyone who wants to watch processes in real time calls `list_processes` again. |

## Tools

22 tools in total: 20 switchable ones from five modules plus two permanent governance tools.

| Module | switchable | permanent |
|---|---|---|
| **Services** | `list_services`, `get_service`, `start_service`, `stop_service`, `restart_service`, `set_service_startmode` | |
| **Events** | `query_events`, `summary_events`, `explain_event_id` | |
| **Processes** | `list_processes`, `get_process`, `kill_process`, `check_ports` | |
| **Network** | `ping_host`, `test_port`, `resolve_dns`, `list_interfaces` | |
| **Diagnostics** | `system_health`, `diagnose_service`, `get_windows_update` | |
| **Governance** | | `list_pending`, `confirm_action` |

The two governance tools are always active and not switchable in the UI; otherwise an agent could no
longer confirm a parked action after its last tool had been disabled.

### Reference

**Services**

| Tool | Input | Response |
|---|---|---|
| `list_services` | `name?` (substring), `status?` = `Running` \| `Stopped` \| `Paused`, `startmode?`, `search?` (name or display name) | name, display name, state, start mode, log-on account, PID |
| `get_service` | `name` (exact, e.g. `WSearch`) | a single service, like the example output above |
| `start_service` · `stop_service` · `restart_service` | `name`, `confirmation_id?` | short message plus state; *destructive* |
| `set_service_startmode` | `name`, `startmode` = `automatic` \| `automatic_delayed` \| `manual` \| `disabled`, `confirmation_id?` | new start mode; *destructive* |

**Events**

| Tool | Input | Response |
|---|---|---|
| `query_events` | `log?` = `System` (default) \| `Application` \| `Security` \| `Setup`, `level?` (`critical`…`info`), `hours?` (default 24), `event_id?`, `source?`, `max_events?` (default 50, max 1000) | newest first, each entry with time, ID, level, provider and message (truncated to 400 characters) |
| `summary_events` | `log?`, `hours?` | error and warning counts per provider — the fastest route to the culprit |
| `explain_event_id` | `event_id`, `log?` (wording only) | meaning, severity, typical cause. **No process start**: pure lookup in `src/data/event-ids.ts` |

**Processes**

| Tool | Input | Response |
|---|---|---|
| `list_processes` | `name?` (substring), `top?` (default 20, max 200), `sort?` = `cpu` \| `memory` (default) \| `name` | top processes with memory and command line |
| `get_process` | `name` (exact, without `.exe`), `max_instances?` (max 100) | details for all instances of the name |
| `kill_process` | `name` (with or without `.exe`), `confirmation_id?` | kills **all** instances; *destructive* |
| `check_ports` | `port?`, `protocol?` = `TCP` \| `UDP` | without `port`: all ports with connection counts; with `port`: whether it is listening or not, plus owning process |

`kill_process` spares the protected system processes; an attempt on `lsass`, `csrss`, `svchost`,
`winlogon`, `smss` or `services` is rejected instead of destabilizing the machine.

**Network**

| Tool | Input | Response |
|---|---|---|
| `ping_host` | `host`, `count?` (default 4, max 10) | reachable yes/no plus average round-trip time |
| `test_port` | `host`, `port`, `timeout_ms?` (default 3000, max 30000) | whether the TCP connection was accepted — the fastest firewall/reachability test |
| `resolve_dns` | `name`, `record_type?` = `A` (default) \| `AAAA` \| `PTR` \| `MX` \| `TXT`, `server?` | addresses with type and TTL |
| `list_interfaces` | `only_up?` | interfaces with state and addresses |

**Diagnostics**

| Tool | Input | Response |
|---|---|---|
| `system_health` | – | computer name, OS and build, uptime, last boot, CPU load, memory, drives, error count of the last 24 h |
| `diagnose_service` | `name` (exact) | state, start mode, process, dependencies and the recent log entries that mention the service |
| `get_windows_update` | `count?` (default 5, max 20) | update state from the registry plus the newest installation results |

## Approval Gate and Switches

The web UI offers two switches per tool:

| Switch | Off | On |
|---|---|---|
| **visible** | tool missing from `tools/list`; a call anyway → `… is disabled in the web interface` | usable normally |
| **approval** | call executes immediately | call is parked, receipt with `confirmation_id` |

```mermaid
flowchart TD
    A["Agent calls a tool"] --> B{"visible?"}
    B -- no --> X["Error: disabled in the web interface"]
    B -- yes --> C{"approval on?"}
    C -- no --> E["Start PowerShell, return result"]
    C -- yes --> D["Park the action, return confirmation_id"]
    D --> F["Human decides: Run in the web UI or confirm_action(id)"]
    F --> E
```

Parked actions appear in the web UI and are decided there with **Run** or **Drop**; `list_pending`
shows them to the agent, `confirm_action` executes one by ID. Parked actions expire after
10 minutes.

The approval switch is deliberately **generic**: it applies to every tool the UI marks as *write*
(`start_service`, `stop_service`, `restart_service`, `set_service_startmode`, `kill_process`), but
can be turned on for **any** tool — including read access, if you want to control when the agent is
allowed to start PowerShell at all.

## The Web UI

The UI is a single file (`src/webui.html`, vanilla JS, no build step) with four areas:

| Area | Contents |
|---|---|
| **Tools** | per module group one row per tool: name, description, read/write badge, and the two switches. The approval switch is disabled when the tool is off. |
| **System** | the last `system_health` output — uptime, CPU, memory, drives, error count |
| **Awaiting approval** | the parked actions with tool, arguments and the **Run** / **Drop** buttons |
| **Recent activity** | the most recent audit entries: time, tool, success, duration, source |

### HTTP Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | the UI |
| `GET` | `/api/state` | version, configuration path, audit path, all tools with their switches, `pending`, the last 25 audit entries, last health snapshot |
| `PATCH` | `/api/tools` | `{"enabled": {…}, "requireApproval": {…}}` — write switches, save file, notify client |
| `POST` | `/api/pending/<id>` | `{"action": "confirm"}` (default) or `{"action": "cancel"}` |
| `POST` | `/api/run` | `{"tool": "…", "args": {…}}` — run a tool from the UI, even across the MCP channel |
| `ANY` | `/mcp` | MCP over Streamable HTTP, for clients without stdio |

### Master switches

Above the list, the section heading carries two switches that act on **every** tool at once:
`all visible` and `all approval`. Each module group repeats the pair in its own header, for the
tools of that module only. Both are rendered as ordinary checkboxes and follow the state of their
members:

| Members | Checkbox |
|---|---|
| all on | checked |
| none on | unchecked |
| some on, some off | indeterminate (dash) |

Switching a master writes the value for all its members in one `PATCH /api/tools` request, so the
config file is saved once and the client gets one `list_changed` — not one per tool. A master
applies to all its members, including tools that are currently hidden; the per-row approval switch
being greyed out only concerns that row.

Every switch change is persisted and reported to the MCP client via
`notifications/tools/list_changed`. A client that ignores the notification sees the change at the
latest on the next `tools/list`.

## Hermes Agent

[Hermes](https://github.com/NousResearch/hermes-agent) speaks MCP out of the box: our tools appear
there as `mcp_winadmin_*`, and Hermes picks up changes to the tool list live — so the on/off
switches take effect without restarting the agent.

```yaml
# ~/.hermes/config.yaml   (Windows: C:\Users\<user>\.hermes\config.yaml)
mcp_servers:
  winadmin:
    command: "node"
    args: ["C:/BLOB/output/001/dist/index.js"]
    # optional, e.g. for a leaner context window:
    # tools:
    #   exclude: ["get_windows_update"]
```

```
> hey hermes, my system crashed earlier — take a look at the event logs,
  what could be the cause?
```

For this one sentence Hermes needs no special command, but four tools: `system_health` for uptime
and the time of the last boot, `query_events` (`log: System`, `level: error`) for the window since
the boot, `explain_event_id` for Kernel-Power 41, EventLog 6008 or Service Control Manager
7000/7031/7034 — and `diagnose_service`, if a service was the trigger.

For exactly this workflow, a sample skill ships at
[`skills/windows-triage/SKILL.md`](skills/windows-triage/SKILL.md); it teaches Hermes the triage
routine: look first, then claim.

```powershell
copy -Recurse skills\windows-triage $env:USERPROFILE\.hermes\skills\
```

After that the skill is available in Hermes under `/windows-triage` and is offered automatically for
matching requests.

## Configuration

```bash
node dist/index.js --help
```

| Switch | Environment variable | Default | Purpose |
|---|---|---|---|
| `--port <n>` | `WAMD_PORT` | `8787` | port of the web interface |
| `--no-web` | `WAMD_NO_WEB=1` | off | stdio only, do not bind an HTTP port |
| `--config <path>` | `WAMD_CONFIG` | `%APPDATA%\windows-admin-mcp\config.json` | where the switches are stored |
| | `WAMD_AUDIT` | `%APPDATA%\windows-admin-mcp\audit.jsonl` | append-only audit trail |
| `--help` | | | print the usage text and exit |

The command line wins over the environment; both are optional. `--no-web` exists for setups where
only the MCP client should reach the machine — no HTTP port, no UI, one less listener.

The web UI writes `config.json`; editing it by hand works just as well:

```jsonc
{
  "enabledTools": { "list_interfaces": false },
  "requireApprovalTools": { "restart_service": true },
  "maxBulkItems": 20,
  "protectedProcesses": ["lsass", "csrss", "svchost", "winlogon", "smss", "services"]
}
```

Tools are active by default so the server works out of the box; something is only disabled once the
file explicitly switches it off. The paths are deliberately absolute — a relative path would be
resolved against the working directory of the MCP client, and that differs per client.

### Audit Trail

Every call — success as well as failure — lands as a single JSON line in `audit.jsonl`:

```json
{"ts":"2026-10-14T14:12:53.332Z","tool":"get_service","args":{"name":"Spooler"},
 "ok":true,"durationMs":619,"source":"web"}
```

`source` distinguishes `mcp` (agent) from `web` (human). The file grows append-only; rotation is so
far the operator's job.

## Development

```bash
npm run build      # tsc + copy src/webui.html to dist/
npm run dev        # build and restart with node --watch
npm run typecheck  # tsc --noEmit
npm test           # smoke test: real server, real PowerShell
```

`npm test` runs [`scripts/mcp-smoke.mjs`](scripts/mcp-smoke.mjs): the script spawns the server on a
free port, performs a real MCP handshake and checks 16 points — tool list, schema shape,
validation, a real `ping_host` call, approval parking, `list_pending`, `confirm_action`, unknown
confirmation ID, and enable/disable including
`list_changed`. Against real PowerShell/CIM output, not against a mock: a cmdlet parameter that does
not exist in PowerShell 5.1 shows up here and not in front of the agent.

### Project Structure

```
src/
  index.ts                 stdio and HTTP server, MCP handler, bootstrap
  config.ts                load/save switches, subscribe to changes
  safety.ts                approval registry: park, peek/take, expiry after 10 min
  audit.ts                 append-only JSONL trail of all calls
  types.ts                 ToolDefinition, ToolContext
  data/event-ids.ts        knowledge base for explain_event_id
  modules/
    services/              list, state, start/stop/restart, start mode
    events/                query, summary, event-ID explanation
    processes/             process list, details, kill, listening ports
    network/               ping, port test, DNS, interfaces
    diagnostics/           system_health, diagnose_service, get_windows_update
  utils/
    powershell.ts          the only place that starts a process
    result.ts              ok/text/fail/pending — uniform results
    gate.ts                approval gate for all destructive tools
  webui.html               the complete web UI (no build step needed)
scripts/
  copy-webui.mjs           src/webui.html -> dist/webui.html
  mcp-smoke.mjs            end-to-end over the real MCP transport
  web-check.mjs            check HTML, /api/state and the switches
skills/windows-triage/     sample skill for Hermes
```

Creating a new tool is deliberately cheap: a `ToolDefinition` in a module folder (or a new folder in
`src/modules/`), done — the UI, the tool list and the `/api/state` evaluation all draw from the same
list.

## Known Limitations

- **Windows only.** Uses `powershell.exe` (5.1), CIM namespaces and the
  `Get-NetTCPConnection` and `Get-WinEvent` cmdlets. PowerShell 7 is not detected and is not
  needed.
- **Localized messages.** State texts and event messages come out of Windows exactly as the system
  is configured (on a German Windows, in German). `explain_event_id`, by contrast, always answers in
  English, because the knowledge base lives in the repo.
- **Time window.** `query_events` and `summary_events` take `hours` (default 24). Anyone looking for
  a crash since the last boot sets `hours` small to match — for "since boot" it is best to compute
  from the uptime in `system_health`.
- **Cost per call.** Every tool call costs a PowerShell process, typically 0.3-2 s depending on
  system load. `explain_event_id` is the exception: pure data lookup, no process start.
- **`maxBulkItems` is prepared but not wired up.** The value sits in the configuration and is
  evaluated by no tool; it is intended for future bulk actions.
- **No auth.** The UI is bound to local only. Without TLS and login it does not belong behind a
  reverse proxy for multiple people.

## License

MIT
