# winadmin-mcp

[![CI](https://github.com/prinzalx/winadmin-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/prinzalx/winadmin-mcp/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Ein Windows-Admin-MCP-Server für Agenten (Claude Code, Codex, Hermes, …): **Dienste, Event-Logs,
Prozesse, Netzwerk und Diagnose** über 20 scharf typisierte Werkzeuge — ohne dass der Agent selbst
PowerShell-Zitate bauen muss.

Dazu ein **Webinterface** (`http://127.0.0.1:8787`), in dem sich **jedes Werkzeug einzeln ein- und
ausschalten** lässt. Was aus ist, verschwindet zur Laufzeit aus `tools/list` — der Agent sieht die
Funktion schlicht nicht mehr und kann sie auch nicht aufrufen.

```
Agent ──stdio──▶ winadmin-mcp ──▶ powershell.exe / CIM ──▶ Windows
                    │
                    └─▶ http://127.0.0.1:8787   Web-UI + /mcp (HTTP)
```

## Starten

```bash
npm ci
npm run build
node dist/index.js
```

**stdio** ist der MCP-Transport; dasselbe Prozess startet das HTTP-Interface. Beide Transporte
teilen sich dieselbe Werkzeugliste, dieselben Schalter und denselben Audit-Trail — die Web-UI kann
also einem laufenden Agenten live Werkzeuge wegnehmen.

Gebunden wird an `127.0.0.1`: Die UI löst administrative Aktionen aus, ein Zugriff aus dem Netz wäre
erst nach TLS plus Authentifizierung sicher.

## Werkzeuge

| Modul | Werkzeuge |
|---|---|
| **Dienste** | `list_services`, `get_service`, `start_service`, `stop_service`, `restart_service`, `set_service_startmode` |
| **Events** | `query_events`, `summary_events`, `explain_event_id` |
| **Prozesse** | `list_processes`, `get_process`, `kill_process`, `check_ports` |
| **Netzwerk** | `ping_host`, `test_port`, `resolve_dns`, `list_interfaces` |
| **Diagnose** | `system_health`, `diagnose_service`, `get_windows_update` |
| **Governance** | `list_pending`, `confirm_action` |

Die beiden Governance-Werkzeuge sind immer aktiv; sonst könnte ein Agent eine geparkte Aktion nicht
mehr bestätigen, nachdem ihm das letzte Werkzeug deaktiviert wurde.

### Entwurfsregeln

- **Ein Wrapper, ein Prozess.** Jede Aktion geht durch `src/utils/powershell.ts`, das genau einen
  `powershell.exe`-Prozess mit `-NoProfile -NonInteractive -ExecutionPolicy Bypass` startet, UTF-8
  erzwingt und `$ErrorActionPreference = 'Stop'` setzt.
- **Nur lokal.** Alle Werkzeuge arbeiten gegen den eigenen Rechner; es gibt keinen
  ComputerName-Parameter und damit kein Remote-Überraschungspotenzial.
- **Eingaben validiert Zod**, bevor PowerShell startet. Ein Tippfehler in einem Enum kostet keine
  300 ms Prozessstart, sondern nur eine Fehlermeldung mit Pfad und Grund.
- **Strukturierte Fehler.** `isError: true` plus Text; fehlgeschlagene Aufrufe landen mit
  Exit-Code, Dauer und Fehler im Audit-Protokoll.
- **Escaping zentral.** Jede Eingabe, die in einen PowerShell-Befehl interpolationiert wird, läuft
  über `psQuote` (einfache Anführungszeichen, verdoppelt).

### Approval-Gate und Umschalter

Pro Werkzeug gibt es in der Web-UI zwei Regler:

| Regler | Aus | An |
|---|---|---|
| **Enabled** | Werkzeug fehlt in `tools/list`, Aufruf → `… is disabled in the web interface` | normal nutzbar |
| **Approval** | Aufruf wird sofort ausgeführt | Aufruf wird geparkt, Quittung mit `confirmation_id` |

Geparkte Aktionen erscheinen in der Web-UI und werden dort oder per `confirm_action` ausgeführt;
`list_pending` zeigt sie an. Parkierte Aktionen verfallen nach 10 Minuten.

Die Approval-Regel ist bewusst **generisch**: sie gilt für jedes Werkzeug, das die Web-UI als
*destructive* führt (`start_service`, `stop_service`, `restart_service`, `set_service_startmode`,
`kill_process`), kann aber für jedes Werkzeug eingeschaltet werden — auch für Lesezugriffe, wenn man
kontrollieren will, wann der Agent überhaupt PowerShell starten darf.

Jede Umschaltung wird persistiert und per `notifications/tools/list_changed` an den MCP-Client
gemeldet.

## Hermes-Agent

[Hermes](https://github.com/NousResearch/hermes-agent) spricht MCP von Haus aus: unsere Tools
erscheinen dort als `mcp_winadmin_*`, und Änderungen an der Werkzeugliste übernimmt Hermes live —
die Ein-/Aus-Schalter wirken also ohne Neustart des Agenten.

```yaml
# ~/.hermes/config.yaml   (Windows: C:\Users\<user>\.hermes\config.yaml)
mcp_servers:
  winadmin:
    command: "node"
    args: ["C:/BLOB/output/001/dist/index.js"]
    # optional, z. B. für ein schlankeres Kontextfenster:
    # tools:
    #   exclude: ["get_windows_update"]
```

```
> hey hermes, mein System ist vorhin abgestürzt — schau dir die Event Logs an,
  was könnte die Ursache sein?
```

Hermes braucht dafür kein Sonderkommando, sondern vier Werkzeuge: `system_health` für Uptime und
Zeitpunkt des letzten Starts, `query_events` (logs `System`, `level=error`) für das Fenster seit
dem Boot, `explain_event_id` für Kernel-Power 41, EventLog 6008 oder Service Control Manager
7000/7031/7034, und `diagnose_service`, wenn ein Dienst der Auslöser war.

Für genau diesen Workflow liegt unter [`skills/windows-triage/SKILL.md`](skills/windows-triage/SKILL.md)
eine Beispiel-Skill bei, die Hermes den Triage-Ablauf beibringt: erst nachschauen, dann behaupten.

```powershell
copy -Recurse skills\windows-triage $env:USERPROFILE\.hermes\skills\
```

Danach steht die Skill in Hermes unter `/windows-triage` zur Verfügung und wird bei passenden
Anfragen automatisch angeboten.

## Konfiguration

| Umgebungsvariable | Vorgabe | Zweck |
|---|---|---|
| `WAMD_PORT` | `8787` | Port des Webinterfaces |
| `WAMD_CONFIG` | `%APPDATA%\windows-admin-mcp\config.json` | Speicherort der Schalter |
| `WAMD_AUDIT` | `%APPDATA%\windows-admin-mcp\audit.jsonl` | Append-only-Audit-Trail |

Die `config.json` wird von der Web-UI geschrieben und enthält `enabledTools`,
`requireApprovalTools`, `maxBulkItems` und `protectedProcesses` (`lsass`, `csrss`, `svchost`,
`winlogon`, `smss`, `services`). Werkzeuge sind per Vorgabe aktiv, damit der Server out of the box
funktioniert; deaktiviert ist erst, was die Datei explizit ausschaltet.

## Entwicklung

```bash
npm run build      # tsc + webui.html nach dist/ kopieren
npm run dev        # bauen und mit node --watch neu starten
npm run typecheck  # tsc --noEmit
npm test           # Smoke-Test: echter Server, echte PowerShell
```

`npm test` führt [`scripts/mcp-smoke.mjs`](scripts/mcp-smoke.mjs): Das Skript spawnt den Server auf
einem freien Port, macht einen echten MCP-Handshake und prüft Werkzeugliste, Validierung,
Approval-Parkierung, `confirm_action` sowie Enable/Disable inklusive `list_changed` — gegen
richtige PowerShell/CIM-Ausgabe, nicht gegen ein Mock.

### Projektstruktur

```
src/
  index.ts                 stdio- und HTTP-Server, MCP-Handler, Bootstrap
  config.ts                Schalter laden/speichern, Änderungen abonnieren
  safety.ts                Approval-Registry: parken, peek/take, Verfall nach 10 min
  audit.ts                 Append-only-JSONL-Trail aller Aufrufe
  types.ts                 ToolDefinition, ToolContext
  data/event-ids.ts        Wissensbasis für explain_event_id
  modules/
    services/              Liste, Zustand, Start/Stopp/Neustart, Startmodus
    events/                Query, Zusammenfassung, Event-ID-Erklärung
    processes/             Prozessliste, Details, Kill, lauschende Ports
    network/               Ping, Port-Test, DNS, Interfaces
    diagnostics/           system_health, diagnose_service, get_windows_update
  utils/
    powershell.ts          Der einzige Ort, der einen Prozess startet
    result.ts              ok/text/fail/pending — einheitliche Ergebnisse
    gate.ts                Approval-Gate für alle destruktiven Werkzeuge
  webui.html               Die komplette Web-UI (kein Build-Schritt nötig)
scripts/
  copy-webui.mjs           src/webui.html → dist/webui.html
  mcp-smoke.mjs            End-to-End über den echten MCP-Transport
  web-check.mjs            HTML, /api/state und die Schalter prüfen
skills/windows-triage/     Beispiel-Skill für Hermes
```

## Anmerkungen

- **Nur Windows.** Benutzt `powershell.exe` (5.1), CIM-Namespaces und die
  `Get-NetTCPConnection`/`Get-WinEvent`-Cmdlets.
- **Zeitfenster.** `query_events` und `summary_events` nehmen `hours` an (Vorgabe 24). Wer einen
  Crash seit dem letzten Boot sucht, setzt `hours` klein genug — ein Datum als Beginn wird erst
  über die PowerShell-Seite intern auf `StartTime` abgebildet.
- **Kosten pro Aufruf.** Jeder Werkzeugaufruf kostet einen PowerShell-Prozess, typisch 0,3–2 s je
  nach Systemlast. `explain_event_id` ist die Ausnahme: reiner Datenlookup, kein Prozessstart.
- **Audit.** Jeder Aufruf — Erfolg wie Misserfolg — wird mit Zeitstempel, Quelle (`mcp` oder
  `web`) und Dauer protokolliert. Die Datei wächst append-only; Rotation ist bislang Aufgabe des
  Betriebes.

## Lizenz

MIT
