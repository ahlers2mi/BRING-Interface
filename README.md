# BRING-Interface

Web Interface für Bring APP

## Features

- **Einkaufsliste importieren** – Artikel (mit optionaler Mengenangabe) in ein Textfeld eingeben und direkt in eine Bring-Liste importieren.
- **KI-Hilfe für die Einkaufsliste** – unsauberen Freitext aufräumen lassen oder ein **Foto** der Einkaufsliste hochladen; die KI (über OpenRouter) erkennt die Artikel automatisch.
- **Rezeptverwaltung** – Rezepte mit Zutaten, Tags, Portionen, Link, Zubereitung und voraussichtlicher Zeit speichern und per Klick in eine Bring-Liste importieren.
- **Wochenplan mit Würfelfunktion** – einzelne Tage oder die ganze Woche auswürfeln lassen, Tage von Hand belegen und die Zutaten der kompletten Woche in einem Schritt nach Bring schieben.
- **Bewertungen** – nach dem Essen „lecker / gut / ok / mies" vergeben, oder ein Rezept als **rausgeflogen** markieren (gar nicht gekocht) bzw. mit **nie wieder** dauerhaft sperren.
- **Gelernter Geschmack** – aus den Bewertungen entsteht ein Profil beliebter und unbeliebter Zutaten und Kategorien; der Würfel bevorzugt, was ankommt, und meidet, was durchgefallen ist.
- **Mealie-Anbindung** (optional) – [Mealie](https://mealie.io) als Rezeptquelle: Rezepte dort pflegen, hier spiegeln; Bewertungen wandern als `rating`/`lastMade` zurück.
- **Rezept-Import** – einzelne Rezepte per Link (Chefkoch und alle Seiten mit schema.org-Daten) oder **Massenimport von chefkoch.de** (z. B. 200 Rezepte auf einmal, im Hintergrund mit Fortschrittsanzeige).
- **Reste-Küche** – eingeben, was noch im Kühlschrank liegt, und passende Rezepte nach Abdeckung sortiert finden; fehlende Zutaten wandern auf Wunsch direkt nach Bring.
- **KI-Rezeptanalyse** – kompletten Rezepttext einfügen; ein KI-Modell (über [OpenRouter](https://openrouter.ai/)) extrahiert automatisch Name, Beschreibung und Zutaten (mit Mengen) zum Prüfen und Speichern.
- **FHEM/FHEMVIZ-Anbindung** – Wochenplan als HTTPMOD-Gerät mit Readings, Würfeln und Bewerten per `set`; siehe [`fhem/README.md`](fhem/README.md).

## Voraussetzungen

- [Node.js](https://nodejs.org/) ≥ 18
- Ein Bring!-Konto

## Installation

```bash
# Abhängigkeiten installieren
npm install

# Konfigurationsdatei anlegen
cp .env.example .env
# .env öffnen und BRING_MAIL + BRING_PASSWORD eintragen

# Server starten
npm start
```

Der Server läuft dann unter **http://localhost:3000**.

## Docker

Die App lässt sich als Docker-Container betreiben. Auf dem Docker-Host muss nur
Docker (bzw. Docker Engine) installiert sein – das Image wird beim Build erzeugt.

### Variante A: Docker Compose (empfohlen)

```bash
# .env mit BRING_MAIL und BRING_PASSWORD anlegen (siehe .env.example)
cp .env.example .env

# Image bauen und Container starten
docker compose up -d --build
```

Die App ist anschließend unter **http://<host>:8095** erreichbar (`HOST_PORT`
in der `.env` änderbar; Port 3000 gilt nur *innerhalb* des Containers und ist
auf einer Synology häufig schon von einem anderen Dienst belegt). Die
SQLite-Datenbank liegt im benannten Volume `bring-data` und bleibt damit über
Neustarts und Updates hinweg erhalten.

> Neue oder geänderte Werte in der `.env` (z. B. `API_TOKEN`) kommen erst mit
> `docker compose up -d` im Container an – ein bloßes `restart` genügt nicht.

### Portainer (Stack aus dem Git-Repo)

Das Image wird hier **aus dem Dockerfile gebaut** und liegt in keiner Registry.
Deshalb beim Deploy/Redeploy die Option **„Re-pull image"** bzw. „Pull latest
image" **aus**lassen – sonst versucht Portainer `docker compose pull` und
bricht ab mit:

```
pull access denied for bring-interface, repository does not exist
```

Die `docker-compose.yml` ist dafür schon vorbereitet (kein fester `image:`-Name,
`pull_policy: build`). Bei automatischen Updates (GitOps) gilt dasselbe: nur
„Re-deploy", nicht „Re-pull".

Die Umgebungsvariablen trägt man in Portainer als Stack-Variablen ein (gleiche
Namen wie in der `.env`) – **eine `.env` aus dem Repo liest Portainer nicht**,
die ist gar nicht eingecheckt. Portainer schreibt die Werte in eine `stack.env`
neben die Stack-Dateien.

Zwei Fallen beim Aktualisieren:

- **„Update the stack" holt Git nicht neu.** Den aktuellen Repo-Stand zieht nur
  „Pull and redeploy" (GitOps-Bereich) – oder ein neu angelegter Stack. Bricht
  „Pull and redeploy" ab, bleibt der alte Checkout liegen und jeder Redeploy
  baut wieder denselben Commit.
- **`compose up` baut nur, wenn das Image fehlt.** Ohne `--build` startet ein
  Redeploy einfach das alte Image – erkennbar an unverändertem Zeitstempel und
  gleicher Image-ID. Erzwingen lässt es sich mit gelöschtem Image oder von der
  Shell aus:

  ```bash
  S=<Portainer-Datenpfad>/compose/<stack-id>      # z. B. /volume2/docker/PORTAINER/compose/8
  sudo docker compose -p <stackname> --project-directory "$S" --env-file "$S/stack.env" up -d --build
  ```

Woran man erkennt, dass wirklich der neue Stand läuft:

```bash
docker exec bring-interface printenv API_TOKEN     # Token da?
docker exec bring-interface grep -c api/fhem server.js   # > 0 = Wochenplan drin
```

```bash
docker compose logs -f      # Logs ansehen
docker compose down         # Container stoppen
```

### Variante B: Reines Docker (ohne Compose)

```bash
# Image bauen
docker build -t bring-interface .

# Volume für die persistente Datenbank anlegen
docker volume create bring-data

# Container starten
docker run -d \
  --name bring-interface \
  --restart unless-stopped \
  -p 3000:3000 \
  -e BRING_MAIL="deine@email.de" \
  -e BRING_PASSWORD="deinPasswort" \
  -v bring-data:/data \
  bring-interface
```

> Hinweis: Im Container wird die Datenbank über die Umgebungsvariable `DB_PATH`
> nach `/data/recipes.db` gelegt. Das Volume `bring-data` sorgt dafür, dass die
> Rezepte dauerhaft gespeichert bleiben.

## Konfiguration (`.env`)

| Variable         | Beschreibung                          |
|-----------------|---------------------------------------|
| `BRING_MAIL`    | E-Mail-Adresse des Bring-Kontos       |
| `BRING_PASSWORD`| Passwort des Bring-Kontos             |
| `PORT`          | Port des Webservers (Standard: 3000)  |
| `DB_PATH`       | Pfad zur SQLite-Datei (Standard: `recipes.db`, im Container `/data/recipes.db`) |
| `OPENROUTER_API_KEY` | API-Schlüssel für die KI-Rezeptanalyse ([openrouter.ai/keys](https://openrouter.ai/keys)). Ohne den Schlüssel funktioniert die App weiter, nur die KI-Analyse ist deaktiviert. |
| `OPENROUTER_MODEL` | Optional: KI-Modell für die Analyse (Standard: `openai/gpt-4o-mini`). Muss strukturierte JSON-Ausgaben unterstützen. |
| `APP_PASSWORD` | Gemeinsames Passwort für den Zugriff. Leer = **kein** Schutz (nur für rein lokalen/VPN-Betrieb). Bei öffentlichem Zugriff zwingend setzen. |
| `APP_SECRET` | Optional: Schlüssel zum Signieren der Session-Cookies (sonst aus `APP_PASSWORD` abgeleitet). |
| `API_TOKEN` | Token für Maschinen-Zugriffe auf `/api/…` (FHEM, Skripte) – als `?token=…`, Header `X-API-Token` oder `Authorization: Bearer …`. Leer = aus. Am besten ohne `&`, `#` oder `+`, damit der Wert unverändert in eine URL passt. |
| `HOST_PORT` | Nur `docker-compose.yml`: Port auf der NAS (Standard 8095) – im Container bleibt es 3000. |
| `MEALIE_URL` | Basis-URL einer Mealie-Instanz. Gesetzt = Mealie ist die Rezeptquelle (siehe unten). |
| `MEALIE_TOKEN` | API-Token aus Mealie („Manage Your API Tokens"). |
| `MEALIE_SYNC_MINUTES` | Abgleich-Intervall in Minuten (Standard 15). |
| `MEALIE_PUSH_RATINGS` | Bewertungen als `rating`/`lastMade` nach Mealie zurückschreiben (Standard an, `0` = aus). |
| `MEALIE_RECIPE_URL` | Muster für den Link in die Mealie-Oberfläche (Standard `{base}/g/home/r/{slug}`). |
| `IMPORT_DELAY_MS` | Pause zwischen den Abrufen beim Rezept-Import (Standard 250 ms – bitte nicht zu klein wählen). |
| `IMPORT_CONCURRENCY` | Parallele Abrufe beim Massenimport (Standard 3). |
| `IMPORT_TIMEOUT_MS` | Timeout je Abruf beim Import (Standard 20000). |

## Sicherheit / externer Zugriff

Die App hat **keine** eingebaute Mehrbenutzer-Verwaltung. Für den Zugriff von außen:

1. **`APP_PASSWORD` setzen** – schützt die gesamte App mit einem gemeinsamen Passwort (Session-Cookie, 30 Tage, Brute-Force-Bremse).
2. **HTTPS ist Pflicht** – ein Passwort über reines HTTP wäre im Klartext im Netz. Stelle der App einen **Reverse Proxy mit TLS** voran (z. B. Synology-Reverse-Proxy mit Let's Encrypt) und gib nach außen **nur Port 443** frei, nicht den Container-Port.
3. **Noch sicherer:** gar nicht öffentlich exponieren, sondern per **VPN** (z. B. WireGuard auf der UniFi UDR) zugreifen.

## Wochenplan & Würfel

Der Würfel zieht gewichtet, nicht gleichverteilt:

- **eigene Bewertung**: 5★ ist rund 20× wahrscheinlicher als 1★, „nie wieder" fällt ganz heraus
- **rausgeflogen** (nicht gekocht) dämpft ein Rezept stark, löscht es aber nicht
- **Geschmacksprofil**: Zutaten und Kategorien, die in anderen Rezepten gut/schlecht bewertet wurden, wirken mit (±)
- **Abwechslung**: was in den letzten 7/14/28 Tagen gekocht wurde, kommt seltener; innerhalb einer Woche möglichst kein Gericht doppelt
- **Neugier**: noch unbewertete Rezepte bekommen einen kleinen Bonus

Reichen die Kandidaten nicht (kleine Sammlung), werden die Regeln
schrittweise gelockert, statt gar nichts vorzuschlagen. Als **gekocht**
markierte Tage bleiben beim Neuwürfeln unangetastet.

## Mealie als Rezeptquelle (optional)

Sind `MEALIE_URL` und `MEALIE_TOKEN` gesetzt, ist [Mealie](https://mealie.io)
die Wahrheit für Rezepte: gepflegt wird dort, diese App **spiegelt** sie.

Warum ein Spiegel und keine Durchreiche bei jedem Klick: Bewertungen und
Wochenplan zeigen per Fremdschlüssel auf `recipes.id`, und Würfeln wie
Reste-Suche rechnen in SQL über die Zutaten. Der Spiegel hält das intakt, die
Oberfläche bleibt schnell, und wenn Mealie gerade nicht läuft, funktionieren
Wochenplan und FHEM weiter.

- **Abgleich** beim Start, im Intervall (`MEALIE_SYNC_MINUTES`, Standard 15) und
  per Knopf „Jetzt abgleichen". Details werden nur für neue oder geänderte
  Rezepte geladen (Vergleich über `updatedAt`), 500 Rezepte sind also kein Problem.
- **Lokale Rezeptpflege ist dann gesperrt** (`409` mit Hinweis) und die
  entsprechenden Karten sind ausgeblendet – Änderungen hier würde der nächste
  Abgleich ohnehin überschreiben. Jede Rezeptkarte bekommt einen „In Mealie"-Knopf.
- **Bewertungen bleiben hier** (Mealie kennt „rausgeflogen" und „nie wieder"
  nicht), werden aber als `rating` und `lastMade` nach Mealie zurückgeschrieben –
  best-effort, ein Fehler dort verhindert die Bewertung hier nicht.
  Abschaltbar mit `MEALIE_PUSH_RATINGS=0`.
- **In Mealie gelöschte Rezepte** bleiben im Spiegel stehen (daran hängen
  Bewertungen und die Plan-Historie), werden markiert und nicht mehr gewürfelt.
- Übernommen werden Name, Beschreibung, Zutaten (aus `food`/`unit`/`quantity`,
  sonst der Freitext), Zubereitung, Zeiten, Portionen, Tags und Kategorien,
  Bild und die Quell-URL (`orgURL`).

```
MEALIE_URL=http://192.168.69.10:9925
MEALIE_TOKEN=<Token aus "Manage Your API Tokens">
```

> Der Link auf ein Rezept in Mealie folgt `MEALIE_RECIPE_URL`
> (Standard `{base}/g/home/r/{slug}`); ältere Mealie-Versionen brauchen
> `{base}/recipe/{slug}`.

## Rezept-Import

- **Einzelnes Rezept per Link**: liest die schema.org-Daten (`Recipe`) der Seite –
  funktioniert bei Chefkoch (dort zuerst über die JSON-API) und den meisten
  anderen Rezeptseiten. Optional als Rückfall die KI-Analyse des Seitentexts.
- **Massenimport von chefkoch.de**: Suchbegriff (oder leer für beliebte Rezepte)
  und Anzahl angeben. Der Lauf passiert im Hintergrund mit Fortschritt und
  Protokoll, lässt sich abbrechen und überspringt bereits vorhandene Rezepte
  (Erkennung über `chefkoch:<id>` und den Rezeptnamen).

> Zwischen den Abrufen liegt eine Pause (`IMPORT_DELAY_MS`), damit der Import
> die Quelle nicht belastet. 200 Rezepte dauern damit einige Minuten.
> Der Server muss `chefkoch.de` erreichen können.

## Reste-Küche

Reste eintragen (eine Zutat pro Zeile) → Rezepte werden nach **Abdeckung**
sortiert, fehlende Zutaten stehen dabei. Der Vergleich normalisiert Umlaute,
Singular/Plural und deutsche Komposita („Hähnchenbrust" trifft
„Hähnchenbrustfilet"). Vorräte wie Salz, Öl oder Zwiebeln gelten per Haken als
vorhanden. Die Eingabe wird **nicht** gespeichert.

## Entwicklung

```bash
# Server mit Auto-Reload starten
npm run dev

# Tests (Wochenlogik, Zutaten-Matching, Würfelgewichte, Import-Parser, HTTP-API)
npm test
```

## Technischer Überblick

| Schicht    | Technologie                                      |
|-----------|--------------------------------------------------|
| Backend   | [Express](https://expressjs.com/) (Node.js ESM)  |
| Bring API | [bring-shopping](https://www.npmjs.com/package/bring-shopping) |
| Datenbank | SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) |
| Frontend  | Vanilla HTML / CSS / JavaScript (ES-Module)      |
| Tests     | `node --test` (ohne weitere Abhängigkeiten)      |

### Aufbau

```
server.js          HTTP-Routen (Bring, Rezepte, Plan, Import, FHEM)
database.js        SQLite-Schema, Migrationen und Abfragen
auth.js            Passwortschutz + API-Token
lib/week.js        Kalenderwochen- und Datumsrechnerei
lib/normalize.js   Zutaten normalisieren und vergleichen
lib/taste.js       Geschmacksprofil und Würfelgewichte
lib/mealplan.js    Wochenplan, Reste-Suche, Wocheneinkauf
lib/recipe-import.js  Chefkoch-API, schema.org-Parser, Import-Job
lib/mealie.js      Mealie-Anbindung: Abgleich, Abbildung, Bewertungs-Rückschreibung
public/js/*.js     Oberfläche je Tab (core, shopping, plan, recipes, fridge)
fhem/              Fertiger FHEM-Block + Anleitung
```
