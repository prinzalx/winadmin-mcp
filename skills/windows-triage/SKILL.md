---
name: windows-triage
description: Diagnose a Windows machine that crashed, froze, rebooted itself, or is behaving strangely by reading the local event logs and system health through the winadmin-mcp tools. Use when the user says the system crashed or blue-screened, "ist abgestürzt", restarted on its own, a service died, or asks what caused a Windows outage or why the machine is slow.
version: 0.4.0
platforms: [windows]
metadata:
  hermes:
    category: diagnostics
    tags: [windows, event-log, triage, mcp]
---

# Windows-Triage

Teaches Hermes to diagnose a Windows machine from evidence instead of from memory. It assumes a
running `winadmin` MCP server; every tool named here appears there with the `mcp_winadmin_`
prefix.

## When to use it

- "My system crashed a moment ago."
- "Why did the machine just reboot on its own?"
- "Some service is misbehaving / is dead."
- "The machine is so slow."

## Procedure

Work the steps in this order and only judge at the end.

1. **Point of reference.** `system_health` returns `uptime_hours` and `last_boot`, which defines the
   time window: everything the user calls "a moment ago" happened after `last_boot`. The rest of the
   answer (CPU load, free memory, drives, `errors_last_24h`, `logged_in_users`) is already the first
   suspicion of whether resources are the problem.
2. **Find the scene.** `query_events` with `log: "System"`, `level: "error"`, `hours` just wide
   enough for the event, `max_events: 50`. Only if that comes back empty, widen it to `hours: 24`.
3. **Criticals separately.** Same call with `level: "critical"`. Critical events are the actual
   crash candidates; a critical entry two days before the boot is not the cause of the current
   problem.
4. **Put the noise in perspective.** `summary_events` (`log: "System"`) shows which provider reports
   the most errors or warnings. A provider with 400 DCOM entries is wallpaper, not evidence.
5. **Translate the ids.** Look up every relevant entry with `explain_event_id` (one id per call).
   Common candidates:

   | Provider / event id | Meaning |
   |---|---|
   | Kernel-Power 41 | Restart without a clean shutdown — power pulled, hard reset or bugcheck |
   | EventLog 6008 | The last shutdown was unexpected |
   | EventLog 6005 / 6006 | Event log started / ended cleanly |
   | Service Control Manager 7000 | Service could not start (dependency, path, access) |
   | Service Control Manager 7001 | Service dependency failed |
   | Service Control Manager 7031 / 7034 | Service terminated unexpectedly — not a stop, a crash |
   | Service Control Manager 7009 / 7011 | Timeout while starting or on a service control request |
   | DCOM 10010 / 10016 | DCOM server not registered in time / access denied — usually noise |

6. **Reconstruct the service.** For 7000/7031/7034, check the service with `diagnose_service`:
   current state, start mode, process, dependencies and the recent log entries that mention it. With
   two days of log material that is usually the whole story.
7. **Resources.** `list_processes` with `sort: "cpu"` and again with `sort: "memory"` (the default)
   shows whether an outlier explains the pattern. `get_process` for a perpetrator you can name.
8. **Only now judge.** Cause, evidence (log, provider, id, timestamp) and recommended action — in
   that order.

## Going deeper

When the basic triage gives no cause, keep drilling with the same logic — each tool only counts when
the previous one brought nothing:

- **Learned this before?** `list_learnings` (or `search_events` straight away, with words from the
  message) before any analysis of your own. An entry with verdict `benign` is a finished answer, not
  a reason to search. Once the verdict is settled, note it with `add_learning` (`note` in plain
  German or English, `verdict`, `event_id` when known).
- **Did anything change?** `system_changes` (7 days by default) lists installed hotfixes and programs
  — "what came before the crash". `error_trends` shows per provider whether the errors are growing,
  shrinking or steady; a provider that only appears in the current window (`new`) is usually the most
  interesting find.
- **Is everything running that should?** `services_watch` returns the auto-start services that are
  not running. `service_restarts` finds services stopped several times in the window (crash loop).
- **Anything new since last look?** `events_watch` returns only the events **since the previous
  call** (a watermark per log and level). Ideal for polling; `reset: true` forgets the watermark.
- **Scheduled tasks.** When a maintenance job did not run: `list_tasks` (`name` as a substring), then
  `get_task` for the definition, account and last result, `task_history` for the run history. Result
  code `0` is success, `0x41303` is still running, `0x41306` was aborted.
- **Registry suspicion.** `read_registry_key` reads values including their type (numbers additionally
  as hex). Writing (`write_registry_value`) exports the key as a `.reg` first — the path of the
  backup is in the answer.
- **Security surface.** Clear `check_elevation` before any write attempt (the server process, not the
  user). `get_security_events` filters the Security log to logon, process and privilege events and
  names every id. `analyze_pe` for a suspicious file without executing it.
- **Mailed logs.** Read an `.evtx` from another machine with `parse_evtx` instead of guessing.

## Rules

- **Read only.** For this triage do not trigger a `start_service`, `stop_service` or `kill_process`
  action. When an action makes sense, suggest it to the user instead of running it on your own
  authority.
- **The approval gate.** A tool set to Approval asks the agent first (a popup in `hermes --tui`), and
  the result comes back in the same call. If the client cannot show a popup, the action parks with a
  `confirmation_id` — and then this applies: **never confirm your own parked action**, otherwise the
  gate is pointless. Tell the user the action is waiting for Run in the web interface instead, and
  every unresolved parking round only grows the pending list.
- **Keep the time window honest.** "A moment ago" means since `last_boot`, "today" means since
  midnight. Name the window you used in the answer, so the user can recheck the verdict.
- **Do not speculate about unknown ids.** `explain_event_id` answers for unknown ids too
  (`No entry for event id …`); then say openly that the number is unknown instead of inventing a text.
- **An empty result is an answer.** No errors in the System log since the boot probably means the
  crash wrote no event. Then look at `Application` and `get_windows_update`, and phrase the result as
  "no hint in the System log", not as "no problem".
- **Cut the output.** `max_events` bounds the amount; do not replay JSON blocks unfiltered, but pick
  the three to five relevant entries.

## Limits of the tools

The answers are independent of the Windows display language since v0.5.2 to v0.5.4. What remains is a
property of the system, not of the server — better to know it than to misread it:

- **The level is always english.** `level` comes out as `critical`/`error`/`warning`/`info`; the
  localized text is in `level_display` (`query_events`). On a German system a warning is called
  "Warnung" — filter on that if you must, but not against `level`.
- **Times are ISO-8601 (UTC).** Everywhere; a `/Date(…)/` no longer appears.
- **`task_history` needs the operational log.** `Microsoft-Windows-TaskScheduler/Operational` exists
  since Windows 8 but is often disabled. An empty answer plus a disabled log is not a parser failure;
  `list_tasks` and `get_task` work independently of it.
- **`get_minifilters` needs elevation.** Without rights it answers with the raw access-denied text and
  an empty list. The table itself is read from its numeric columns, so the language of the header
  does not matter.
- **`list_drivers` reads the version info of the `.sys`.** The `creator` comes from the file on disk,
  because `Win32_SystemDriver` leaves its manufacturer empty. It costs about a second for all drivers;
  a file that cannot be opened yields an empty `creator`, not an error.
- **`get_windows_update` answers from the update client log.** The `Auto Update\Results` registry key
  is missing on newer Windows; the service state, a pending reboot and the event ids
  19/20/24/25/43 are the reliable source.
- **After a server restart the agent's catalog is new.** The server sends `tools/list_changed`, but
  whether the client picks it up is the client's decision — in Hermes the tools only come back after
  a `manage_connections enable` (a Hermes-side command). So if *every* tool is missing, a restart was
  involved, not a switched-off row in the web interface.

## Example

> **User:** hey hermes, my system crashed earlier, check the event logs for what could be the cause

`system_health` → uptime 0.7 h, last boot 14:18 → `query_events(log: "System", level: "error",
hours: 1)` → one hit, Service Control Manager 7034 at 14:31 → `explain_event_id(7034)` and
`explain_event_id(7000)` → `diagnose_service("Spooler")`.

> **Answer:** No bluescreen: the print spooler terminated unexpectedly at 14:31 (System, Service
> Control Manager, event 7034). Kernel-Power 41 is missing in the window since the boot at 14:18, so
> the system came up cleanly afterwards. The service runs again by now but its start mode is
> "Manual" — I would set the start mode to "Automatic", but I only do that on request.
