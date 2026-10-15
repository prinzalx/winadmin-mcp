# winadmin-mcp

[![CI](https://github.com/prinzalx/winadmin-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/prinzalx/winadmin-mcp/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A Windows-admin MCP server for agents (Claude Code, Codex, Hermes, …): **services, event logs,
processes, network, scheduled tasks, registry, security and monitoring** through sharply typed
tools — without the agent having to build PowerShell quotes itself.

Plus a **web dashboard** (`http://127.0.0.1:8787`), in which **every tool can be switched on and
off individually**. What is off disappears from `tools/list` at runtime — the agent simply no longer
sees the function and cannot call it either.

**Least privilege is the default:** on a fresh machine every tool starts *off*. An agent gets the
governance tools and nothing else until you decide what it may do.

## Quick Start

```bash
git clone https://github.com/prinzalx/winadmin-mcp.git
cd winadmin-mcp
npm ci
npm run build
node dist/index.js
```

The server announces where it lives — output, not arguments:

```
  version         v0.5.4
  web interface   http://127.0.0.1:8787
  MCP transport   stdio — this terminal stays attached to the agent
```

Open `http://127.0.0.1:8787` in a browser and switch on what the agent may touch. Full walkthrough
for people who have never touched Node: [docs/getting-started.md](docs/getting-started.md).

## Documentation

| Document | Contents |
|---|---|
| [Getting Started](docs/getting-started.md) | install, build, start, first switches, design rules |
| [Tools by Module](docs/tools.md) | all 46 switchable tools + 2 governance tools, inputs and answers |
| [Approval Gate](docs/governance.md) | visible/approval switches, in-client popups, who may confirm |
| [Web Dashboard](docs/web-dashboard.md) | tabs, hover docs, master switches, HTTP endpoints |
| [Hermes Agent](docs/hermes.md) | config.yaml, the windows-triage skill, why `hermes --tui` |
| [Configuration](docs/configuration.md) | CLI switches, environment variables, config file, audit trail |
| [Development](docs/development.md) | build/test commands, project structure, known limitations |

## What It Feels Like

```
> hey hermes, my system crashed earlier — take a look at the event logs,
  what could be the cause?
```

Hermes calls `system_health` for the last boot, `query_events` for the window since then,
`explain_event_id` for Kernel-Power 41 or EventLog 6008, `diagnose_service` if a service was the
trigger — and quotes a stored *learning* if the team already decided that a given DCOM entry is
harmless. A sample skill for exactly this routine ships at
[`skills/windows-triage/SKILL.md`](skills/windows-triage/SKILL.md).

## The Shape of It

48 tools in `tools/list`, grouped in the dashboard as tabs:

**Services** · **Events** · **Processes** · **Network** · **Diagnostics** · **Scheduler** ·
**Registry** · **Security** · **Monitor** · **Learnings** — plus the two permanent governance tools
`list_pending` and `confirm_action`.

Every gated tool call asks for approval **in the agent's own popup** first (standard MCP
elicitation; Hermes shows it in `hermes --tui`), and only parks for the web dashboard when the
client cannot show one. By default an agent may **not** confirm its own parked action — the human
decides. See [docs/governance.md](docs/governance.md).

## License

MIT
