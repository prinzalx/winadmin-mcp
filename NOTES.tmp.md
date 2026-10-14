The approval switch now works for **every** tool.

Before this release the gate lived inside each tool handler and only *destructive* tools called it, so switching **Approval** on for a read-only tool such as `list_services` had no effect — the agent got its answer immediately and nothing appeared in the approval queue. The gate is enforced centrally now, before any handler runs.

## Also in this release

- **Readable stdio log.** Every call is reported as one compact line (`ok list_services (mcp) 693 ms`) instead of a raw `notifications/tools/list_changed` JSON frame, and a connecting MCP client is announced by name and version.
- **One notification per change.** A config commit — however many switches it touched — sends exactly one `list_changed` instead of one per tool.
- **The web UI keeps itself current.** It polls `/api/state` every two seconds and re-renders only on a real change, so agent calls and parked actions show up without a manual reload.
- **Recent activity survives a restart.** The list is seeded from the audit file at startup instead of starting empty.

## Upgrading

No config migration needed. Rebuild and restart the server:

```bash
git pull
npm ci
npm run build
```
