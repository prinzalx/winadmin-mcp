# Configuration

```bash
node dist/index.js --help
```

| Switch | Environment variable | Default | Purpose |
|---|---|---|---|
| `--port <n>` | `WAMD_PORT` | `8787` | port of the web interface |
| `--no-web` | `WAMD_NO_WEB=1` | off | stdio only, do not bind an HTTP port |
| `--config <path>` | `WAMD_CONFIG` | `%APPDATA%\winadmin-mcp\config.json` | where the switches are stored |
| | `WAMD_AUDIT` | `%APPDATA%\winadmin-mcp\audit.jsonl` | append-only audit trail |
| | `WAMD_LEARNINGS` | `%APPDATA%\winadmin-mcp\learnings.json` | the learnings memory file |
| | `WAMD_NO_UPDATE_CHECK` | off | skip the one-time lookup of the newest release |
| `--help` | | | print the usage text and exit |

The command line wins over the environment; both are optional. `--no-web` exists for setups where
only the MCP client should reach the machine — no HTTP port, no UI, one less listener.

The web UI writes `config.json` with one entry per tool; editing it by hand works just as well:

```jsonc
{
  "enabledTools": { "query_events": true, "system_health": true },  // the rest: false
  "requireApprovalTools": { "stop_service": true },                  // the rest: false
  "maxBulkItems": 20,
  "protectedProcesses": ["lsass", "csrss", "svchost", "winlogon", "smss", "services"],
  "allowAgentConfirm": false,
  "askInAgent": true
}
```

A config file written by an older version has no `allowAgentConfirm` entry, which means *false*: after
an upgrade an agent can no longer confirm its own parked action. A missing `askInAgent` means *true*,
so approval moves into the client popup wherever the client supports it.

Every tool starts disabled, so an entry missing from `enabledTools` means *off*. A config file that
an older version wrote with everything on keeps everything on — the default only applies to entries
that are not in the file yet. The paths are deliberately absolute; a relative path would be resolved
against the working directory of the MCP client, and that differs per client.

## Audit Trail

Every call — success as well as failure — lands as a single JSON line in `audit.jsonl`:

```json
{"ts":"2026-10-14T14:12:53.332Z","tool":"get_service","args":{"name":"Spooler"},
 "ok":true,"durationMs":619,"source":"web"}
```

`source` distinguishes `mcp` (agent) from `web` (human). In memory the trail is capped at the last
200 entries and the UI shows the last 25, so the list cannot grow without bound. Beyond that,
rotation is the operator's job — or the **Clear** button in the web UI, which drops the list and
rewrites the file.
