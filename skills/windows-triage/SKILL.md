---
name: windows-triage
description: Diagnose a Windows machine that crashed, froze, rebooted itself, or is behaving strangely by reading the local event logs and system health through the winadmin-mcp tools. Use when the user says the system crashed or blue-screened, "ist abgestürzt", restarted on its own, a service died, or asks what caused a Windows outage or why the machine is slow.
version: 0.2.0
platforms: [windows]
metadata:
  hermes:
    category: diagnostics
    tags: [windows, event-log, triage, mcp]
---

# Windows-Triage

Bringt Hermes bei, eine Windows-Maschine anhand von Beweisen zu diagnostizieren statt aus dem
Gedächtnis. Voraussetzung ist ein laufender `winadmin`-MCP-Server; alle genannten Werkzeuge
erscheinen dort mit dem Präfix `mcp_winadmin_`.

## Wann benutzen

- "Mein System ist vorhin abgestürzt / gecrasht."
- "Warum hat der Rechner einfach neu gestartet?"
- "Irgendein Dienst spinnt / ist tot."
- "Der Rechner ist so langsam."

## Vorgehen

Arbeite die Schritte in dieser Reihenfolge ab und urteile erst am Ende.

1. **Bezugspunkt.** `system_health` liefert `uptime_hours` und `last_boot`. Damit ist das
   Zeitfenster definiert: Alles, was der User "vorhin" nennt, liegt nach `last_boot`. Der Rest der
   Ausgabe (CPU-Last, freier Arbeitsspeicher, Datenträger, `error_count_24h`) ist schon der erste
   Verdacht, ob Ressourcen das Problem sind.
2. **Fundstelle.** `query_events` mit `log: "System"`, `level: "error"`,
   `hours` gerade groß genug für das Ereignis, `max_events: 50`. Nur wenn das leer ist, auf
   `hours: 24` erweitern.
3. **Critics getrennt.** Gleicher Aufruf mit `level: "critical"`. Critical-Events sind die
   eigentlichen Absturz-Kandidaten; ein kritischer Eintrag zwei Tage vor dem Boot ist nicht die
   Ursache des aktuellen Problems.
4. **Rauschen einordnen.** `summary_events` (`log: "System"`) zeigt, welcher Provider am häufigsten
   Fehler oder Warnungen meldet. Ein Provider mit 400 DCOM-Einträgen ist Tapete, kein Beweis.
5. **IDs übersetzen.** Jeden relevanten Eintrag mit `explain_event_id` (eine ID pro Aufruf)
   nachschlagen. Häufige Kandidaten:

   | Quelle / Ereignis-ID | Bedeutung |
   |---|---|
   | Kernel-Power 41 | Neustart ohne sauberen Shutdown — Stromweg, Hard-Reset oder Bugcheck |
   | EventLog 6008 | Letztes Herunterfahren war unerwartet |
   | EventLog 6005 / 6006 | Ereignisprotokoll gestartet / sauber beendet |
   | Service Control Manager 7000 | Dienst konnte nicht starten (Abhängigkeit, Pfad, Zugriff) |
   | Service Control Manager 7001 | Dienstabhängigkeit fehlgeschlagen |
   | Service Control Manager 7031 / 7034 | Dienst unerwartet beendet — kein Stopp, sondern Absturz |
   | Service Control Manager 7009 / 7011 | Timeout beim Start bzw. bei einer Service-Steueranfrage |
   | DCOM 10010 / 10016 | DCOM-Server nicht rechtzeitig registriert / Zugriff verweigert — meist Rauschen |

6. **Dienst rekonstruieren.** Bei 7000/7031/7034 den betroffenen Dienst mit `diagnose_service`
   prüfen: aktueller Zustand, Startmodus, Prozess, Abhängigkeiten und die letzten Logeinträge, die
   den Dienst erwähnen. Bei zwei Tagen Logmaterial ist das meist die vollständige Geschichte.
7. **Ressourcen.** `list_processes` mit `sort: "cpu"` und noch einmal mit `sort: "memory"`
   (Vorgabe) zeigt, ob ein Ausreißer das Muster erklärt. `get_process` für einen namentlich
   bekannten Übeltäter.
8. **Erst jetzt urteilen.** Ursache, Beweis (Protokoll, Quelle, ID, Zeitstempel) und empfohlene
   Maßnahme — in dieser Reihenfolge.

## Vertiefung

Wenn die Basis-Triage keine Ursache ergibt, nach derselben Logik weiterbohren — jedes Werkzeug
zählt nur, wenn das vorherige nichts gebracht hat:

- **Vorher gelernt?** `list_learnings` (oder gleich `search_events` mit Worten aus der Meldung)
  vor jeder eigenen Analyse. Ein Eintrag mit verdict `benign` ist eine fertige Antwort, kein
  Grund für eine Suche. Steht die Entscheidung fest, mit `add_learning` notieren
  (`note` in normalem Deutsch/Englisch, `verdict`, `event_id` wenn bekannt).
- **Hat sich was geändert?** `system_changes` (Standard 7 Tage) listet installierte Hotfixes und
  Programme — "was ging dem Crash voraus". `error_trends` zeigt pro Provider, ob die Fehler
  wachsen, schrumpfen oder gleich sind; ein Provider, der nur im aktuellen Fenster auftaucht
  (`new`), ist meist der interessanteste Fund.
- ** Läuft alles, was laufen sollte?** `services_watch` liefert die Autostart-Dienste, die nicht
  laufen. `service_restarts` findet Dienste, die im Fenster mehrfach gestoppt wurden
  (Crash-Loop).
- **Neues seit dem letzten Blick?** `events_watch` gibt nur die Events **seit dem letzten Aufruf**
  zurück (Watermark pro Log und Level). Ideal zum Pollen; `reset: true` vergisst den Watermark.
- **Geplante Aufgaben.** Wenn ein Wartungsjob nicht lief: `list_tasks` (`name` als
  Teilzeichenkette), dann `get_task` für Definition/Konto/letztes Ergebnis, `task_history` für
  die Laufhistorie. Ergebniscode `0` = Erfolg, `0x41303` = läuft noch, `0x41306` = abgebrochen.
- **Registry-Verdacht.** `read_registry_key` liest Werte samt Typ (Zahlen zusätzlich als Hex).
  Schreiben (`write_registry_value`) exportiert den Schlüssel vorher als `.reg` — der Pfad der
  Sicherung steht in der Antwort.
- **Security-Oberfläche.** `check_elevation` vor jedem Schreibversuch klären (Serverprozess,
  nicht User). `get_security_events` filtert das Security-Log auf Logon-/Prozess-/Privileg-
  Ereignisse und erklärt jede ID. `analyze_pe` für eine verdächtige Datei ohne sie auszuführen.
- **Mailed Logs.** `.evtx` von einem anderen Rechner mit `parse_evtx` lesen, statt zu raten.

## Regeln

## Regeln

- **Nur lesen.** Für diese Triage keine `start_service`-, `stop_service`- oder `kill_process`-
  Aktion auslösen. Wenn eine Aktion sinnvoll ist, dem User vorschlagen statt sie eigenmächtig
  auszuführen.
- **Approval-Gate.** Steht ein Tool auf Approval, fragt der Server zuerst im Agenten (Popup in
  `hermes --tui`), und das Ergebnis kommt im selben Aufruf zurück. Kann der Client kein Popup
  zeigen, parkt die Aktion mit `confirmation_id` — und dann gilt: **nie die eigene geparkte
  Aktion selbst bestätigen**, sonst ist das Gate wirkungslos. Lieber dem User sagen, dass die
  Aktion im Web-Interface auf Run wartet, und jede ungeklärte Park-Runde erhöht nur die Pending-
  Liste.
- **Zeitfenster ehrlich halten.** "Vorhin" heißt seit `last_boot`, "heute" heißt seit Mitternacht.
  Das verwendete Fenster in der Antwort nennen, damit der User das Urteil nachprüfen kann.
- **Nicht über unbekannte IDs spekulieren.** `explain_event_id` antwortet auch für unbekannte IDs
  (`No entry for event id …`); dann offen sagen, dass die Nummer nicht bekannt ist, statt einen
  Text zu erfinden.
- **Ein leeres Ergebnis ist eine Antwort.** Keine Fehler im System-Log seit dem Boot heißt
  wahrscheinlich: der Absturz hat kein Event geschrieben. Dann `Application` und
  `get_windows_update` ansehen und das Ergebnis als "kein Hinweis im System-Log" formulieren, nicht
  als "kein Problem".
- **Ausgaben kürzen.** `max_events` begrenzt die Menge; JSON-Blöcke nicht ungefiltert
  wiedergeben, sondern die drei bis fünf relevanten Einträge hervorheben.

## Beispiel

> **User:** hey hermes, mein System ist vorhin gecrasht, check mal die Eventlogs was die Ursache
> sein könnte

`system_health` → Uptime 0,7 h, letzter Boot 14:18 → `query_events(log: "System", level: "error",
hours: 1)` → ein Treffer Service Control Manager 7034 um 14:31 → `explain_event_id(7034)` und
`explain_event_id(7000)` → `diagnose_service("Spooler")`.

> **Antwort:** Kein Bluescreen: der Druckspooler wurde um 14:31 unerwartet beendet (System, Service
> Control Manager, Ereignis 7034). Kernel-Power 41 fehlt im Fenster seit dem Boot um 14:18, das
> System ist also danach sauber hochgefahren. Der Dienst läuft inzwischen wieder, hat aber
> Startmodus "Manuell" — ich würde den Startmodus auf "Automatisch" setzen, das mache ich aber nur
> auf Zuruf.
