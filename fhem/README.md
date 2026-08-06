# FHEM-Anbindung (Wochenplan)

Der Wochenplan lässt sich komplett aus FHEM heraus bedienen: aktuelle Gerichte
als Readings, Würfeln und Bewerten als `set`-Befehle, Wocheneinkauf nach Bring
auf Knopfdruck. Grundlage ist ein **HTTPMOD**-Gerät – kein eigenes Modul nötig.

## 1. Token setzen

In der `.env` des Containers einen beliebigen, langen Wert eintragen und den
Container **neu erstellen** (`docker compose up -d`, nicht nur `restart` –
neue Umgebungsvariablen kommen sonst nicht an):

```
API_TOKEN=einLangerZufallswert
```

Am besten ohne Sonderzeichen wie `&`, `#` oder `+`, damit der Wert unverändert
in eine URL passt (`@` ist unproblematisch).

Damit kommen Maschinen (FHEM, Skripte) an die `/api/`-Routen, ohne sich am
Login-Formular anzumelden – auch dann, wenn `APP_PASSWORD` gesetzt ist. Der
Token wird als `?token=…`, Header `X-API-Token` oder `Authorization: Bearer …`
akzeptiert; FHEM nutzt die Query-Variante, weil HTTPMOD damit am einfachsten
umgeht.

Kurzer Test von der FHEM-Kommandozeile:

```
{ GetFileFromURL("http://192.168.69.10:8095/api/fhem/plan?token=DEINTOKEN") }
```

> **Port beachten:** In der `docker-compose.yml` wird `${HOST_PORT:-8095}:3000`
> gemappt – auf der NAS lauscht also standardmäßig **8095**, die 3000 gilt nur
> innerhalb des Containers. Auf 3000 antwortet auf einer Synology oft ein
> anderer Dienst (z. B. Grafana) mit einem eigenen `401`. Alternativ die
> Reverse-Proxy-Adresse verwenden (`https://bring.<domain>/api/fhem/plan?token=…`),
> HTTPMOD kann HTTPS.
>
> Fingerabdrücke zum Einordnen der Antwort:
>
> | Antwort | Bedeutung |
> |---------|-----------|
> | `{"week":"2026-W32",…}` | passt |
> | `{"error":"Nicht angemeldet."}` | unsere App, aber es wurde gar kein Token mitgeschickt |
> | `…API_TOKEN nicht gesetzt…` | Token kam an, aber im Container fehlt die Variable |
> | `Token stimmt nicht mit API_TOKEN überein.` | Variable ist da, der Wert passt nicht |
> | irgendwas mit `messageId`/`traceID` o. Ä. | falscher Port – das ist ein anderer Dienst |
>
> **Achtung:** die Sperre greift *vor* dem Routing, deshalb antwortet auch eine
> gar nicht existierende `/api/`-Adresse mit `{"error":"Nicht angemeldet."}`.
> Aus dieser Meldung lässt sich also **nicht** ablesen, ob der Wochenplan-Stand
> überhaupt installiert ist. Dafür im **eingeloggten Browser** (Session-Cookie
> genügt) `…/api/fhem/plan` **ohne** `?token=` öffnen:
>
> - JSON → neuer Stand läuft, es hakt nur am Token
> - `Cannot GET /api/fhem/plan` → noch der alte Stand ohne Wochenplan

### Wenn der Token nicht akzeptiert wird

1. Kommt die Variable im Container an?
   `docker exec bring-interface printenv API_TOKEN`
   (bzw. in Portainer unter „Env"). Leer = Ursache gefunden: `API_TOKEN` gehört
   in die `.env` **und** in die `environment:`-Liste der `docker-compose.yml`.
   **Portainer liest keine `.env` aus dem Git-Repo** (die ist gar nicht
   eingecheckt) – dort muss die Variable unter „Environment variables" der Stack
   stehen, mit genau dem Namen `API_TOKEN`. Vergleichsprobe:
   `docker exec bring-interface printenv BRING_MAIL` – kommt die an und
   `API_TOKEN` nicht, fehlt entweder der Stack-Eintrag oder die deployte
   `docker-compose.yml` ist älter als dieser Stand.
2. Danach `docker compose up -d` – ein `restart` übernimmt neue
   Umgebungsvariablen nicht.
3. Wert in der `.env` **ohne Anführungszeichen** und ohne Leerzeichen am
   Zeilenende schreiben (`API_TOKEN=abc123`, nicht `API_TOKEN="abc123"`) –
   beides landet sonst im Vergleich und der Token passt nie. Ein `#` im Wert
   schneidet die Zeile ab.

## 2. Gerät anlegen

Den Block aus [`wochenplan.commands.txt`](wochenplan.commands.txt) anpassen
(Adresse + Token) und über `set myCommander execute` einfügen. Danach `save`.

Angelegt werden:

| Gerät                   | Zweck                                              |
|-------------------------|----------------------------------------------------|
| `HTTP.Wochenplan`       | Readings + Befehle (HTTPMOD, Abruf alle 5 Min.)    |
| `a_wochenplan_wuerfeln` | optional: sonntags 18:00 die neue Woche würfeln     |
| `a_wochenplan_ansage`   | optional: morgens per `send_to_all` ansagen         |

### Warum Regex statt `reading..JSON`

Bei der JSON-Auswertung dekodiert HTTPMOD den Text zu Perl-Zeichen; FHEM gibt
Umlaute dann als einzelnes Byte aus und im Browser steht „Gef**?**llte
Auberginen". Der Block liest die Werte deshalb per `reading..Regex` direkt aus
dem Antworttext – damit bleiben die UTF-8-Bytes unverändert. Die Antwort ist
flach aufgebaut und serverseitig von Anführungszeichen befreit, `"([^"]*)"`
genügt also. Wer seine Installation auf `attr global encoding unicode` gestellt
hat, kann stattdessen `reading01JSON today` usw. verwenden.

## 3. Readings

| Reading | Inhalt |
|---------|--------|
| `heute`, `morgen` | Gericht des Tages (leer = nichts geplant) |
| `heute_status` | `planned`, `cooked`, `skipped` oder `empty` |
| `heute_bewertung` | `1`–`5` oder `rausgeflogen`, leer solange unbewertet |
| `heute_sterne` | Sterne als Zahl (0 = keine Bewertung) |
| `heute_zeit` | voraussichtliche Zubereitungszeit |
| `mo` … `so` | die sieben Tage der laufenden Woche |
| `mo_sterne` … `so_sterne` | Bewertung des jeweiligen Tages |
| `woche` | Kalenderwoche, z. B. `2026-W32` |
| `geplant`, `leere_tage` | wie viele Tage belegt bzw. frei sind |
| `stand` | Zeitpunkt des letzten Abrufs |

`STATE` ist über `stateFormat` „Heute: <Gericht>".

## 4. Befehle

```
set HTTP.Wochenplan wuerfeln_heute          # nur heute neu würfeln
set HTTP.Wochenplan wuerfeln_morgen
set HTTP.Wochenplan wuerfeln_woche          # ganze Woche (gekochte Tage bleiben)
set HTTP.Wochenplan wuerfeln_leere_tage     # nur die freien Tage füllen
set HTTP.Wochenplan bewerten lecker         # lecker|gut|ok|maessig|schlecht|
                                            # rausgeflogen|nie_wieder
set HTTP.Wochenplan einkaufsliste           # Zutaten der Woche nach Bring
```

`rausgeflogen` heißt „gar nicht gekocht" – das Rezept bleibt in der Sammlung,
wird aber seltener gewürfelt. `nie_wieder` sperrt es dauerhaft.

Die Aktions-URLs antworten mit demselben JSON wie der normale Abruf; dank
`setParseResponse 1` sind die Readings direkt nach dem `set` aktuell.

> Falls dein HTTPMOD `$val` in `set05URL` nicht ersetzt (ältere Versionen),
> stattdessen je Bewertung ein eigenes No-Arg-`set` anlegen, z. B.
> `set07Name bewerten_lecker` + `set07URL …/api/fhem/rate?date=today&rating=lecker&token=…`
> + `set07NoArg 1`.

## 5. FHEMVIZ

Das Gerät liegt im Raum `FHEMVIZ->Küche`, wird also von `myViz`
(`devspec room=FHEMVIZ->.*`) automatisch mitgeladen. Gesetzt sind:

```
attr HTTP.Wochenplan vizState heute
attr HTTP.Wochenplan vizReadings heute:Heute,morgen:Morgen,mo:Mo,di:Di,mi:Mi,do:Do,fr:Fr,sa:Sa,so:So
attr HTTP.Wochenplan webCmd wuerfeln_heute:wuerfeln_woche:bewerten
```

Damit zeigt die Kachel den Wochenplan als Werteliste, der Bewertungs-Knopf
kommt aus `webCmd` + `set05Hint` (FHEMVIZ liest die Auswahl aus
`PossibleSets`). Sollte deine FHEMVIZ-Version bei `vizReadings` keine Labels
nach dem Doppelpunkt unterstützen, genügt die schlichte Liste:

```
attr HTTP.Wochenplan vizReadings heute,morgen,mo,di,mi,do,fr,sa,so
```

Für ein eigenes Küchen-Tablet lohnt eine zweite Sicht analog zu `vizOpa`:

```
define vizKueche FHEMVIZ
attr vizKueche devspec HTTP.Wochenplan,room=Kueche->.*
attr vizKueche skin zeilen
attr vizKueche zoom 1.2
```

## 6. Alle FHEM-Endpunkte

Alle Routen sind sowohl per GET als auch per POST erreichbar – GET, damit ein
`{ GetFileFromURL(...) }` bzw. ein `setXXURL` genügt.

| Route | Wirkung |
|-------|---------|
| `/api/fhem/plan` | flaches JSON mit dem gesamten Wochenplan |
| `/api/fhem/roll?scope=week` | ganze Woche würfeln (`&onlyEmpty=1` = nur freie Tage) |
| `/api/fhem/roll?scope=day&date=today` | einen Tag würfeln (`today`, `tomorrow` oder `YYYY-MM-DD`) |
| `/api/fhem/rate?date=today&rating=lecker` | Tag bewerten |
| `/api/fhem/shopping?week=current` | Zutaten der Woche in die zuletzt benutzte Bring-Liste (`&list=<uuid>` für eine andere) |

Beispiel für ein eigenes Notify (z. B. Bewertung über einen Taster):

```
define n_wochenplan_lecker notify taster_kueche:short.* { GetFileFromURL("http://192.168.69.10:8095/api/fhem/rate?date=today&rating=lecker&token=DEINTOKEN") }
```
