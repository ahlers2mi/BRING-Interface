# BRING-Interface

Web Interface für Bring APP

## Features

- **Einkaufsliste importieren** – Artikel (mit optionaler Mengenangabe) in ein Textfeld eingeben und direkt in eine Bring-Liste importieren.
- **Rezeptverwaltung** – Rezepte mit Zutaten speichern und per Klick in eine Bring-Liste importieren.

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
