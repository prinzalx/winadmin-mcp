# windows-admin-mcp

A Windows administration MCP server with a web interface to switch every function on and off.

## How it works

Every tool shells out to PowerShell 5.1 with a fixed argument list:

```
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& { <command> | ConvertTo-Json }"
```

User input never reaches the command line raw. It is embedded in single-quoted PowerShell
string literals (`psQuote` doubles `'`, nothing else), so `$`, backticks and `;` cannot start
a new expression.

## Two switches per tool

The web interface (default `http://127.0.0.1:8787`) exposes two independent settings per tool:

| Switch | Effect |
| --- | --- |
| **visible** | Off means the tool is removed from `tools/list`, so MCP clients never see it. A call anyway returns "… is disabled". |
| **approval** | On means a call does not execute immediately: it is parked and returns a `confirmation_id`. Confirm with `confirm_action` or the **Run** button. |

Changes are written to `%APPDATA%\windows-admin-mcp\config.json` and take effect immediately —
the client gets a `tools/list_changed` notification.

## Tools (20)

- **services** — `list_services`, `get_service`, `start_service`, `stop_service`, `restart_service`, `set_service_startmode`
- **events** — `query_events`, `summary_events`, `explain_event_id`
- **processes** — `list_processes`, `get_process`, `kill_process`, `check_ports`
- **network** — `ping_host`, `test_port`, `resolve_dns`, `list_interfaces`
- **diagnostics** — `system_health`, `diagnose_service`, `get_windows_update`

Plus `list_pending` and `confirm_action` for the approval flow.

## Usage

```bash
npm install
npm run build
npm test          # drives the server over stdio, the way an MCP client does
node dist/index.js
```

Point an MCP client at `node <path>/dist/index.js` (stdio). The web interface starts in the
same process; `GET /mcp` also speaks MCP over streamable HTTP.

Environment: `WAMD_PORT` (web interface, default 8787), `WAMD_CONFIG`, `WAMD_AUDIT`.

## Layout

```
src/
  index.ts              MCP server + HTTP control plane
  config.ts             enabled/approval switches, persisted to %APPDATA%
  safety.ts             approval gate (pending actions, protected processes)
  audit.ts              append-only JSONL audit trail
  types.ts              ToolDefinition, module names
  utils/powershell.ts   the only place a process is started
  utils/result.ts       CallToolResult helpers
  utils/gate.ts         the shared approval gate
  data/event-ids.ts     event id knowledge base
  modules/<name>/       tools grouped per area
  webui.html            the control panel (single file, no build step)
```

## Deliberate choices

- **PowerShell filters use WQL where possible** (`Get-CimInstance -Query …`), because
  `Where-Object { … }` script blocks are a common injection shape and WQL filters on the CIM side.
- **`asArray`** normalises `ConvertTo-Json`, which returns a bare object for a single result.
- **Absolute audit/config paths**: a relative path would resolve against the MCP client's working directory.
- **Approvals default to off** so MCP calls answer immediately; switch them on per tool when you want a second look.
