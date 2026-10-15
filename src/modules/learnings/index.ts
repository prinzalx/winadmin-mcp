import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ToolDefinition } from "../../types.js";
import { asArray, eventLevel, fromPsDate, psQuote, runPowerShell } from "../../utils/powershell.js";
import { fail, ok, text } from "../../utils/result.js";

type Verdict = "benign" | "known-issue" | "needs-action";

interface Learning {
  id: string;
  /** Event id this finding belongs to, or 0 for a note about the machine in general. */
  event_id: number;
  provider: string;
  verdict: Verdict;
  note: string;
  tags: string[];
  created: string;
  author: string;
}

function storePath(): string {
  const override = process.env.WAMD_LEARNINGS;
  if (override) {
    return override;
  }
  const base = process.env.APPDATA ?? join(homedir(), ".winadmin-mcp");
  return join(base, "winadmin-mcp", "learnings.json");
}

function load(): Learning[] {
  try {
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as Learning[]) : [];
  } catch {
    return [];
  }
}

function save(items: Learning[]): void {
  const path = storePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  } catch {
    // A read-only profile must not break a tool call; the learning is then only in memory.
  }
}

/** Short, human-quotable id, because an operator reads this in a chat, not in a database. */
function newId(items: Learning[]): string {
  const taken = new Set(items.map((i) => i.id));
  for (;;) {
    const id = Math.random().toString(16).slice(2, 8);
    if (!taken.has(id)) {
      return id;
    }
  }
}

/**
 * Deliberately dumb scoring instead of embeddings: an exact id match is worth most, a provider match
 * next, each keyword hit a little. That keeps the memory explainable — the answer says why a learning
 * was attached — and costs no process start.
 */
function score(learning: Learning, eventId: number | undefined, provider: string | undefined, words: string[]): number {
  let points = 0;
  if (eventId !== undefined && learning.event_id === eventId) points += 50;
  if (provider && learning.provider && learning.provider.toLowerCase() === provider.toLowerCase()) points += 20;
  const haystack = `${learning.note} ${learning.tags.join(" ")} ${learning.provider}`.toLowerCase();
  for (const word of words) {
    if (word.length > 2 && haystack.includes(word)) points += 5;
  }
  return points;
}

const verdictField = z
  .enum(["benign", "known-issue", "needs-action"])
  .describe("How to treat this finding next time: ignorable, a known problem, or something to fix");

export const learningsTools: ToolDefinition[] = [
  {
    name: "list_learnings",
    module: "learnings",
    title: "List learnings",
    description:
      "The stored findings memory: what the team already decided about recurring event-log entries.",
    docs:
      "Reads the learnings file, which is a plain JSON array next to the config. Every entry names the event id it " +
      "belongs to, a verdict and the note that explains it.\n" +
      "The purpose is to stop re-explaining the same finding: once \"event 10010 from DCOM is our EDR timing out, " +
      "harmless\" is stored, later triage calls can quote it instead of investigating again.\n" +
      "The file is meant to be committed to a repo or shipped to teammates, so a whole team shares one memory.",
    input: z.object({
      event_id: z.number().int().positive().optional().describe("Only learnings for this event id"),
      verdict: z.enum(["benign", "known-issue", "needs-action"]).optional().describe("Only learnings with this verdict"),
    }),
    handler: async (args) => {
      let items = load();
      if (args.event_id !== undefined) {
        items = items.filter((l) => l.event_id === Number(args.event_id));
      }
      if (args.verdict !== undefined) {
        items = items.filter((l) => l.verdict === args.verdict);
      }
      if (items.length === 0) {
        return text("No learnings stored yet. Add one with add_learning.", []);
      }
      return ok({ count: items.length, learnings: items, path: storePath() }, `${String(items.length)} learning(s) stored`);
    },
  },
  {
    name: "add_learning",
    module: "learnings",
    title: "Add learning",
    description:
      "Store a decision about a finding in natural language, so later triage can quote it instead of investigating again.",
    docs:
      "The write side of the memory, and the tool an agent calls after a human tells it something: " +
      "\"finding 2 is our EDR, harmless\" becomes a learning with verdict benign.\n" +
      "Give the event id when you have one — that is what makes a later lookup automatic. Provider is optional but " +
      "sharpen the note with it, because several products share an id.\n" +
      "Nothing here is validated against the log; a learning is an opinion the team agreed on, so it can be added " +
      "before the evidence is complete.",
    input: z.object({
      note: z.string().min(3).describe("The finding and the decision, in plain words"),
      event_id: z.number().int().positive().optional().describe("The event id this note explains. Omit for a general note"),
      provider: z.string().optional().describe("The logon provider or component, e.g. Microsoft-Windows-Kernel-Power"),
      verdict: verdictField,
      tags: z.array(z.string()).optional().describe("Free-form labels for grouping, e.g. [\"edr\", \"network\"]"),
      author: z.string().optional().describe("Who decided this. Defaults to the MCP client"),
    }),
    destructive: true,
    handler: async (args) => {
      const items = load();
      const learning: Learning = {
        id: newId(items),
        event_id: Number(args.event_id ?? 0),
        provider: String(args.provider ?? ""),
        verdict: args.verdict as Verdict,
        note: String(args.note),
        tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
        created: new Date().toISOString(),
        author: String(args.author ?? "mcp"),
      };
      items.push(learning);
      save(items);
      return text(
        `Learning ${learning.id} stored: ${learning.verdict} — ${learning.note}`,
        learning,
      );
    },
  },
  {
    name: "forget_learning",
    module: "learnings",
    title: "Forget learning",
    description: "Remove one entry from the learnings memory by its id.",
    docs:
      "Used when a decision turns out wrong or the product behind it got uninstalled. list_learnings gives the ids; " +
      "they are short hex strings so an agent can quote them.\n" +
      "Removing a learning is not destructive to the system, only to the memory, which is why it is a write tool but " +
      "a cheap one.\n" +
      "Forgets nothing when the id is unknown, and says so, which is the correct answer after a teammate already " +
      "cleaned the file up.",
    input: z.object({
      id: z.string().min(1).describe("The learning id, as returned by list_learnings"),
      confirmation_id: z.string().optional().describe("Set only when confirming a parked action; omit for a direct call"),
    }),
    destructive: true,
    handler: async (args) => {
      const items = load();
      const id = String(args.id);
      const kept = items.filter((l) => l.id !== id);
      if (kept.length === items.length) {
        return fail(`No learning with id "${id}"`);
      }
      save(kept);
      return text(`Learning ${id} forgotten`, { id, remaining: kept.length });
    },
  },
  {
    name: "search_events",
    module: "learnings",
    title: "Search events (semantic)",
    description:
      "Search the event log by words instead of ids, and return each hit annotated with the learnings that match it.",
    docs:
      "For the question \"something about the disk failed, I don't know the id\". The words are matched against the " +
      "message text, and each result carries the stored learnings that score highest for its id and provider.\n" +
      "Scoring is intentionally simple and visible: an exact event id is worth most, a provider match next, each " +
      "keyword a little. That is why the answer includes a score, so a weak match can be discounted.\n" +
      "Message matching means Windows has to render the messages, which is slower than an id-only query. Keep the " +
      "window small — a few hours — for the fastest answer.",
    input: z.object({
      words: z.string().min(2).describe("Words to look for in the event message, e.g. \"disk reset\""),
      log: z.enum(["System", "Application", "Security", "Setup"]).optional().describe("The log to search. Defaults to System"),
      hours: z.number().int().positive().max(720).optional().describe("Look-back window in hours. Defaults to 24"),
      max_events: z.number().int().positive().max(100).optional().describe("Maximum number of events. Defaults to 20"),
    }),
    handler: async (args) => {
      const words = String(args.words);
      const log = String(args.log ?? "System");
      const hours = Number(args.hours ?? 24);
      const max = Number(args.max_events ?? 20);

      const script =
        `Get-WinEvent -FilterHashtable @{ LogName=${psQuote(log)}; StartTime=(Get-Date).AddHours(-${String(hours)}) } ` +
        `-MaxEvents 4000 -ErrorAction SilentlyContinue | Where-Object { $_.Message -like ${psQuote(`*${words}*`)} } | ` +
        `Select-Object -First ${String(max)} | Select-Object TimeCreated, Id, Level, LevelDisplayName, ProviderName, Message | ` +
        "ConvertTo-Json -Depth 3 -Compress";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 90_000 });
      if (!res.ok) {
        return fail(`search_events failed: ${res.error ?? "unknown error"}`);
      }
      const raw = res.stdout.trim();
      if (raw === "" || raw === "null") {
        return text(`No ${log} events matching "${words}" in the last ${String(hours)} h`, []);
      }

      const learnings = load();
      const terms = words.toLowerCase().split(/\s+/).map((w) => w.trim());
      try {
        const rows = asArray<Record<string, unknown>>(JSON.parse(raw) as never);
        const events = rows.map((e) => {
          const id = Number(e.Id ?? 0);
          const provider = String(e.ProviderName ?? "");
          const matches = learnings
            .map((l) => ({ learning: l, score: score(l, id, provider, terms) }))
            .filter((m) => m.score >= 50)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);
          return {
            time: fromPsDate(e.TimeCreated) ?? String(e.TimeCreated ?? ""),
            id,
            level: eventLevel(e.Level, e.LevelDisplayName),
            provider,
            message: String(e.Message ?? "").replace(/\s+/g, " ").slice(0, 300),
            learnings: matches.map((m) => ({ id: m.learning.id, verdict: m.learning.verdict, note: m.learning.note })),
          };
        });
        const annotated = events.filter((e) => e.learnings.length > 0).length;
        return ok({ count: events.length, annotated, events }, `${String(events.length)} matching event(s), ${String(annotated)} explained by a learning`);
      } catch {
        return text(raw);
      }
    },
  },
  {
    name: "parse_evtx",
    module: "learnings",
    title: "Parse EVTX file",
    description:
      "Read an exported .evtx file the way the event viewer does, with counts per id and provider — for logs someone mailed you.",
    docs:
      "Triage for a file rather than a live log: after a crash you get an .evtx from the affected machine, and this " +
      "answers what is in it without importing anything. Several files can be given at once and are read as one log.\n" +
      "The summary groups by id and provider, which is the fastest way to the interesting part of a big export. " +
      "A specific event_id narrows the rows after the grouping, so the counts stay about the whole file.\n" +
      "The file must be readable by the server process, and it is read only — parsing never writes to the export.",
    input: z.object({
      path: z.string().min(1).describe("Path to one .evtx file, or several separated by commas"),
      event_id: z.number().int().positive().optional().describe("Return the rows for this id only"),
      max_rows: z.number().int().positive().max(500).optional().describe("Maximum number of rows to return. Defaults to 50"),
    }),
    handler: async (args) => {
      const files = String(args.path).split(",").map((p) => p.trim()).filter(Boolean);
      const max = Number(args.max_rows ?? 50);
      const id = args.event_id === undefined ? undefined : Number(args.event_id);

      const quoted = files.map((f) => psQuote(f)).join(", ");
      const script =
        `$files = @(${quoted}); $missing = @($files | Where-Object { -not (Test-Path -LiteralPath $_) }); ` +
        "if ($missing.Count -gt 0) { Write-Output ('missing|' + ($missing -join ', ')); exit }; " +
        `$e = Get-WinEvent -Path $files -ErrorAction SilentlyContinue${id ? ` -FilterXPath "*[System[(EventID=${String(id)}]]]"` : ""}; ` +
        "$groups = @($e | Group-Object Id, ProviderName | Sort-Object Count -Descending | " +
        "Select-Object -First 20 | Select-Object Count, Name); " +
        "$rows = @($e | Sort-Object TimeCreated -Descending | Select-Object -First " + String(max) + " | " +
        "Select-Object TimeCreated, Id, Level, LevelDisplayName, ProviderName, Message); " +
        "ConvertTo-Json -Depth 4 -Compress -InputObject @{total=@($e).Count; groups=$groups; rows=$rows}";

      const res = await runPowerShell<string>(script, { json: false, timeoutMs: 120_000 });
      if (!res.ok) {
        return fail(`parse_evtx failed: ${res.error ?? "unknown error"}`);
      }
      const raw = res.stdout.trim();
      if (raw.startsWith("missing|")) {
        return fail(`EVTX file not found: ${raw.slice(8)}`);
      }
      try {
        const d = JSON.parse(raw) as { total: number; groups: unknown; rows: unknown };
        const groups = asArray<Record<string, unknown>>(d.groups as never).map((g) => ({
          count: Number(g.Count ?? 0),
          group: String(g.Name ?? ""),
        }));
        const rows = asArray<Record<string, unknown>>(d.rows as never).map((r) => ({
          time: fromPsDate(r.TimeCreated) ?? String(r.TimeCreated ?? ""),
          id: Number(r.Id ?? 0),
          level: eventLevel(r.Level, r.LevelDisplayName),
          provider: String(r.ProviderName ?? ""),
          message: String(r.Message ?? "").replace(/\s+/g, " ").slice(0, 300),
        }));
        return ok(
          { files, total_events: Number(d.total ?? 0), groups, events: rows },
          `${String(d.total ?? 0)} event(s) in ${String(files.length)} file(s)`,
        );
      } catch {
        return text(raw);
      }
    },
  },
  {
    name: "export_learnings",
    module: "learnings",
    title: "Export learnings",
    description:
      "Hand the learnings memory out as JSON or CSV, the format for sharing it with a teammate or a repo.",
    docs:
      "Returns the whole memory in the format you asked for. JSON keeps the structure and round-trips back into the " +
      "file; CSV is for a spreadsheet or a quick look in a diff.\n" +
      "Sharing works because the file is plain text with no machine-specific state, so a team can keep one file in " +
      "version control and everyone's triage quotes the same decisions.\n" +
      "To load a colleague's file back, point the WAMD_LEARNINGS environment variable at it before starting the server.",
    input: z.object({
      format: z.enum(["json", "csv"]).optional().describe("Output format. Defaults to json"),
    }),
    handler: async (args) => {
      const format = String(args.format ?? "json");
      const items = load();
      if (items.length === 0) {
        return text("No learnings stored yet", []);
      }
      if (format === "csv") {
        const header = "id,event_id,provider,verdict,tags,author,created,note";
        const rows = items.map((l) =>
          [
            l.id,
            String(l.event_id),
            l.provider,
            l.verdict,
            l.tags.join(";"),
            l.author,
            l.created,
            `"${l.note.replace(/"/g, '""')}"`,
          ].join(","),
        );
        return text([header, ...rows].join("\n"), items);
      }
      return ok({ count: items.length, path: storePath(), learnings: items });
    },
  },
];
