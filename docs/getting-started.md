# Getting Started

winadmin-mcp is a Windows-admin MCP server: it lets an agent (Claude Code, Codex, Hermes, …) look at
services, event logs, processes and the network through typed tools, without the agent having to
build PowerShell quotes itself.

You need **Node.js 20 or newer** (`node --version` to check).

## 1. Get the files

Either clone the repository:

```bash
git clone https://github.com/prinzalx/winadmin-mcp.git
cd winadmin-mcp
```

Or, without Git: on the GitHub page click **Code → Download ZIP**, unpack the archive and open the
resulting folder. Everything has to stay in that one folder — `src/`, `package.json`, the config and
the build output belong together.

## 2. Install and build

This creates `dist/` from the TypeScript sources:

```bash
npm ci
npm run build
```

## 3. Start the server

```bash
node dist/index.js
```

The terminal answers with a banner and a few lines about where the server lives:

```
██╗    ██╗██╗███╗   ██╗ █████╗ ██████╗ ███╗   ███╗██╗███╗   ██╗  ███╗   ███╗ ██████╗██████╗
██║    ██║██║████╗  ██║██╔══██╗██╔══██╗████╗ ████║██║████╗  ██║  ████╗ ████║██╔═════██╔══██╗
██║ █╗ ██║██║██╔██╗ ██║███████║██║  ██║██╔████╔██║██║██╔██╗ ██║  ██╔████╔██║██║     ██████╔╝
██║███╗██║██║██║╚██╗██║██╔══██║██║  ██║██║╚██╔╝██║██║██║╚██╗██║  ██║╚██╔╝██║██║     ██╔═══╝
╚███╔███╔╝██║██║ ╚████║██║  ██║██████╔╝██║ ╚═╝ ██║██║██║ ╚████║  ██║ ╚═╝ ██║╚██████╗██║
 ╚══╝╚══╝ ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═══╝  ╚═╝     ╚═╝ ╚═════╝╚═╝

  version         v0.5.0
  web interface   http://127.0.0.1:8787
  MCP transport   stdio — this terminal stays attached to the agent
```

**These lines are output, not arguments.** You do not pass the URL anywhere; the server announces it
and you *surf to it in a browser* — open `http://127.0.0.1:8787`. The last line says the same about
the terminal: it is the MCP channel, so the command does not return and the window has to stay open.

If the port is taken, pass another one: `node dist/index.js --port 9000`.

## 4. Switch tools on

In the browser, open that address and switch on what the agent is allowed to touch. On a fresh
machine **every tool starts off** (least privilege); until you switch something on, `tools/list`
returns only `list_pending` and `confirm_action`.

The section header carries a master switch for all tools at once, and each module tab has its own
pair. See [the web dashboard](web-dashboard.md).

## Two roles in one process

**stdio** is the MCP transport, and the same process starts the HTTP interface. Both share the same
tool list, the same switches and the same audit trail — so the web UI can take tools away from a
running agent live, without the agent restarting.

- **stdio belongs to the agent**, which spawns the server itself at startup and reads and writes
  within it.
- The **HTTP interface** is aimed at the human and is deliberately not a second server with its own
  configuration.

Binding happens to `127.0.0.1`: the UI triggers administrative actions; access from the network would
only be safe after TLS plus authentication.

## Updating

```bash
git pull
npm ci
npm run build
```

then restart the server. The footer of the web dashboard shows **update available 0.x.y** when GitHub
has a newer release.

## What It Feels Like

A real call, a real machine:

```jsonc
// tools/call: get_service { "name": "Spooler" }
{
  "name": "Spooler",
  "display_name": "Print Queue",
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
| **No streaming** | Results are one-shot JSON documents. Anyone who wants to watch processes in real time calls the tool again — or uses `events_watch`, which reports the delta since the last call. |

## Where to read next

- [Tools by module](tools.md) — what each of the 46 switchable tools does
- [Approval gate](governance.md) — visible / approval, popups, who may confirm
- [Web dashboard](web-dashboard.md) — tabs, hover docs, endpoints
- [Hermes agent](hermes.md) — config, skill, TUI popups
- [Configuration](configuration.md) — CLI switches, environment variables, config file
