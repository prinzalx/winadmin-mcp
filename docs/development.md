# Development

```bash
npm run build      # tsc + copy src/webui.html to dist/
npm run dev        # build and restart with node --watch
npm run typecheck  # tsc --noEmit
npm test           # smoke test: real server, real PowerShell
```

`npm test` runs [`scripts/mcp-smoke.mjs`](../scripts/mcp-smoke.mjs),
[`scripts/mcp-popup-check.mjs`](../scripts/mcp-popup-check.mjs) and
[`scripts/mcp-http-popup-check.mjs`](../scripts/mcp-http-popup-check.mjs): the scripts spawn the
server on a free port, perform a real MCP handshake and check 21 + 9 + 8 points — tool list, schema
shape, validation, a real `ping_host` call, approval parking (for a write tool and for a read-only
one), that an agent may **not** confirm its own parked action by default, `list_pending`,
`confirm_action`, unknown confirmation ID, and enable/disable including `list_changed`. Against real
PowerShell/CIM output, not against a mock: a cmdlet parameter that does not exist in PowerShell 5.1
shows up here and not in front of the agent.

`npm run web:check` ([`scripts/web-check.mjs`](../scripts/web-check.mjs)) checks the HTML, the
`/api/state` payload and the switches.

## Project Structure

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
    scheduler/             Task Scheduler: list, inspect, run, enable/disable, history
    registry/              read/write/delete a value, export a key, .reg backup before writes
    security/              elevation, Security log, drivers, minifilters, PE imports
    monitor/               event deltas, stopped autoservices, error trends, restart loops, changes
    learnings/             findings memory, semantic event search, .evtx parsing, export
    index.ts               ALL_TOOLS and the per-module docs shown in the UI
  utils/
    powershell.ts          the only place that starts a process
    result.ts              ok/text/fail/pending — uniform results
    gate.ts                approval gate for all destructive tools
  webui.html               the complete web UI (no build step needed)
scripts/
  copy-webui.mjs           src/webui.html -> dist/webui.html
  mcp-smoke.mjs            end-to-end over the real MCP transport
  mcp-popup-check.mjs      the approval popup, with a client that declares elicitation
  mcp-http-popup-check.mjs  the same over Streamable HTTP, in its own session
  web-check.mjs            check HTML, /api/state and the switches
skills/windows-triage/     sample skill for Hermes
docs/                      this documentation; README.md is the index
```

Creating a new tool is deliberately cheap: a `ToolDefinition` in a module folder (or a new folder in
`src/modules/`), done — the UI, the tool list and the `/api/state` evaluation all draw from the same
list. The optional `docs` field of a `ToolDefinition` is what the hover card in the web UI shows.

## Known Limitations

- **Windows only.** Uses `powershell.exe` (5.1), CIM namespaces and the
  `Get-NetTCPConnection` and `Get-WinEvent` cmdlets. PowerShell 7 is not detected and is not
  needed.
- **Localized messages.** State texts and event messages come out of Windows exactly as the system
  is configured (on a German Windows, in German). `explain_event_id` and the tool docs, by contrast,
  always answer in English, because the knowledge base lives in the repo.
- **Time window.** `query_events` and `summary_events` take `hours` (default 24). Anyone looking for
  a crash since the last boot sets `hours` small to match — for "since boot" it is best to compute
  from the uptime in `system_health`.
- **Cost per call.** Every tool call costs a PowerShell process, typically 0.3-2 s depending on
  system load. `explain_event_id` is the exception: pure data lookup, no process start.
- **Elevation-dependent reads.** `get_minifilters` and parts of the Security log need an elevated
  server process on some systems; the tools answer with a hint instead of failing hard.
- **`maxBulkItems` is prepared but not wired up.** The value sits in the configuration and is
  evaluated by no tool; it is intended for future bulk actions.
- **No auth.** The UI is bound to local only. Without TLS and login it does not belong behind a
  reverse proxy for multiple people.
