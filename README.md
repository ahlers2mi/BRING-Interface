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

## Konfiguration (`.env`)

| Variable         | Beschreibung                          |
|-----------------|---------------------------------------|
| `BRING_MAIL`    | E-Mail-Adresse des Bring-Kontos       |
| `BRING_PASSWORD`| Passwort des Bring-Kontos             |
| `PORT`          | Port des Webservers (Standard: 3000)  |

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
