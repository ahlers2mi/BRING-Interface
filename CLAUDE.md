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
  (Portionen umrechnen), `climate.js` (Wetter-Gewichtung), `course.js`
  (Abendessen oder nur Dip/Beilage/Dessert), `site-import.js` + `site-job.js`
  (Rezepte von einer beliebigen Koch-Seite einsammeln).
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

**Container erreicht die NAS nicht:** `UND_ERR_CONNECT_TIMEOUT` auf eine
`192.168.x`-Adresse heißt nicht „falsche Adresse" (das wäre `ENOTFOUND`) und
auch nicht „Dienst aus" (`ECONNREFUSED`), sondern: die DSM-Firewall lässt das
Docker-Netz nicht auf einen Port der NAS. Ausgehend ins Internet geht trotzdem,
das läuft über NAT. Lösung: ein **eigenes** Netz nur für Mealie
(`docker-compose.mealie-extern.yml`, von beiden Stacks eingebunden), dann wieder
Dienstnamen benutzen. `network_mode: host` ist keine Lösung – damit fällt die
Port-Abbildung weg.

**Portainer: der Zusatz gehört in „Additional paths".** Das Feld „Compose path"
nimmt nur EINEN Pfad – zwei hineinzuschreiben läuft fehlerfrei durch und lässt
den Zusatz trotzdem weg. `include:` ist hier **kein** Ausweg: Compose verbietet
es, einen importierten Dienst zu erweitern
(`services.bring-interface conflicts with imported resource`).

Zum Nachmessen im Container: das Laufzeit-Image ist `node:20-bookworm-slim` und
hat **weder `wget` noch `curl`**. Stattdessen
`docker exec <container> node -e "fetch('…').then(…)"` – der Fehlercode steht
dort in `e.cause.code`.

**Nicht das Standardnetz der ersten Instanz teilen:** Dienstnamen sind je Stack
gleich (`cookidoo-bridge`, `mealie`, `bring-interface`). Hängen zwei Stacks im
selben Netz, ist die Auflösung mehrdeutig – die zweite Instanz landet mit
`http://cookidoo-bridge:8099` womöglich in der fremden Brücke, also im fremden
Cookidoo-Konto. Eigene Dienste dort über den **Container**-Namen ansprechen
(`COOKIDOO_CONTAINER_NAME`), der ist hostweit eindeutig.

**Ein zweiter Haushalt bekommt eine eigene Instanz**, keine Mehrbenutzer-App.
Die fünf Tabellen haben keine Besitzer-Spalte, und Bring/Mealie/Cookidoo kommen
aus der Umgebung – Mandantenfähigkeit wäre ein Umbau quer durch alles. Zweiter
Stack aus demselben Repo, eigene Werte für `CONTAINER_NAME` (Docker-Namen sind
hostweit eindeutig!), `HOST_PORT`, `DATA_PATH`, `APP_PASSWORD`, `API_TOKEN` und
die Bring-Zugangsdaten. Anleitung im README.

**Woran man erkennt, dass wirklich der neue Stand läuft:** in der Kopfzeile
steht Version und Stand (`v1.7.1 · 09.08., 00:10`) – Version aus der
`package.json`, Zeitstempel von der `server.js` im Image. Auf der
Wandtablet-Seite steht es klein unten. Per Kommandozeile:
`curl -s http://192.168.69.10:3555/api/status?token=… | grep -o '"version":"[^"]*"'`.
Nach jedem Neubau im Browser einmal hart neu laden (Strg+Shift+R), sonst hängt
das alte `style.css`/JS im Cache.

Neue Umgebungsvariablen brauchen `docker compose up -d` – ein `restart`
übernimmt sie **nicht**.

## Würfeln: Abendessen vs. Beilage

`lib/course.js` sortiert Dips, Beilagen, Kuchen aus. Grundlage sind die
**Mealie-Kategorien** – `recipeCategory` landet in `mapMealieRecipe` zusammen mit
den Tags in unserem `tags`-Feld, ausgewertet wird also beides. Reihenfolge:
Spalte `course` am Rezept (von Hand) → Haupt-Liste → Beilagen-Liste → Name →
sonst Abendessen.

Der Namens-Notnagel ist absichtlich klein. Zwei Fallen, die beim ersten Versuch
zugeschnappt sind: eine reine Endungsprüfung macht aus „Nudeln mit Pesto" eine
Beilage (deshalb die Verbindungswörter `mit`/`und`/`an` …), und `kuchen`/`eis`
in der Liste erwischen Zwiebelkuchen, Flammkuchen, Eisbein und Milchreis –
deshalb stehen sie **nicht** drin. Was die Endung nicht trifft, fangen die
Kategorien; im Zweifel wird gewürfelt.

## Geschmacksprofil (`lib/taste.js`)

Zwei getrennte Hebel, die man nicht verwechseln darf:

- **Das Rezept selbst** – `ownRatingFactor`. `rating_count` zählt in
  `ratingStats()` **nur gekochte Bewertungen mit Sternen**; ein bloß
  aussortiertes Rezept steht dort auf 0. Der `rausgeflogen`-Abzug
  (`0.25 ** anzahl`, Untergrenze 0.1) muss deshalb **vor** dem Neugier-Bonus
  greifen – sonst bekommt ausgerechnet das weggeklickte Rezept die 1.3 für
  „noch nie probiert" und wird nie seltener. Genau dieser Fehler steckte bis
  v1.14.2 drin: 0/1/2 Absagen ergaben alle das Gewicht 1.300.
- **Die Zutaten** – `buildTasteProfile`. Beleg wird in **Gewicht** gemessen,
  nicht in Köpfen (`MIN_EVIDENCE = 1.5`, `confidence = weight/(weight+2)`).
  Eine gekochte Bewertung wiegt 1.0, ein `rausgeflogen` nur 0.6. Zwei Absagen
  sind also 1.2 und kommen gar nicht erst ins Profil, zwei gekochte
  Bewertungen (2.0) schon. Sonst brandmarkt ein einziges Aufräumen am Abend
  eine ganze Zutat („Wir mögen keine Gnocchi").

Strukturelle Tags (`Hauptgerichte`, `Thermomix`, `Cookidoo` …) stehen in
`IGNORED_TAGS` und sind vom Profil ausgenommen – sie hängen an fast jedem
Rezept und würden bei einer einzigen Absage eine ganze Gattung abwerten. Die
Gang-Listen kommen aus `course.js`, damit es nur eine Quelle gibt.

## Rezepte von fremden Koch-Seiten

`site-import.js` sammelt Links einer Übersichtsseite ein, `site-job.js` legt sie
an. Bewusst **keine Seite fest verdrahtet**: welche Links Rezepte sind,
entscheidet ein Anlesen der jeweiligen Seite (schema.org-`Recipe` vorhanden?).
Das kostet einen Abruf je Kandidat, ist dafür gegen jedes Layout immun und
gegen Umbauten der Quelle robust.

Ist Mealie an, geht die Adresse an `/api/recipes/create/url` – Mealies
`recipe-scrapers` kennt mehr Seiten als unser JSON-LD-Leser. Ohne Mealie wird
das beim Prüfen ohnehin gelesene Rezept direkt angelegt (`source: web`).

Der `dryRun` ist wichtig: gegen eine unbekannte Seite ist er die einzige
ehrliche Auskunft, ob sie sich einlesen lässt.

## Rezepte aus Kochvideos (`lib/video-import.js`)

YouTube liefert **kein** schema.org-`Recipe` – der normale Importer und auch
Mealies `recipe-scrapers` laufen dort ins Leere. Zu holen ist trotzdem viel:

- Titel, Kanal, Länge und Vorschaubild stehen im `ytInitialPlayerResponse` der
  Watch-Seite. Geschnitten wird das mit `sliceJsonObject()` (**Klammern zählen**,
  kein `/\{.*\}/` – der Block enthält selbst Klammern in Zeichenketten).
- Die **Beschreibung** (`videoDetails.shortDescription`) ist die beste Quelle:
  bei Kochkanälen steht das Rezept dort meist vollständig. Rückfall, falls
  YouTube das Objekt umbaut: dieselbe Zeichenkette per Regex aus dem Quelltext.
- Ohne Zutatenliste in der Beschreibung kommen die **Untertitel** dazu
  (`captions.playerCaptionsTracklistRenderer.captionTracks[].baseUrl` + `&fmt=json3`).
  Deutsch vor Englisch, selbst geschriebene Spur vor `kind: 'asr'`. Scheitert
  der Abruf, ist das kein Fehler – Untertitel sind Beigabe.
- Das XML-Format der Untertitel ist **doppelt maskiert** (`&amp;#39;` für ein
  Apostroph), deshalb nach `stripHtml` noch ein `decodeEntities`.

Zwei Fallen, die beim Bauen zugeschnappt sind:

- **Die Videolänge ist keine Kochzeit.** `videoRecipeBase()` setzt bewusst kein
  `prep_time` – sonst wäre ein 9-Minuten-Video ein 9-Minuten-Gericht und würde
  das Zeitlimit beim Würfeln verfälschen.
- **„20 Minuten bei 200 Grad backen" fängt genauso mit einer Zahl an wie
  „500 g Gnocchi".** `looksLikeIngredientLine()` prüft deshalb die **Rohzeile**
  auf Zeit-/Temperaturangaben, nicht das Ergebnis von `splitAmount`: das hält
  bei „200 Grad" das „G" für Gramm und lässt „rad Umluft vorheizen" übrig.

**Dublettenschlüssel:** `addRecipeByUrl` nimmt beim Video die **Video-Kennung**,
nicht die Adresse. Der alte `url.split('?')[0]` ließ von `watch?v=…` nur
`https://www.youtube.com/watch` übrig – das steckt in jedem Video-Rezept, jedes
weitere Video galt also als „kennen wir schon". Die Kennung fängt umgekehrt
`youtu.be/<id>` und `watch?v=<id>` als dasselbe Video.

**Nachträglich anreichern:** `POST /api/recipes/:id/enrich` liest die Quelle des
Rezepts erneut (Video, Chefkoch, schema.org) und füllt Lücken; `overwrite: true`
ersetzt. Der **Name wird bewusst nicht überschrieben** – daran hängen Plan,
Bewertungen und die Wiedererkennung. Bei Mealie-Rezepten geht das über
`enrichRecipeInMealie()` (PATCH + Bild-POST), danach wird der Spiegel sofort
aufgefrischt. Das alte `/api/mealie/repair` bleibt für den Sammellauf über die
PLUS-Anrisse, kann aber nur Chefkoch.

Strukturiert wird der Text mit `analyzeRecipeText()` (OpenRouter), wenn ein
Schlüssel da ist, sonst mit `recipeFromText()`. Findet keiner der beiden eine
Liste, wirft `recipeFromVideo()` einen Fehler mit `status 422` **und dem Text am
Fehlerobjekt** – `apiFetch` hängt den ganzen Antwortkörper an den Fehler, die
Oberfläche legt den Text ins Feld „Rezepttext". Läuft Mealie, wird das Ergebnis
mit `createRecipeInMealie()` dort angelegt (POST nur mit Namen, alles andere per
PATCH), damit Mealie die eine Quelle bleibt.

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
