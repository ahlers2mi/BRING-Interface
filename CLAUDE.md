# BRING-Interface – Projektwissen

Web-Oberfläche für die Bring-Einkaufsliste, dazu Rezeptverwaltung, Wochenplan
mit Würfelfunktion, Reste-Küche und Anbindungen an Mealie, Cookidoo und FHEM.
Läuft als Docker-Stack auf der Synology.

## Aufbau

- **`server.js`** – Express 5 (ESM), alle Routen. Reihenfolge zählt: konkrete
  Pfade müssen **vor** Parameter-Routen stehen (`/api/recipes/add` vor
  `/api/recipes/:id`, sonst hält Express „add" für eine id).
- **`database.js`** – better-sqlite3, Migrationen beim Start. `decorate()` hängt
  an jedes Rezept die Bewertungs-Kennzahlen und `prep_hint`; `getAllRecipes`
  setzt zusätzlich `incomplete`.
- **`lib/`** – `mealie.js` (Spiegelung + Plan-Sync), `cookidoo.js` (spricht mit
  der Brücke), `mealplan.js` (Würfeln, Reste-Suche, Wocheneinkauf),
  `normalize.js` (Zutaten, PLUS-Anriss, Vorlauf-Erkennung), `scale.js`
  (Portionen umrechnen), `climate.js` (Wetter-Gewichtung).
- **`public/js/`** – ES-Module ohne Bauschritt: `core.js` (gemeinsame Helfer und
  `state`), dazu je Tab ein Modul. Neue geteilte Helfer gehören nach `core.js`,
  nicht in ein Tab-Modul.
- **`cookidoo-bridge/`** – eigener Python-Dienst (aiohttp) um die Bibliothek
  `cookidoo-api`. Cookidoo hat keine offizielle Schnittstelle; die Zugangsdaten
  kennt nur die Brücke.
- **`fhem/`** – fertiger Einfügeblock für FHEM und dessen Anleitung.

## Tests

`npm test` (node --test). Zwei Sorten, beide ernst nehmen:

- `test/api.test.js` – echte HTTP-Aufrufe gegen die App. **Achtung:** die Datei
  ersetzt `globalThis.fetch` durch eine Attrappe; im Test immer den Helfer
  `api()` benutzen, nie ein blankes `fetch`.
- `test/frontend.test.js` – prüft die Verdrahtung zwischen HTML und Modulen:
  jede `el('…')`/`on('…')`-id muss es im HTML geben, jedes Listen-Dropdown muss
  in `LIST_SELECT_IDS` stehen, jeder Filter im `recipeFilter` muss ausgewertet
  werden. Diese Tests fangen genau die Fehler, die sonst nur beim Klicken
  auffallen.

Für Oberflächenänderungen lohnt zusätzlich ein Blick mit Playwright
(`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, `--no-sandbox`) gegen
einen Server mit Demo-Datenbank. **Falle:** die Seite registriert einen Service
Worker – Playwright-`route()`-Attrappen greifen dann nicht mehr zuverlässig.
Lieber echte Daten in die Demo-Datenbank schreiben.

## Betrieb auf der NAS (Portainer-Stack aus dem Git-Repo)

- Adresse im LAN: **`http://192.168.69.10:3555`** – das ist `HOST_PORT` aus der
  `docker-compose.yml`. Die **3000 ist nur der Port im Container**; auf
  `192.168.69.10:3000` antwortet ein anderer Dienst mit fremdem `401`.
  Von außen: `https://bring.michael171185.synology.me` (DSM-Reverse-Proxy).
- Stack-Verzeichnis: `/volume2/docker/PORTAINER/compose/8`. Portainer schreibt
  die Stack-Variablen in `stack.env` daneben – eine `.env` aus dem Repo liest
  es **nicht**.
- Neubau von der Shell:

  ```bash
  S=/volume2/docker/PORTAINER/compose/8
  sudo docker compose -p bring-interface \
    --project-directory "$S" --env-file "$S/stack.env" up -d --build
  ```

  Ohne `--env-file` bricht Compose mit `Couldn't find env file: /stack.env` ab.

Drei Fallen, die schon mehrfach Zeit gekostet haben:

- **`--build` ist Pflicht.** `compose up` ohne das startet nur das vorhandene
  Image neu; der Zeitstempel bleibt stehen.
- **„Re-pull image" beim Redeploy auslassen.** Das Image entsteht aus dem
  `Dockerfile` und liegt in keiner Registry → `pull access denied`. Die
  Compose-Datei ist mit `pull_policy: build` und ohne festen `image:`-Namen
  dagegen gerüstet.
- **„Update the stack" holt Git nicht neu** – das tut nur „Pull and redeploy".
  Bricht das ab, bleibt der alte Checkout liegen und jeder Neubau baut
  denselben Commit. Prüfen lässt sich das mit einem `grep` auf eine frische
  Zeile im Checkout; im Notfall den Tarball des Branches über den Ordner
  entpacken (`stack.env` dabei nicht anfassen).

**Woran man erkennt, dass wirklich der neue Stand läuft:** in der Kopfzeile
steht Version und Stand (`v1.7.1 · 09.08., 00:10`) – Version aus der
`package.json`, Zeitstempel von der `server.js` im Image. Auf der
Wandtablet-Seite steht es klein unten. Per Kommandozeile:
`curl -s http://192.168.69.10:3555/api/status?token=… | grep -o '"version":"[^"]*"'`.
Nach jedem Neubau im Browser einmal hart neu laden (Strg+Shift+R), sonst hängt
das alte `style.css`/JS im Cache.

Neue Umgebungsvariablen brauchen `docker compose up -d` – ein `restart`
übernimmt sie **nicht**.

## Mealie

- Läuft im selben Stack (Profil `mealie`), Oberfläche unter
  `https://mealie.michael171185.synology.me`, intern `http://mealie:9000`.
- Rezepte werden in Mealie gepflegt und hier gespiegelt; Wochenplan, Bewertungen
  und Reste-Suche bleiben hier. **Beim Plan gewinnt Mealie** (die Frau des
  Nutzers plant dort).
- Plan-Route je nach Version: erst `/api/households/mealplans`, sonst
  `/api/groups/mealplans` – `mealiePlanPath()` probiert das durch und merkt es
  sich.
- Bilder laufen über `/api/mealie/image/<id>` (Proxy, weil `MEALIE_URL` die
  interne Docker-Adresse ist). Im Browser trägt die angemeldete Sitzung den
  Zugriff; für FHEM/FHEMVIZ müssen die Adressen **absolut und mit Token** sein,
  weil das Dashboard unter einer anderen Adresse läuft (`PUBLIC_URL`).

## PWA / Teilen

- `manifest.webmanifest`, `sw.js`, `icon-192.png`, `icon-512.png` stehen in
  `ALLOW_PATHS` von `auth.js`. **Das muss so bleiben:** Chrome holt das Manifest
  **ohne Cookies** – mit `APP_PASSWORD` kam sonst ein 302 zurück, und die App
  ließ sich ohne Symbol und ohne Teilen-Eintrag installieren.
- Android teilt über `share_target` → `/share`. iOS kann das nicht; dort legt
  man einen Kurzbefehl an, der die URL codiert an `/api/recipes/add` hängt.

## FHEM

Anbindung per HTTPMOD, kein eigenes Modul. Der fertige Block steht in
`fhem/wochenplan.commands.txt`.

- Readings **per `reading..Regex`**, nicht per `..JSON` – sonst kommen Umlaute
  als „Gef?llte Auberginen" heraus (FHEM läuft hier mit `encoding bytes`).
- Der Token hängt als `?token=…` an jeder Adresse. **Steht ein Token wie
  `3GBsicher@BRING` in einem Perl-Block in doppelten Anführungszeichen, hält
  Perl `@BRING` für ein Array** und setzt einen Leerstring ein – dort einfache
  Anführungszeichen nehmen oder `\@` schreiben.
- Die Kachel im Dashboard ist das Widget `mealplan` aus dem Repo `FHEM-FHEMVIZ`
  (`attr <gerät> vizWidget mealplan`, `vizSize 2x2`). Es liest `mo`…`so`,
  `*_sterne`, `*_bild` und `morgen_vorbereitung`.

## Geheimnisse

`API_TOKEN`, Bring-, Mealie- und Cookidoo-Zugangsdaten gehören ausschließlich in
die Stack-Variablen (`stack.env`) – nie ins Repo, auch nicht als Beispielwert.
