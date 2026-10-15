# Tools by Module

48 tools in `tools/list`: **46 switchable** ones from ten modules plus two permanent governance
tools. Everything starts off; what is off disappears from `tools/list` at runtime.

| Module | switchable |
|---|---|
| **Services** | `list_services`, `get_service`, `start_service`, `stop_service`, `restart_service`, `set_service_startmode` |
| **Events** | `query_events`, `summary_events`, `explain_event_id` |
| **Processes** | `list_processes`, `get_process`, `kill_process`, `check_ports` |
| **Network** | `ping_host`, `test_port`, `resolve_dns`, `list_interfaces` |
| **Diagnostics** | `system_health`, `diagnose_service`, `get_windows_update` |
| **Scheduler** | `list_tasks`, `get_task`, `run_task`, `enable_task`, `disable_task`, `task_history` |
| **Registry** | `read_registry_key`, `write_registry_value`, `delete_registry_value`, `export_registry_key` |
| **Security** | `check_elevation`, `get_security_events`, `list_drivers`, `get_minifilters`, `analyze_pe` |
| **Monitor** | `events_watch`, `services_watch`, `error_trends`, `service_restarts`, `system_changes` |
| **Learnings** | `list_learnings`, `add_learning`, `forget_learning`, `search_events`, `parse_evtx`, `export_learnings` |
| **Governance** (permanent) | `list_pending`, `confirm_action` |

The two governance tools are always active and not switchable in the UI; otherwise an agent could no
longer confirm a parked action after its last tool had been disabled.

In the web dashboard every row also carries a hover mini-doc; the paragraphs below are the same
texts in full.

## Services

| Tool | Input | Response |
|---|---|---|
| `list_services` | `name?` (substring), `status?` = `Running` \| `Stopped` \| `Paused`, `startmode?`, `search?` (name or display name) | name, display name, state, start mode, log-on account, PID |
| `get_service` | `name` (exact, e.g. `WSearch`) | a single service, like the example output in [Getting Started](getting-started.md) |
| `start_service` · `stop_service` · `restart_service` | `name`, `confirmation_id?` | short message plus state; *destructive* |
| `set_service_startmode` | `name`, `startmode` = `automatic` \| `automatic_delayed` \| `manual` \| `disabled`, `confirmation_id?` | new start mode; *destructive* |

## Events

| Tool | Input | Response |
|---|---|---|
| `query_events` | `log?` = `System` (default) \| `Application` \| `Security` \| `Setup`, `level?` (`critical`…`info`), `hours?` (default 24), `event_id?`, `source?`, `max_events?` (default 50, max 1000) | newest first, each entry with time, ID, level, provider and message (truncated to 400 characters) |
| `summary_events` | `log?`, `hours?` | error and warning counts per provider — the fastest route to the culprit |
| `explain_event_id` | `event_id`, `log?` (wording only) | meaning, severity, typical cause. **No process start**: pure lookup in `src/data/event-ids.ts` |

## Processes

| Tool | Input | Response |
|---|---|---|
| `list_processes` | `name?` (substring), `top?` (default 20, max 200), `sort?` = `cpu` \| `memory` (default) \| `name` | top processes with memory and command line |
| `get_process` | `name` (exact, without `.exe`), `max_instances?` (max 100) | details for all instances of the name |
| `kill_process` | `name` (with or without `.exe`), `confirmation_id?` | kills **all** instances; *destructive* |
| `check_ports` | `port?`, `protocol?` = `TCP` \| `UDP` | without `port`: all ports with connection counts; with `port`: whether it is listening or not, plus owning process |

`kill_process` spares the protected system processes; an attempt on `lsass`, `csrss`, `svchost`,
`winlogon`, `smss` or `services` is rejected instead of destabilizing the machine.

## Network

| Tool | Input | Response |
|---|---|---|
| `ping_host` | `host`, `count?` (default 4, max 10) | reachable yes/no plus average round-trip time |
| `test_port` | `host`, `port`, `timeout_ms?` (default 3000, max 30000) | whether the TCP connection was accepted — the fastest firewall/reachability test |
| `resolve_dns` | `name`, `record_type?` = `A` (default) \| `AAAA` \| `PTR` \| `MX` \| `TXT`, `server?` | addresses with type and TTL |
| `list_interfaces` | `only_up?` | interfaces with state and addresses |

## Diagnostics

| Tool | Input | Response |
|---|---|---|
| `system_health` | – | computer name, OS and build, uptime, last boot, CPU load, memory, drives, error count of the last 24 h |
| `diagnose_service` | `name` (exact) | state, start mode, process, dependencies and the recent log entries that mention the service |
| `get_windows_update` | `count?` (default 5, max 20) | update state from the registry plus the newest installation results |

## Scheduler

Task Scheduler: the place where maintenance jobs and vendor updaters hide.

| Tool | Input | Response |
|---|---|---|
| `list_tasks` | `name?` (substring), `path?` (substring of the folder), `state?` = `Running` \| `Ready` \| `Disabled` \| `Queued` \| `Unknown`, `max_tasks?` (default 200) | name, folder, state, plus last run time, last result code and next run for tasks that ran at least once |
| `get_task` | `name` (exact), `path?` (folder; defaults to the root folder) | schedule, action command, account and logon type, settings, last run result, run count |
| `run_task` | `name`, `path?`, `confirmation_id?` | starts the task now; *destructive* |
| `enable_task` / `disable_task` | `name`, `path?`, `confirmation_id?` | switches the task on or off; *destructive* |

Result code `0` means success, `0x41303` the task is still running, `0x41306` it was aborted. The
account and logon type matter for failures: a task set to run whether the user is logged on or not,
without a stored password, runs non-interactive and cannot map a network drive or show a window.

| Tool | Input | Response |
|---|---|---|
| `task_history` | `name`, `hours?` (default 72), `max_events?` (default 30) | recent Task Scheduler log entries for one task |

Reads the `Microsoft-Windows-TaskScheduler/Operational` log: event 100 is "Action started", 102
"Action completed", 103 reports the result code, 200 "Action encountered an error". The log is
size-limited and rolls over, so on a busy machine it goes back only a few days.

## Registry

Read a key or value, write and delete a value, export a subtree. **Every write exports the key to a
`.reg` backup first**, so a wrong change is recoverable. Backups land next to the config file, in
`%APPDATA%\winadmin-mcp\registry-backups`.

| Tool | Input | Response |
|---|---|---|
| `read_registry_key` | `key` (e.g. `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion`), `name?` (single value), `include_subkeys?` (default true) | value names with type and content (numbers additionally in hex), plus subkey names |
| `write_registry_value` | `key`, `name`, `value` (string, number or string list), `type?` = `string` \| `expandstring` \| `dword` \| `qword` \| `binary` \| `multistring`, `confirmation_id?` | the written value plus the backup file name; *destructive* |
| `delete_registry_value` | `key`, `name`, `confirmation_id?` | removes one value (not the key with its subkeys); *destructive* |
| `export_registry_key` | `key`, `file?` | the whole subtree as `.reg` text, or written to the given file |

The type is inferred when you do not give one: an existing value keeps its type, a new value becomes
a string. Pass `dword` explicitly for the many settings that are numbers, because writing `"1"` as a
string instead of a DWORD is the classic silent failure. Whether the write needs elevation depends on
the key: HKCU usually works unprivileged, HKLM often does not.

## Security

The security surface: capabilities of the server process itself, the Security log, kernel drivers,
the filesystem minifilter stack and a static look at an executable.

| Tool | Input | Response |
|---|---|---|
| `check_elevation` | – | whether this server process runs elevated, its user, integrity level (from the mandatory-label SID, locale-independent) and the Windows version |
| `get_security_events` | `event_id?` (defaults to the interesting set), `hours?` (default 24), `max_events?` (default 50) | Security-log entries narrowed to logon, privilege, process-creation and account events, each annotated with what the id means |
| `list_drivers` | `name?` (substring), `state?`, `third_party_only?`, `max_drivers?` (default 400) | kernel drivers with state, start type, the `.sys` path on disk and its creator |
| `get_minifilters` | – | the filesystem minifilter stack in altitude order — who sits on top of the disk and in which order they see I/O |
| `analyze_pe` | `path` (full path to an `.exe`/`.dll`), `max_apis?` (default 60) | size, architecture, imported DLLs and API functions grouped by category (process, registry, file, network, service, sync, crypto) |

Logon type in a Security event tells the story: type 2 is interactive at the keyboard, type 3 a
network share, type 10 Remote Desktop, type 5 a service. Reading the Security log needs elevation on
some systems; `get_minifilters` (like `fltmc filters`) does too, and answers with a hint when the
token is restricted.

`analyze_pe` is the suspicious-file triage tool: it answers "what does this binary talk to" without
running it. A running driver whose binary is missing from disk is the interesting case in
`list_drivers` — the path column is empty then.

## Monitor

Change detection for a polling agent, inspired by a monitoring mode.

| Tool | Input | Response |
|---|---|---|
| `events_watch` | `log?` (default `System`), `level?` (default `warning`), `hours?` (default 4), `reset?`, `max_events?` (default 40) | only the events **since the last call** — the server keeps a watermark per log and level |
| `services_watch` | `search?` (substring), `max_services?` (default 100) | automatic services that are **not** running — the classic "what died" list |
| `error_trends` | `log?` (default `System`), `hours?` (default 24) | error counts per provider for the current window against the previous window of the same length: growing, shrinking, steady or **new** |
| `service_restarts` | `name?`, `hours?` (default 24), `max_entries?` | services that stopped or crashed repeatedly in the window — the crash-loop detector |
| `system_changes` | `days?` (default 7), `max_items?` | hotfixes and programs installed in the window — "what changed before it broke" |

`events_watch` is what an agent polls: the first call reports the full window, every later call only
the delta. `reset: true` forgets the watermark. A provider that only appears in the current window of
`error_trends` is reported as new, which is usually the most interesting row of the table.

## Learnings

A memory of what the team already decided about recurring findings — so the same DCOM entry is not
investigated once per week. The store is a plain JSON file (default
`%APPDATA%\winadmin-mcp\learnings.json`, override with `WAMD_LEARNINGS`); no database, no embeddings,
committed to a repo it becomes a shared team memory.

| Tool | Input | Response |
|---|---|---|
| `list_learnings` | `event_id?`, `verdict?` = `benign` \| `known-issue` \| `needs-action` | the stored findings, each with id, event id, provider, verdict, note, tags, author |
| `add_learning` | `note` (plain words), `verdict`, `event_id?`, `provider?`, `tags?`, `author?` | stores the decision; *destructive* |
| `forget_learning` | `id` (from `list_learnings`), `confirmation_id?` | removes one entry; *destructive* |
| `search_events` | `words` (e.g. `"disk reset"`), `log?` (default `System`), `hours?` (default 24), `max_events?` (default 20) | log entries matched **by words in the message**, each annotated with the learnings that score highest for its id and provider |
| `parse_evtx` | `path` (one `.evtx` file, or several separated by commas), `event_id?`, `max_rows?` (default 50) | reads an exported event file the way the event viewer does, with counts per id and provider — for logs someone mailed you |
| `export_learnings` | `format?` = `json` (default) \| `csv` | the whole memory as text, ready to share |

`add_learning` is the tool an agent calls after a human tells it something: *"finding 2 is our EDR,
harmless"* becomes a learning with verdict `benign`. The scoring in `search_events` is intentionally
simple and visible: an exact event id is worth most, a provider match next, each keyword a little —
which is why the answer includes a score, so a weak match can be discounted.
