# BRING-Interface

Web Interface für Bring APP

## Features

- **Einkaufsliste importieren** – Artikel (mit optionaler Mengenangabe) in ein Textfeld eingeben und direkt in eine Bring-Liste importieren.
- **KI-Hilfe für die Einkaufsliste** – unsauberen Freitext aufräumen lassen oder ein **Foto** der Einkaufsliste hochladen; die KI (über OpenRouter) erkennt die Artikel automatisch.
- **Rezeptverwaltung** – Rezepte mit Zutaten, Link, Zubereitung und voraussichtlicher Zeit speichern und per Klick in eine Bring-Liste importieren.
- **KI-Rezeptanalyse** – kompletten Rezepttext einfügen; ein KI-Modell (über [OpenRouter](https://openrouter.ai/)) extrahiert automatisch Name, Beschreibung und Zutaten (mit Mengen) zum Prüfen und Speichern.

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

Die App ist anschließend unter **http://<host>:3000** erreichbar. Die
SQLite-Datenbank liegt im benannten Volume `bring-data` und bleibt damit über
Neustarts und Updates hinweg erhalten.

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

## Sicherheit / externer Zugriff

Die App hat **keine** eingebaute Mehrbenutzer-Verwaltung. Für den Zugriff von außen:

1. **`APP_PASSWORD` setzen** – schützt die gesamte App mit einem gemeinsamen Passwort (Session-Cookie, 30 Tage, Brute-Force-Bremse).
2. **HTTPS ist Pflicht** – ein Passwort über reines HTTP wäre im Klartext im Netz. Stelle der App einen **Reverse Proxy mit TLS** voran (z. B. Synology-Reverse-Proxy mit Let's Encrypt) und gib nach außen **nur Port 443** frei, nicht den Container-Port.
3. **Noch sicherer:** gar nicht öffentlich exponieren, sondern per **VPN** (z. B. WireGuard auf der UniFi UDR) zugreifen.

## Entwicklung

```bash
# Server mit Auto-Reload starten
npm run dev
```

## Technischer Überblick

| Schicht    | Technologie                                      |
|-----------|--------------------------------------------------|
| Backend   | [Express](https://expressjs.com/) (Node.js ESM)  |
| Bring API | [bring-shopping](https://www.npmjs.com/package/bring-shopping) |
| Datenbank | SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) |
| Frontend  | Vanilla HTML / CSS / JavaScript                  |
