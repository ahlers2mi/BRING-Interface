# FHEM-Anbindung (Wochenplan)

Der Wochenplan lässt sich komplett aus FHEM heraus bedienen: aktuelle Gerichte
als Readings, Würfeln und Bewerten als `set`-Befehle, Wocheneinkauf nach Bring
auf Knopfdruck. Grundlage ist ein **HTTPMOD**-Gerät – kein eigenes Modul nötig.

## 1. Token setzen

In der `.env` des Containers einen beliebigen, langen Wert eintragen und den
Container neu starten:

```
API_TOKEN=einLangerZufallswert
```

Damit kommen Maschinen (FHEM, Skripte) an die `/api/`-Routen, ohne sich am
Login-Formular anzumelden – auch dann, wenn `APP_PASSWORD` gesetzt ist. Der
Token wird als `?token=…`, Header `X-API-Token` oder `Authorization: Bearer …`
akzeptiert; FHEM nutzt die Query-Variante, weil HTTPMOD damit am einfachsten
umgeht.

Kurzer Test von der FHEM-Kommandozeile:

```
{ GetFileFromURL("http://192.168.69.XX:3000/api/fhem/plan?token=DEINTOKEN") }
```

## 2. Gerät anlegen

Den Block aus [`wochenplan.commands.txt`](wochenplan.commands.txt) anpassen
(Adresse + Token) und über `set myCommander execute` einfügen. Danach `save`.

Angelegt werden:

| Gerät                   | Zweck                                              |
|-------------------------|----------------------------------------------------|
| `HTTP.Wochenplan`       | Readings + Befehle (HTTPMOD, Abruf alle 5 Min.)    |
| `a_wochenplan_wuerfeln` | optional: sonntags 18:00 die neue Woche würfeln     |
| `a_wochenplan_ansage`   | optional: morgens per `send_to_all` ansagen         |

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
define n_wochenplan_lecker notify taster_kueche:short.* { GetFileFromURL("http://192.168.69.XX:3000/api/fhem/rate?date=today&rating=lecker&token=DEINTOKEN") }
```
