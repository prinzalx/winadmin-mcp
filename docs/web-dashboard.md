# The Web Dashboard

The UI is a single file (`src/webui.html`, vanilla JS, no build step). With 46 switchable tools it
is organized as **browser-style tabs — one tab per module** — so a screen shows one module at a
time instead of an endless list:

```
Tools
  [all visible] [all approval]        ← master switches, every tool at once
  ┌ Services ┼ Events ┼ Processes ┼ Network ┼ Diagnostics ┐
  │ Scheduler ┼ Registry ┼ Security ┼ Monitor ┼ Learnings  │
  └─────────────────────────────────────────────────────────┘
  <one-line description of the module>
  <the tools of that module, one row each>
System · Awaiting approval · Recent activity
```

| Area | Contents |
|---|---|
| **Tools** | one tab per module. Each row: tool name, description, read/write badge, and the two switches (**visible**, **approval**). The approval switch is disabled when the tool is off. |
| **Hover docs** | rest the pointer on any tool row and a small documentation card appears: what the tool answers, what the result codes mean, when elevation is needed. The same texts power the agent-facing tool descriptions. |
| **System** | the last `system_health` output — uptime, CPU, memory, drives, error count |
| **Awaiting approval** | the parked actions with tool, arguments and the **Run** / **Drop** buttons, plus the **ask in agent** and **agent may confirm** switches |
| **Recent activity** | the most recent audit entries: time, tool, success, duration, source, with a **Clear** button in the heading |

Below the columns a footer shows the running version, centered, and — when GitHub has a newer
release — an **update available 0.x.y** link to the
[releases page](https://github.com/prinzalx/winadmin-mcp/releases). The lookup happens once at
startup and never blocks it; `WAMD_NO_UPDATE_CHECK=1` skips it entirely.

The page polls `/api/state` every two seconds and re-renders only when something actually changed,
so a tool call from the agent or a freshly parked action shows up without a manual reload. The audit
list is also read back from the audit file at startup, which means the history survives a server
restart.

**Clear** in the *Recent activity* heading empties the list. It rewrites the audit file as well, so
the entries do not come back on the next start; tool switches and pending approvals are untouched.

## HTTP Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | the UI |
| `GET` | `/api/state` | version, configuration path, audit path, all tools with their switches and docs, the module docs, `pending`, the last 25 audit entries, last health snapshot, latest release version |
| `PATCH` | `/api/tools` | `{"enabled": {…}, "requireApproval": {…}}` — write switches, save file, notify client |
| `PATCH` | `/api/settings` | `{"allowAgentConfirm": true|false, "askInAgent": true|false}` — where the approval is asked and who may run a parked action |
| `POST` | `/api/pending/<id>` | `{"action": "confirm"}` (default) or `{"action": "cancel"}` |
| `POST` | `/api/run` | `{"tool": "…", "args": {…}}` — run a tool from the UI, even across the MCP channel |
| `POST` | `/api/audit/clear` | drop the recorded calls and rewrite the audit file |
| `ANY` | `/mcp` | MCP over Streamable HTTP, for clients without stdio |

## Master switches

Above the tabs, the section heading carries two switches that act on **every** tool at once:
`all visible` and `all approval`. Each module tab repeats the pair in its own header, for the tools
of that module only. Both are rendered as ordinary checkboxes and follow the state of their members:

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
`notifications/tools/list_changed` — exactly **one** notification per change, never one per tool,
which would flood the terminal of anyone watching stdio. A client that ignores the notification
sees the change at the latest on the next `tools/list`.

## What the Terminal Shows

Because stdio belongs to the agent, the terminal is the only window into the running server. It
prints one line per call and one line per connecting client:

```
  client connected: Hermes 0.4.1 — popup supported
  ok   list_services (mcp) 693 ms
  ok   restart_service (mcp) 0 ms parked, waiting for approval
  err  stop_service (mcp) 858 ms
```

This is stderr, so it never interferes with the JSON-RPC frames on stdout.
