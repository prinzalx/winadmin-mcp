# Hermes Agent

[Hermes](https://github.com/NousResearch/hermes-agent) speaks MCP out of the box: our tools appear
there as `mcp_winadmin_*`, and Hermes picks up changes to the tool list live — so the on/off
switches take effect without restarting the agent. Only *enabled* tools appear, so on a fresh
install Hermes sees the two governance tools until you switch things on.

A **server** restart is a different matter: the server tells the client that its list changed, but
what the client then does with that is up to it. In Hermes a connection that has to be re-enabled
with `manage_connections enable` comes back with its tools then, so if *every* tool suddenly is
unknown, look for a restart rather than for a switched-off row in the web interface.

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  winadmin:
    command: "node"
    # your checkout path to the build
    args: ["<checkout>/dist/index.js"]
    # optional, e.g. for a leaner context window:
    # tools:
    #   exclude: ["get_windows_update"]
```

## Run `hermes --tui` for the popups

In the TUI a gated tool asks for approval right in the chat (an elicitation popup, like an "option
A / B / C" question) and the result arrives in the same call. In the plain CLI Hermes does not
render the elicitation, so the action parks and the web interface decides — the calls still work,
they are just approved over there. Read-only triage is unaffected; it is the gated tools that need
the TUI.

## The one-sentence demo

```
> hey hermes, my system crashed earlier — take a look at the event logs,
  what could be the cause?
```

For this one sentence Hermes needs no special command, but four tools, and those four have to be
visible first: `system_health` for uptime and the time of the last boot, `query_events`
(`log: System`, `level: error`) for the window since the boot, `explain_event_id` for Kernel-Power
41, EventLog 6008 or Service Control Manager 7000/7031/7034 — and `diagnose_service`, if a service
was the trigger. Switch on the *events* and *diagnostics* tabs (or just those four rows) and the
prompt works; everything else stays out of the model's way.

## The windows-triage skill

For exactly this workflow, a sample skill ships at
[`skills/windows-triage/SKILL.md`](../skills/windows-triage/SKILL.md); it teaches Hermes the triage
routine: look first, then claim.

```powershell
copy -Recurse skills\windows-triage $env:USERPROFILE\.hermes\skills\
```

After that the skill is available in Hermes under `/windows-triage` and is offered automatically for
matching requests. The skill also covers the newer ground: scheduled tasks that did not run, registry
values behind a setting, the security checks (`check_elevation` before a write), the monitor tools
for "what changed", and the learnings memory — including the rule that **the agent never confirms
its own parked actions** unless the human said so.
