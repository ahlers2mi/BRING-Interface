# BRING-Interface

Web Interface für Bring APP

## Features

- **Einkaufsliste importieren** – Artikel (mit optionaler Mengenangabe) in ein Textfeld eingeben und direkt in eine Bring-Liste importieren.
- **Bring-Liste bearbeiten** – die aktuelle Liste direkt in der App: Artikel hinzufügen, Mengen ändern, abhaken (wie in der Bring-App) oder ganz entfernen; zuletzt Gekauftes per Tipp zurück auf die Liste.
- **KI-Hilfe für die Einkaufsliste** – unsauberen Freitext aufräumen lassen oder ein **Foto** der Einkaufsliste hochladen; die KI (über OpenRouter) erkennt die Artikel automatisch.
- **Rezeptverwaltung** – Rezepte mit Zutaten, Tags, Portionen, Link, Zubereitung und voraussichtlicher Zeit speichern und per Klick in eine Bring-Liste importieren.
- **Wochenplan mit Würfelfunktion** – einzelne Tage oder die ganze Woche auswürfeln lassen, Tage von Hand belegen, auf einen anderen Tag verschieben und die Zutaten der kompletten Woche in einem Schritt nach Bring schieben.
- **Aufwand zählt mit** – unter der Woche kommen kurze Rezepte deutlich häufiger, am Wochenende die aufwendigen; Tage mit **Resten** lässt der Würfel in Ruhe.
- **Wetter und Jahreszeit** – meldet FHEM die Außentemperatur, kommt bei Kälte öfter Eintopf und bei Hitze öfter Salat; ohne Messwert entscheidet der Monat.
- **Vorlauf-Hinweis** – die App erkennt an Zubereitung und Tags, was am Vortag anzufangen ist (auftauen, einweichen, Teig gehen lassen), zeigt es im Wochenplan und stellt es FHEM für eine Abend-Erinnerung bereit.
- **Mengen für den Haushalt** – Rezepte stehen meist auf 4 Portionen; einmal eintragen, für wie viele gekocht wird, und die Mengen wandern umgerechnet nach Bring.
- **Bewertungen** – nach dem Essen „lecker / gut / ok / mies" vergeben, oder ein Rezept als **rausgeflogen** markieren (gar nicht gekocht) bzw. mit **nie wieder** dauerhaft sperren.
- **Gelernter Geschmack** – aus den Bewertungen entsteht ein Profil beliebter und unbeliebter Zutaten und Kategorien; der Würfel bevorzugt, was ankommt, und meidet, was durchgefallen ist.
- **Mealie-Anbindung** (optional) – [Mealie](https://mealie.io) als Rezeptquelle: Rezepte dort pflegen, hier spiegeln; Bewertungen wandern als `rating`/`lastMade` zurück, der Wochenplan wird mit Mealies Menüplan abgeglichen (beide Richtungen).
- **Cookidoo-Anbindung** (optional) – Thermomix-Rezepte aus [Cookidoo](https://cookidoo.de) im Würfeltopf (Name, Zutaten, Zeiten, Link – gekocht wird am Gerät), und Cookidoos Einkaufsliste auf Knopfdruck nach Bring.
- **Rezept per Link, auch vom Handy** – Adresse einwerfen und speichern, auch mit Mealie als Quelle. Unter **Android** trägt sich die installierte Web-App selbst ins Teilen-Menü ein, unter **iOS** geht es über einen Kurzbefehl.
- **Rezept-Import** – einzelne Rezepte per Link (Chefkoch und alle Seiten mit schema.org-Daten) oder **Massenimport von chefkoch.de** (z. B. 200 Rezepte auf einmal, im Hintergrund mit Fortschrittsanzeige).
- **Eigener Tab „Import & Quellen"** – Mealie, Cookidoo, Chefkoch-Import und KI-Analyse liegen zusammen; der Rezepte-Tab bleibt Liste und Geschmacksprofil. Die Rezeptliste lässt sich nach Herkunft filtern (Chefkoch, Cookidoo, eigene).
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

Woran man erkennt, dass wirklich der neue Stand läuft: **in der Kopfzeile der App
steht Version und Stand** (`v1.4.0 · 08.08., 11:19`) – die Version aus der
`package.json`, der Zeitstempel von der `server.js` im Image. Steht dort ein
alter Stand, hat der Build den neuen Commit nicht gesehen. Auf der
Wandtablet-Seite steht die Version unten klein.

Per Kommandozeile geht es auch:

```bash
curl -s http://<NAS>:<PORT>/api/status | grep -o '"version":"[^"]*"'
docker exec bring-interface printenv API_TOKEN     # Token da?
```

```bash
docker compose logs -f      # Logs ansehen
docker compose down         # Container stoppen
```

### Eine zweite Instanz für einen anderen Haushalt

Die App ist auf **einen** Haushalt gebaut: Bring-, Mealie- und Cookidoo-Zugang
kommen aus den Umgebungsvariablen, `APP_PASSWORD` ist ein gemeinsames Passwort,
und Rezepte, Plan und Bewertungen liegen alle in derselben Datenbank ohne
Besitzer-Kennzeichen. Für einen zweiten Haushalt startet man deshalb **eine
zweite Instanz** aus demselben Repo, statt die App mehrbenutzerfähig zu machen.
Beide bleiben sauber getrennt, es gibt keinen gemeinsamen Zustand.

In Portainer: denselben Git-Stack ein **zweites Mal** anlegen (anderer
Stack-Name, z. B. `bring-kumpel`) und dort eigene Variablen setzen. Fünf Werte
**müssen** sich unterscheiden, sonst kollidieren die Instanzen:

| Variable | warum |
| --- | --- |
| `CONTAINER_NAME` | Container-Namen sind auf dem ganzen Docker-Host eindeutig – sonst `Conflict. The container name … is already in use` |
| `HOST_PORT` | zwei Dienste können nicht denselben Port belegen |
| `DATA_PATH` | **nur wenn gesetzt**: zwei Instanzen auf denselben Ordner wären dieselbe Datenbank. Leer lassen ist am einfachsten, dann bekommt jeder Stack sein eigenes Volume |
| `APP_PASSWORD`, `API_TOKEN` | eigener Zugang |
| `BRING_MAIL`, `BRING_PASSWORD` | sein Bring-Konto |

Kommt Mealie bzw. Cookidoo mit, zusätzlich `MEALIE_CONTAINER_NAME`,
`MEALIE_PORT`, `MEALIE_DATA_PATH` bzw. `COOKIDOO_CONTAINER_NAME` und
`COOKIDOO_DATA_PATH`.

Ein Beispiel für die zweite Instanz (die erste bleibt unverändert):

```
CONTAINER_NAME=bring-kumpel
HOST_PORT=3556
DATA_PATH=
APP_PASSWORD=…
API_TOKEN=…
BRING_MAIL=kumpel@example.de
BRING_PASSWORD=…
# nur mit eigenem Mealie:
COMPOSE_PROFILES=mealie
MEALIE_CONTAINER_NAME=mealie-kumpel
MEALIE_PORT=9926
MEALIE_URL=http://mealie:9000
```

`MEALIE_URL=http://mealie:9000` bleibt richtig: der Dienstname gilt **innerhalb**
des Stacks, jede Instanz spricht mit ihrem eigenen Mealie.

#### Variante: ein gemeinsames Mealie für beide Instanzen

Ein Mealie reicht auch für zwei Haushalte – der zweite bekommt dort einfach ein
eigenes Konto. Dann in seinem Stack **kein** Mealie mitstarten
(`COMPOSE_PROFILES=` leer lassen) und auf das vorhandene zeigen:

```
MEALIE_URL=http://<NAS>:9925          # NICHT http://mealie:9000
MEALIE_PUBLIC_URL=https://mealie.<deine-domain>
MEALIE_TOKEN=…                        # Token aus SEINEM Mealie-Konto
```

> **Falle:** der Dienstname `mealie` löst sich nur innerhalb desselben
> Compose-Projekts auf. Die zweite Instanz ist ein eigenes Projekt und erreicht
> den Container darüber nicht – dort muss die NAS-Adresse samt veröffentlichtem
> Port stehen (oder das gemeinsame Netz, siehe unten).

##### Wenn die NAS-Adresse nicht durchkommt

Meldet die zweite Instanz

```
UND_ERR_CONNECT_TIMEOUT (Mealie unter http://192.168.69.10:9925) – Zeitüberschreitung beim Verbinden.
```

dann stimmt die Adresse (sonst käme `ENOTFOUND`) und Mealie lehnt auch nicht ab
(das wäre `ECONNREFUSED`) – die Pakete versickern. Auf der Synology ist das
meist die Firewall: sie lässt das Docker-Netz (172.x) nicht auf einen Port der
NAS. Ausgehend ins Internet funktioniert trotzdem, das läuft über NAT.

Nachmessen im Container der zweiten Instanz. Das Image ist ein schlankes
Debian, es gibt **weder `wget` noch `curl`** – Node ist aber da:

```bash
J=bring-kumpel   # der CONTAINER_NAME, nicht der Stack-Name
probe() {
  sudo docker exec $J node -e "fetch('$1').then(r=>r.text()).then(t=>console.log('OK',t.slice(0,80))).catch(e=>console.log('FEHLER:',e.cause?.code||e.message))"
}
probe http://<NAS>:9925/api/app/about      # scheitert (Firewall)
probe http://172.17.0.1:9925/api/app/about # Docker-Gateway
probe http://mealie:9000/api/app/about     # im gemeinsamen Netz
```

Drei Wege, vom besten zum schnellsten:

1. **Eigenes Netz nur für Mealie** (empfohlen) – ein drittes Netz, in dem nur
   Mealie und die Apps stehen. Beide reden direkt miteinander, ohne Host und
   ohne offenen Port. Dafür liegt `docker-compose.mealie-extern.yml` im Repo,
   benutzt von **beiden** Stacks; die Anleitung steht im Kopf der Datei.
   Danach ist `MEALIE_URL=http://mealie:9000` wieder richtig.

   > **In Portainer gehört die Datei in „Additional paths", nicht in
   > „Compose path"** – sie ist ein Zusatz zur Hauptdatei, keine eigenständige:
   >
   > | Feld | Wert |
   > | --- | --- |
   > | Compose path | `docker-compose.yml` |
   > | Additional paths → *Add file* | `docker-compose.mealie-extern.yml` |
   >
   > Zwei Pfade in das eine Feld „Compose path" zu schreiben hilft **nicht**:
   > es wird nur der erste angewandt, der Redeploy läuft fehlerfrei durch, und
   > trotzdem hängt danach niemand im gemeinsamen Netz. Von der Shell
   > entsprechend beide Dateien mit je einem `-f`.
2. **Docker-Gateway** – `MEALIE_URL=http://172.17.0.1:9925`. Geht sofort, hängt
   aber an einer Adresse, die Docker vergibt.
3. **Firewall öffnen** – in der DSM-Systemsteuerung dem Docker-Subnetz den
   Zugriff auf den Mealie-Port erlauben.

> **Warum ein eigenes Netz und nicht einfach das der ersten Instanz?** Weil dort
> auch deren App und Cookidoo-Brücke stehen. Dienstnamen heißen in jedem Stack
> gleich (`cookidoo-bridge`, `mealie`, `bring-interface`) – hängt die zweite
> Instanz im selben Netz, ist nicht mehr eindeutig, welche Brücke gemeint ist,
> und ein `COOKIDOO_URL=http://cookidoo-bridge:8099` kann in der fremden landen.
> Ein Netz nur für Mealie enthält genau das, was geteilt werden soll.
>
> Eigene Dienste in der zweiten Instanz deshalb über den **Container**-Namen
> ansprechen, der ist hostweit eindeutig:
> `COOKIDOO_CONTAINER_NAME=cookidoo-jan` und `COOKIDOO_URL=http://cookidoo-jan:8099`.

> `network_mode: host` ist hier **kein** guter Weg: damit fällt die
> Port-Abbildung weg (`ports:` wird ignoriert) und die zweite Instanz streitet
> sich mit der ersten um denselben Port.

In Mealie hängen die **Rezepte an der Gruppe**, **Menüplan und Einkaufsliste am
Haushalt** darin. Daraus folgen zwei Zuschnitte:

- **Eigene Gruppe** – alles getrennt, keine Berührungspunkte.
- **Gleiche Gruppe, eigener Haushalt** – gemeinsamer Rezept-Pool, getrennte
  Menüpläne. Dann in der zweiten Instanz `MEALIE_PUSH_RATINGS=0` setzen:
  Bewertung und „zuletzt gekocht" schreibt die App **auf das Rezept selbst**
  (`PATCH /api/recipes/<slug>`), nicht pro Haushalt – sonst überschreiben sich
  die beiden Haushalte gegenseitig. Für das Würfeln ist das folgenlos, die App
  **liest** diese beiden Felder nie zurück; Bewertungen und Kochverlauf liegen
  in der jeweils eigenen Datenbank.

Von der Shell aus bauen wie gehabt, nur mit eigenem Projektnamen:

```bash
S=<Portainer-Datenpfad>/compose/<neue-stack-id>
sudo docker compose -p bring-kumpel \
  --project-directory "$S" --env-file "$S/stack.env" up -d --build
```

Für den Zugriff von außen im DSM-Reverse-Proxy einen **zweiten Hostnamen** auf
den neuen Port legen. Updates laufen pro Stack – nach einem Merge also beide
Stacks „Pull and redeploy" + neu bauen.

Was dabei **nicht** geteilt wird: Rezepte, Wochenplan, Bewertungen,
Einstellungen, Bring-Listen. Gemeinsame Rezepte gingen nur über ein
gemeinsames Mealie (beide Instanzen auf dieselbe `MEALIE_URL`) – dann sehen
aber beide Haushalte alles, und die Bewertungen bleiben trotzdem getrennt.

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
| `CONTAINER_NAME` | Nur `docker-compose.yml`: Name des Containers (Standard `bring-interface`). Muss für eine [zweite Instanz](#eine-zweite-instanz-für-einen-anderen-haushalt) anders lauten, Docker-Namen sind hostweit eindeutig. |
| `MEALIE_CONTAINER_NAME`, `COOKIDOO_CONTAINER_NAME` | Dasselbe für die beiden optionalen Dienste. |
| `PLAN_QUICK_MINUTES` | Ab wann ein Rezept werktags als „dauert lange" gilt (Standard 40). |
| `PUBLIC_URL` | Adresse, unter der die App im Browser erreichbar ist – für absolute Bild-Adressen in den FHEM-Readings. Leer = die Adresse der jeweiligen Anfrage. |
| `PLAN_COLD_C`, `PLAN_WARM_C` | Schwellen für die Wetter-Neigung in °C (Standard 10 und 24). |
| `PLAN_WEATHER_HOURS` | Wie lange ein gemeldeter Messwert als aktuell gilt (Standard 6 Stunden). |
| `MEALIE_URL` | Basis-URL einer Mealie-Instanz. Gesetzt = Mealie ist die Rezeptquelle (siehe unten). |
| `MEALIE_TOKEN` | API-Token aus Mealie („Manage Your API Tokens"). |
| `MEALIE_SYNC_MINUTES` | Abgleich-Intervall in Minuten (Standard 15). |
| `MEALIE_PUSH_RATINGS` | Bewertungen als `rating`/`lastMade` nach Mealie zurückschreiben (Standard an, `0` = aus). |
| `MEALIE_PUSH_PLAN` | Wochenplan in Mealies Menüplan schreiben (Standard an, `0` = aus). |
| `MEALIE_PULL_PLAN` | Menüplan aus Mealie übernehmen – Mealie gewinnt (Standard an, `0` = aus). |
| `MEALIE_PLAN_ENTRY_TYPE` | Mahlzeit für diese Einträge: `breakfast`, `lunch`, `dinner` (Standard), `side`. |
| `MEALIE_RECIPE_URL` | Muster für den Link in die Mealie-Oberfläche (Standard `{base}/g/home/r/{slug}`). |
| `MEALIE_PUBLIC_URL` | Adresse von Mealie **aus dem Browser** (für die Links). Fällt auf `MEALIE_BASE_URL`, dann `MEALIE_URL` zurück. |
| `COMPOSE_PROFILES` | Nur `docker-compose.yml`: `mealie` startet Mealie mit, `cookidoo` die Cookidoo-Brücke (mehrere mit Komma). |
| `COOKIDOO_URL` | Adresse der Cookidoo-Brücke, z. B. `http://cookidoo-bridge:8099`. Gesetzt = Cookidoo ist als zweite Quelle an. |
| `COOKIDOO_TOKEN` | Gemeinsames Geheimnis zwischen App und Brücke (frei wählbar). |
| `COOKIDOO_EMAIL`, `COOKIDOO_PASSWORD` | Zugangsdaten des Cookidoo-Abos – bekommt nur die Brücke. |
| `COOKIDOO_COUNTRY`, `COOKIDOO_LANGUAGE` | Land/Sprache des Abos (Standard `de` / `de-DE`). |
| `COOKIDOO_COLLECTIONS` | Welche Sammlungen in den Würfeltopf: `custom` (Standard), `managed`, `all`. |
| `COOKIDOO_ONLY` | Optional auf Sammlungsnamen einschränken, z. B. `Wochenplan,Lieblinge`. |
| `COOKIDOO_SYNC_MINUTES` | Abgleich-Intervall in Minuten (Standard 180). |
| `COOKIDOO_DATA_PATH` | Ordner für die Sitzung der Brücke (leer = Volume `cookidoo-data`). |
| `MEALIE_PORT`, `MEALIE_BASE_URL`, `MEALIE_VERSION`, `MEALIE_DEFAULT_EMAIL`, `PUID`, `PGID`, `TZ` | Nur für den mitgelieferten Mealie-Dienst (Port 9925, Image-Tag, erstes Konto, Zeitzone). |
| `MEALIE_DATA_PATH` | Ordner auf der NAS für Mealies Daten (leer = benanntes Volume `mealie-data`). Muss `PUID:PGID` gehören. |
| `IMPORT_DELAY_MS` | Pause zwischen den Abrufen beim Rezept-Import (Standard 250 ms – bitte nicht zu klein wählen). |
| `IMPORT_CONCURRENCY` | Parallele Abrufe beim Massenimport (Standard 3). |
| `IMPORT_TIMEOUT_MS` | Timeout je Abruf beim Import (Standard 20000). |

## Sicherheit / externer Zugriff

Die App hat **keine** eingebaute Mehrbenutzer-Verwaltung. Für den Zugriff von außen:

1. **`APP_PASSWORD` setzen** – schützt die gesamte App mit einem gemeinsamen Passwort (Session-Cookie, 30 Tage, Brute-Force-Bremse).
2. **HTTPS ist Pflicht** – ein Passwort über reines HTTP wäre im Klartext im Netz. Stelle der App einen **Reverse Proxy mit TLS** voran (z. B. Synology-Reverse-Proxy mit Let's Encrypt) und gib nach außen **nur Port 443** frei, nicht den Container-Port.
3. **Noch sicherer:** gar nicht öffentlich exponieren, sondern per **VPN** (z. B. WireGuard auf der UniFi UDR) zugreifen.

## Vom Handy aus teilen

Eine Rezeptseite im Browser gefunden? Dann muss man sie nicht abtippen.

### Android: die App installiert sich ins Teilen-Menü

Die App bringt ein Web-App-Manifest samt `share_target` mit. Einmal über
**Chrome-Menü → „App installieren"** installieren, danach steht
**BRING-Interface** im Teilen-Menü jeder Seite; der Link landet auf `/share`,
wird gespeichert und die Seite meldet, was daraus geworden ist.

Zwei Voraussetzungen: der Aufruf muss über **https** laufen (also die
Reverse-Proxy-Adresse – über `http://<NAS>:3555` verweigert Chrome die
Installation), und die App muss einmal installiert sein. Der Service Worker
(`public/sw.js`) ist genau dafür da und speichert **nichts** zwischen.

### iPhone: Kurzbefehl

iOS erlaubt Webseiten keinen Eintrag im Teilen-Menü (die Web-Share-Target-API
gibt es dort nicht). Ein Kurzbefehl kann es:

1. Kurzbefehle-App → neuer Kurzbefehl, umbenennen (z. B. „Rezept senden"),
   unter **„i"** den Schalter **„Im Share-Sheet anzeigen"** einschalten.
2. Bei „Diesen Kurzbefehl empfangen von …" alle Haken entfernen, nur **URLs**
   anhaken.
3. Aktion **„URL codieren"** (auf der Kurzbefehleingabe) – ohne die stolpert die
   Adresse über Sonderzeichen im geteilten Link.
4. Aktion **„URL"** (blaue Weltkugel) mit
   `https://<adresse>/api/recipes/add?url=` + Variable **Codierte URL** +
   `&token=<API_TOKEN>`.
5. Aktion **„Inhalte von URL abrufen"** (Methode GET) und **„Ergebnis anzeigen"**.

Die passende Adresse steht auch in der App im Tab *Import & Quellen* unter
„🔗 Rezept per Link hinzufügen".

## Wandtablet-Ansicht

Unter **`/plan`** liegt eine eigene, dunkle Seite für ein Küchen- oder
Wandtablet: heutiges Gericht groß mit Bild, die Woche als Karten mit
Vorschaubildern, Sterne, Bewerten und Würfeln mit dem Finger, dazu
Wocheneinkauf nach Bring. Sie lädt sich jede Minute selbst neu und ist auf ~1000
px Breite ausgelegt (drei Karten je Reihe), funktioniert aber auch am Handy.

```
http://<host>:<port>/plan?token=<API_TOKEN>
```

Zusätzlich gibt es den Plan **als Bild** unter `/plan.svg?token=…` – für
Dashboards, die keine Webseite einbetten können, aber Bilder anzeigen (FHEMVIZ
z. B. stellt einen `weblink iframe` nicht dar, ein Bild-Widget dagegen schon).
Die Fotos stecken als data:-URI im SVG, weil ein SVG in einem `<img>` keine
externen Bilder nachlädt.

Mit `?token=…` braucht die Seite keine Anmeldung – so kann sie dauerhaft auf
einem Tablet laufen oder in FHEM als Rahmen (`weblink iframe`) hängen, siehe
[`fhem/README.md`](fhem/README.md). Rezeptbilder liefert der Server selbst aus
(`/api/mealie/image/<id>`), damit sie auch dann laden, wenn Mealie nur intern
erreichbar ist.

## Wochenplan & Würfel

> Der Rezeptname im Wochenplan (auch auf der Wandtablet-Seite) verlinkt bei
> Mealie-Rezepten **nach Mealie**, nicht auf die Quell-Seite – Chefkoch-Rezepte
> stehen dort oft hinter der PLUS-Schranke.

Der Würfel zieht gewichtet, nicht gleichverteilt:

- **eigene Bewertung**: 5★ ist rund 20× wahrscheinlicher als 1★, „nie wieder" fällt ganz heraus
- **Aufwand**: werktags zählen kurze Rezepte (bis `PLAN_QUICK_MINUTES`, Standard 40 Min.) voll, längere nur zu 40 % bzw. 15 %; am Wochenende bekommen die langen einen Bonus. Ohne Zeitangabe am Rezept wird **nicht** abgewertet – die Quelle weiß es dann eben nicht, und das Rezept dafür auszusortieren wäre die schlechtere Wette
- **rausgeflogen** (nicht gekocht) dämpft ein Rezept stark, löscht es aber nicht
- **Geschmacksprofil**: Zutaten und Kategorien, die in anderen Rezepten gut/schlecht bewertet wurden, wirken mit (±)
- **Abwechslung**: was in den letzten 7/14/28 Tagen gekocht wurde, kommt seltener; innerhalb einer Woche möglichst kein Gericht doppelt
- **Neugier**: noch unbewertete Rezepte bekommen einen kleinen Bonus

Reichen die Kandidaten nicht (kleine Sammlung), werden die Regeln
schrittweise gelockert, statt gar nichts vorzuschlagen. Als **gekocht**
markierte Tage bleiben beim Neuwürfeln unangetastet.

### Ein Rezept von Hand einplanen

Zwei Richtungen, je nachdem was schon feststeht:

- **Tag steht fest** → im Tab *Wochenplan* beim Tag auf `📋`, dann das Rezept
  suchen.
- **Rezept steht fest** → im Tab *Rezepte* an der Karte auf `📅 Einplanen`. Der
  Wähler zeigt die nächsten zwei Wochen mit dem, was dort schon geplant ist;
  ein Klick ersetzt es. Als **gekocht** markierte Tage sind gesperrt, damit die
  Historie nicht kaputtgeht.

### Vorgaben für den nächsten Wurf

Über den Würfel-Knöpfen stehen zwei Felder. Sie gelten für den nächsten Wurf –
für die ganze Woche wie für einen einzelnen Tag – und landen als Begründung im
Plan (`🎲 mal was Neues · höchstens 30 Min. · Wetter: kalt`):

- **höchstens X Minuten** – anders als der Aufwands-Faktor oben ist das eine
  Ansage: was länger dauert, fällt raus, auch in der letzten Lockerungsstufe.
  Rezepte **ohne** Zeitangabe bleiben möglich, kommen aber seltener – sie ganz
  auszuschließen würde bei Quellen ohne Zeitangabe die halbe Sammlung schlucken.
- **Wetter** – `automatisch` nimmt die gemeldete Außentemperatur (für heute und
  morgen) bzw. den Monat. `kalt` und `warm` überschreiben das von Hand, wenn man
  es besser weiß als der Sensor.

### Dauerhafte Schwellen

Im Tab **Wochenplan** unter „Wann ist ein Rezept ‚aufwendig', wann ist es kalt?":

| Feld | Wirkung | Standard |
| --- | --- | --- |
| aufwendig ab … Min. | ab wann ein Rezept werktags abgewertet und am Wochenende bevorzugt wird | `PLAN_QUICK_MINUTES`, 40 |
| kalt bis … °C | ab wann Eintopf und Auflauf bevorzugt werden | `PLAN_COLD_C`, 10 |
| warm ab … °C | ab wann Salat und Leichtes bevorzugt werden | `PLAN_WARM_C`, 24 |

Die Werte liegen in der Datenbank und gelten geräteübergreifend – die
Umgebungsvariablen sind nur noch der Anfangswert. Ein leeres Feld speichern
setzt auf diesen zurück.

### Was gar nicht erst gewürfelt wird

Ein Dip ist kein Abendessen. Welche Rezepte draußen bleiben, entscheiden die
**Kategorien und Schlagwörter aus Mealie** (Mealies `recipeCategory` landet hier
zusammen mit den Tags im Feld `tags`):

1. `course` am Rezept – in der Rezeptliste von Hand gesetzt, schlägt alles
2. eine Kategorie der **Haupt-Liste** (`Hauptgericht`, `Abendessen` …) → wird gewürfelt
3. eine Kategorie der **Beilagen-Liste** (`Dip`, `Beilage`, `Dessert`, `Kuchen` …) → nicht
4. der Name spricht dafür (`Kräuterdip`, `Basilikumpesto`, `Erdbeermarmelade`) → nicht
5. sonst: wird gewürfelt – ohne Kategorie lieber vorschlagen als verschlucken

Beide Listen stehen im Tab **Wochenplan** und sind änderbar; leer speichern
stellt den Standard wieder her. Der Namens-Notnagel ist bewusst knapp und
lässt Zutaten im Namen in Ruhe: „Nudeln mit Pesto" bleibt ein Abendessen,
„Zwiebelkuchen" und „Flammkuchen" ebenso.

Die Rezeptliste zeigt bei den Ausgenommenen, **warum**, und stellt sie per Knopf
um; der Filter „Kein Abendessen" listet sie alle auf.

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
- **Der Wochenplan wird mit Mealies Menüplan abgeglichen – in beide Richtungen.**
  Die Regel lautet **Mealie gewinnt**: wer dort einen Tag einträgt, hat sich etwas
  dabei gedacht, der Würfel füllt nur die Lücken. Praktisch heißt das:
  - Was in Mealie steht, wird übernommen (Notiz „aus Mealie"). Ein dort geplantes
    Rezept, das hier noch fehlt, wird sofort nachgespiegelt.
  - Was in Mealie **gelöscht** wird, verschwindet auch hier – aber nur, wenn der
    Eintrag von dort kam (`meal_plan.origin`). Selbst gewürfelte Tage bleiben.
  - Alles Übrige – würfeln, Rezept von Hand setzen, Tag leeren, auch über die
    FHEM-Route – wandert nach Mealie.
  - **Gekochte Tage rührt der Abgleich nicht an**, das ist Historie.
  Einträge mit anderer Mahlzeit (Frühstück, Mittag) bleiben unangetastet, unsere
  Tage liegen unter `MEALIE_PLAN_ENTRY_TYPE` (Standard `dinner`). Der Abgleich
  läuft bei jeder Änderung sowie zusammen mit dem Rezept-Abgleich für diese und
  die nächste Woche; der Knopf **„📅 Mit Mealie abgleichen"** im Wochenplan-Tab
  holt ihn sofort. Abschaltbar mit `MEALIE_PUSH_PLAN=0` bzw. `MEALIE_PULL_PLAN=0`.
- **Angerissene Rezepte** (Chefkoch PLUS) erkennt die App am Platzhalter
  „-- additional ingredients not fully disclosed --": sie zählen als
  **unvollständig**, werden **nicht gewürfelt**, der Platzhalter landet nicht auf
  dem Einkaufszettel und stört die Reste-Suche nicht. Über den Filter
  **„Unvollständig (PLUS-Anriss)"** siehst du sie, der Knopf **„🩹 Anreichern"**
  an der Karte versucht das einzelne Rezept aus der Chefkoch-API nachzutragen und
  sagt, wenn dort nichts mehr zu holen ist. Dann hilft nur löschen oder von Hand
  in Mealie vervollständigen.
- **Verwaiste Einträge aufräumen:** die Mealie-Karte meldet, wie viele Rezepte in
  Mealie gelöscht wurden und hier noch liegen, und räumt sie auf Knopfdruck weg –
  standardmäßig nur die ohne Bewertungen und Plan-Einträge, auf ausdrücklichen
  Wunsch auch die mit Historie. Einzeln findest du sie über den Listenfilter
  **„In Mealie gelöscht"**.
- **Löschen** geht am einfachsten über den Knopf **„In Mealie löschen"** an der
  Rezeptkarte: er löscht das Rezept per API in Mealie und räumt hier auf. Hat das
  Rezept Bewertungen oder Plan-Einträge, bleibt es als Historie stehen (markiert,
  nicht mehr würfelbar) und lässt sich danach mit „Endgültig löschen" auch hier
  entfernen. In Mealies eigener Oberfläche ist das Löschen einzelner Rezepte je
  nach Version schwer zu finden; für viele auf einmal geht dort
  *Manage Data* → Recipes.
- Übernommen werden Name, Beschreibung, Zutaten (aus `food`/`unit`/`quantity`,
  sonst der Freitext), Zubereitung, Zeiten, Portionen, Tags und Kategorien,
  Bild und die Quell-URL (`orgURL`).

### Mealie in derselben Stack mitlaufen lassen

Die `docker-compose.yml` enthält Mealie schon als **optionalen** Dienst
(`profiles: ["mealie"]`, also standardmäßig aus). Einschalten über die
Stack-Variablen:

```
COMPOSE_PROFILES=mealie
MEALIE_URL=http://mealie:9000          # Container-zu-Container, kein Port nötig
MEALIE_TOKEN=                          # erst nach dem ersten Start (siehe unten)
MEALIE_PORT=9925                       # nur für die Mealie-Oberfläche im Browser
MEALIE_BASE_URL=http://192.168.69.10:9925      # Adresse im Browser (für Links)
MEALIE_DATA_PATH=/volume2/docker/MEALIE/data   # leer = Volume "mealie-data"
TZ=Europe/Berlin
PUID=1000
PGID=1000
```

Dann `docker compose up -d` (bzw. Stack in Portainer aktualisieren) – Portainer
zeigt danach zwei Container.

Zum Speicherort: analog zu `DATA_PATH` dieser App kann Mealie entweder ein
benanntes Volume benutzen (Standard) oder einen Ordner auf der NAS
(`MEALIE_DATA_PATH`). Bei einem Ordner muss der **vorher existieren und
`PUID:PGID` gehören**:

```bash
sudo mkdir -p /volume2/docker/MEALIE/data
sudo chown -R 1000:1000 /volume2/docker/MEALIE/data
```

Auf eine SMB/NFS-Freigabe gehört die SQLite-Datei nicht – ein lokales Volume der
NAS (`/volume2/...`) ist in Ordnung. Wer Mealie lieber getrennt betreibt, lässt
das Profil aus und trägt bei `MEALIE_URL` die normale Adresse ein
(`http://192.168.69.10:9925`).

Erste Schritte in Mealie:

1. `http://<host>:9925` öffnen und mit `changeme@email.com` / `MyPassword`
   anmelden (manche Versionen nutzen `changeme@example.com`; eindeutig wird es,
   wenn du `MEALIE_DEFAULT_EMAIL` selbst setzt). Passwort sofort ändern.
2. Oben rechts über das Profil → **Manage Your API Tokens** → Token anlegen und
   den Wert als `MEALIE_TOKEN` in die Stack-Variablen eintragen, Stack neu
   deployen.
3. Rezepte in Mealie importieren – dort **+ → Import from URL** für einzelne
   Links. Für viele auf einmal gibt es in dieser App den Knopf **„Rezepte von
   chefkoch.de nach Mealie holen"**: die Chefkoch-Suche liefert die URLs,
   Mealies eigener Scraper liest die Seiten aus, danach wird automatisch
   abgeglichen. Bereits vorhandene Rezepte werden übersprungen (Erkennung über
   die Quell-URL).

Getrennt betrieben sieht es so aus:

```
MEALIE_URL=http://192.168.69.10:9925
MEALIE_TOKEN=<Token aus "Manage Your API Tokens">
```

> **Zwei Adressen, ein Unterschied:** `MEALIE_URL` benutzt der Server für die
> API – bei gemeinsamer Stack der Dienstname `http://mealie:9000`, im Browser
> also unerreichbar. Die Knöpfe „Mealie öffnen" und „In Mealie" nehmen deshalb
> `MEALIE_PUBLIC_URL`, ersatzweise `MEALIE_BASE_URL` (das der Mealie-Container
> ohnehin bekommt) und erst zuletzt `MEALIE_URL`. Bei getrennt betriebenem
> Mealie sind beide gleich, dann genügt `MEALIE_URL`.
>
> Der Link auf ein Rezept folgt `MEALIE_RECIPE_URL`
> (Standard `{base}/g/home/r/{slug}`); ältere Mealie-Versionen brauchen
> `{base}/recipe/{slug}`.

## Cookidoo / Thermomix (optional)

Thermomix-Rezepte kommen aus **Cookidoo** in den Würfeltopf: gespiegelt werden
Name, Zutaten mit Mengen, Zeiten, Portionen, Bild und der Link zurück nach
Cookidoo. Damit würfelt der Wochenplan sie mit und ihre Zutaten landen im
Bring-Wocheneinkauf. Zusätzlich lässt sich **Cookidoos eigene Einkaufsliste**
auf Knopfdruck nach Bring schieben.

> **Cookidoo hat keine offizielle Schnittstelle.** Angesprochen werden die
> nachgebauten Endpunkte, die auch die Home-Assistant-Integration benutzt
> (Python-Paket [`cookidoo-api`](https://github.com/miaucl/cookidoo-api)).
> Ändert Vorwerk etwas am Login, steht der Abgleich still – die App läuft
> weiter, die gespiegelten Rezepte bleiben. Ein aktives Abo ist Voraussetzung.

Was **nicht** übernommen wird: die Schritt-für-Schritt-Anleitung. Geführtes
Kochen gibt Cookidoo nicht heraus, das bleibt in der App bzw. am Gerät – im
Rezept steht deshalb nur ein Verweis. Eigene Rezepte („custom") bringen ihre
Zubereitung mit.

### Einrichten

Weil die Anmeldung der fragile Teil ist, läuft sie in einem eigenen kleinen
Container (`cookidoo-bridge/`) mit der gepflegten Bibliothek; die App spricht nur
noch JSON mit ihm. Nur die Brücke kennt die Zugangsdaten, und nach außen ist kein
Port offen.

1. In den Stack-Variablen setzen:

   ```env
   COMPOSE_PROFILES=mealie,cookidoo      # cookidoo zu den bisherigen Profilen dazu
   COOKIDOO_URL=http://cookidoo-bridge:8099
   COOKIDOO_TOKEN=<frei gewähltes Geheimnis>
   COOKIDOO_EMAIL=<Cookidoo-Konto>
   COOKIDOO_PASSWORD=<Passwort>
   COOKIDOO_COUNTRY=de
   COOKIDOO_LANGUAGE=de-DE
   COOKIDOO_COLLECTIONS=custom           # eigene Listen; managed = gekaufte, all = beides
   ```

2. Stack neu bauen (`docker compose up -d --build`, in Portainer „Update the
   stack" mit *Re-pull and redeploy* aus).
3. Prüfen: `curl "http://<NAS>:<PORT>/api/cookidoo/status?token=<API_TOKEN>"` –
   dort stehen Konto, Abo und der letzte Abgleich. Im Rezepte-Tab erscheint die
   Karte **„🍲 Cookidoo (Thermomix)"** mit Knopf zum Abgleichen.

Abgeglichen wird beim Start und dann alle `COOKIDOO_SYNC_MINUTES` Minuten
(Standard 180 – seltener als bei Mealie, weil die Brücke jedes Rezept einzeln
abfragen muss). Mit `COOKIDOO_ONLY=Wochenplan,Lieblinge` lässt sich auf
bestimmte Sammlungen einschränken. Verschwindet ein Rezept aus den Sammlungen,
wird es wie bei Mealie nur als fehlend markiert – Bewertungen und Plan-Historie
bleiben.

> Die Zugangsdaten liegen als Umgebungsvariablen in der Stack. Wer das nicht
> möchte, kann das Profil weglassen: ohne `COOKIDOO_URL` ist die ganze
> Anbindung aus.

## Rezept-Import

- **Einzelnes Rezept per Link**: liest die schema.org-Daten (`Recipe`) der Seite –
  funktioniert bei Chefkoch (dort zuerst über die JSON-API) und den meisten
  anderen Rezeptseiten. Optional als Rückfall die KI-Analyse des Seitentexts.
- **Massenimport von chefkoch.de**: Suchbegriff (oder leer für beliebte Rezepte)
  und Anzahl angeben. Der Lauf passiert im Hintergrund mit Fortschritt und
  Protokoll, lässt sich abbrechen und überspringt bereits vorhandene Rezepte
  (Erkennung über `chefkoch:<id>` und den Rezeptnamen).

- **Von einer beliebigen Koch-Seite** (`🌐 Rezepte von einer Koch-Seite holen`):
  Adresse einer **Übersichtsseite** eintragen – Kategorie, Schlagwort oder
  Rezeptliste. Der Lauf ist zweistufig:

  1. Übersichtsseite lesen, alle Links derselben Domain einsammeln, offensichtliches
     Beiwerk wegwerfen (Kategorien, Feeds, Impressum, Bilder), bei Bedarf der
     Blätter-Navigation folgen (`rel="next"`, `/page/2/`, `?seite=2`)
  2. jede verbliebene Adresse anlesen und nur behalten, wo wirklich
     schema.org-Rezeptdaten stehen

  Dadurch ist **keine Seite fest verdrahtet** – welche Links Rezepte sind, sagt
  die Seite selbst. Getestet mit dem üblichen WordPress-Zuschnitt (WP Recipe
  Maker & Co.).

  **Erst den Probelauf** (`👀`): er führt beide Schritte aus und listet auf, was
  gefunden wurde, ohne etwas anzulegen. So sieht man einer unbekannten Seite an,
  ob sie sich einlesen lässt.

  Ist Mealie eingerichtet, gehen die gefundenen Adressen an **Mealies eigenen
  Importer** (`/api/recipes/create/url`) – der bringt den gepflegten
  `recipe-scrapers`-Fundus mit und kommt mit mehr Seiten zurecht als wir.
  Ohne Mealie werden die gelesenen Daten direkt lokal angelegt (`source: web`).
  Schon vorhandene Rezepte werden anhand der Quell-Adresse und des Namens
  übersprungen.

> Zwischen den Abrufen liegt eine Pause (`IMPORT_DELAY_MS`), damit der Import
> die Quelle nicht belastet. 200 Rezepte dauern damit einige Minuten.
> Der Server muss die jeweilige Seite erreichen können.
>
> Der Seiten-Import ist als Helfer für die **eigene** Rezeptsammlung gedacht:
> eine Adresse nach der anderen, mit Pause, und mit Obergrenzen für Seiten
> (20) und Kandidaten (400). Bitte fremde Seiten damit nicht leerräumen und
> die Nutzungsbedingungen der Quelle beachten.

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
