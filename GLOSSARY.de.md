# Glossar

Ein Nachschlagewerk für die Fachbegriffe und projektspezifischen Begriffe, die in
`dwd-cli` verwendet werden. Die Daten stammen aus dem Backend der Warnwetter-App des
**Deutschen Wetterdienstes (DWD)** (`warnwetter.de`); die Fachsprache ist deutsch,
daher nennt dieses Glossar die deutschen Begriffe zusammen mit den englischen
Bezeichnungen, die CLI und API verwenden, wo es solche gibt.

> **Übersetzungstabelle.** Die CLI hält sich an diese Zuordnung:
>
> | Deutsch | Englisch / API-Begriff |
> | --- | --- |
> | Warnung | warning |
> | Gemeinde | municipality |
> | Küste / Binnensee | coast / inland lake |
> | Vorhersage | forecast |
> | Meldung | (crowd-sourced) report |
> | Wetterstation | weather station |

---

## Die Quelle: DWD-Warnwetter

**DWD – Deutscher Wetterdienst.** Der nationale meteorologische Dienst Deutschlands.
Er betreibt das öffentliche Unwetterwarnsystem und die App *Warnwetter*, deren
Backend dieses Tool kapselt.

**Warnwetter-App.** Die offizielle Warn-App des DWD für die Öffentlichkeit. Ihr
Backend liefert sowohl Live-Stationsvorhersagen als auch die regelmäßig
veröffentlichten Warn-Feeds; beides ist offen (ohne Authentifizierung) und nur lesbar.

**warnwetter.de.** Die Domain des Warnwetter-Backends. Die Daten verteilen sich
auf zwei Hosts (siehe *Live-Webdienst* und *Statischer S3-Bucket*).

**Offene Endpoints ohne Authentifizierung.** Die Endpoints, die dieser Client nutzt,
brauchen keinen API-Schlüssel. Alle sind `GET` und nur lesend; `dwd-cli` schreibt nie.

---

## Die zwei Hosts

**Live-Webdienst.** `https://app-prod-ws.warnwetter.de/v30` – das Live-Backend,
das Anfragen zur Stationsübersicht beantwortet und mit Parametern abgefragt wird.
Überschreiben in der CLI: `--base-url`; das Versionssegment im Pfad ist **`/v30`**.

**Statischer S3-Bucket.** `https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16`
– ein Amazon-S3-Bucket, der die regelmäßig veröffentlichten Warn- und Crowd-Feeds als
statische JSON-Dateien bereithält. Überschreiben in der CLI: `--static-base-url`; das
Versionssegment im Pfad ist **`/v16`**.

**gzip-kodierte Feeds.** Die statischen Warndateien liegen auf S3 mit
`Content-Encoding: gzip` und werden unabhängig vom `Accept-Encoding` der Anfrage
komprimiert ausgeliefert. Der Transport des Clients entpackt
gzip-/deflate-/brotli-Antworten transparent.

---

## Ressourcen & Endpoints

**Stationsübersicht (`stationOverviewExtended`).** Vorhersagen und Beobachtungen für
eine oder mehrere DWD-Wetterstationen, geliefert vom Live-Webdienst. Die Antwort ist
ein nach Stations-ID geschlüsseltes Objekt; jeder Wert enthält `forecast1`, `forecast2`,
`days`, `warnings` und `threeHourSummaries`. Client:
`client.weather.stationOverview(ids)`. CLI: `station-overview --id <stationId>`.

**Nowcast-Warnungen (`warnings_nowcast.json`).** Kurzfristige Wetterwarnungen
(„Nowcast“) – unmittelbar bevorstehendes Unwetter. Feed aus dem statischen Bucket.
Client: `client.warnings.nowcast(lang)`. CLI: `warnings nowcast`.

**Gemeindewarnungen (`gemeinde_warnings_v2.json`).** Wetterwarnungen auf
Gemeindeebene, also Warnungen, die auf die einzelne *Gemeinde* aufgelöst sind.
Statischer Feed. Client: `client.warnings.gemeinde(lang)`. CLI: `warnings gemeinde`.

**Küstenwarnungen (`warnings_coast.json`).** Wetterwarnungen für die Küste, wobei
`warnings` nach Küstenzone (und nach *Binnensee*-Gebieten) geschlüsselt ist.
Anders als die Nowcast- und Gemeindewarnungen haben die Küstenwarnungen keine
`regions`-Geometrie und kein `start`/`end`. Statischer Feed. Client:
`client.warnings.coast(lang)`. CLI: `warnings coast`.

**Crowd-Übersicht (`crowd_meldungen_overview_v2.json`).** Eine Übersicht der von
App-Nutzern eingereichten Wetter-*Meldungen*. Statischer Feed.
Client: `client.crowd()`. CLI: `crowd`.

---

## Kennungen, Einheiten & Antwortfelder

**Stations-ID.** Die Kennung einer DWD-Wetterstation, wie sie die Warnwetter-App
verwendet – meist eine 5-stellige numerische ID (z. B. München-Stadt = `10865`). In
der CLI wiederholbar (`--id 10865 --id 01766`); ein einzelner Wert kann auch eine
kommagetrennte Liste sein (`--id 10865,01766`). Beide Formen sind gleichwertig – beide
werden kommagetrennt als `stationIds=10865,01766` an den Webdienst gesendet.

**`forecast1` / `forecast2`.** Zwei Vorhersagereihen je Station in einer
Stationsübersicht. `forecast1` ist stündlich (`timeStep` 3600000) ab Mitternacht des
aktuellen Tages: `temperature` reicht zehn Tage ab `start`, die kürzeren Arrays
(`precipitationTotal`, `sunshine`, `humidity` …) sind dagegen am Ende ausgerichtet: Sie
enden bei `start` + 72 h und beginnen nicht bei `start`. `forecast2` setzt dort in Dreistundenschritten fort
(`timeStep` 10800000) und ist keine stündliche Kopie von `forecast1`.

**`days`.** Der Block mit der mehrtägigen Vorhersagezusammenfassung einer Stationsübersicht.

**`threeHourSummaries`.** Auf drei Stunden aggregierte Vorhersagezusammenfassungen
innerhalb einer Stationsübersicht.

**`warnings` (Station).** Der in eine Stationsübersicht eingebettete Warnungsblock,
also Warnungen, die für den Standort dieser Station relevant sind.

**`time`.** Der Unix-Epoch-Zeitstempel (eine `number`) im Envelope jedes Warn-Feeds;
er gibt an, wann der Feed erzeugt wurde.

**`binnenSee`.** *Binnensee.* Ein optionaler Block in den Envelopes der Nowcast- und
Gemeinde-Warnfeeds mit Warnungen für Binnenseen (große Seen). Ohne aktive Warnungen
kam er als `null` (Nowcast) bzw. `{}` (Gemeinde) zurück.

**`meldungen`.** Das Array der Crowd-Meldungen in der Crowd-Übersicht. Kann von
`start`, `end` und `highestSeverities` begleitet sein. `start`/`end` begrenzen das
Zeitfenster der Meldungen (bei der Prüfung 12 Stunden); das Feld `windowsSizeHours`
des Feeds passte nicht zu diesem Fenster, verlässlich ist der `timestamp` jeder Meldung.

**Küstenzone.** Der Schlüssel, nach dem Küstenwarnungen im Küsten-Feed gruppiert
sind (jede Zone verweist auf ihr eigenes Warnungsobjekt).

---

## Enums & Codes, die der Client liefert

**Lang (`de` | `en`).** Die Sprache eines Warn-Feeds. Deutsche Feeds (`de`, der
Standard) haben kein Dateinamen-Suffix; englische Feeds (`en`) verwenden das Suffix
`_en` (z. B. `warnings_nowcast_en.json`). Bereitgestellt als `LangValues`
(Laufzeit-Array) und als Union-Typ `Lang`, und in jedem `warnings`-Unterbefehl als
Auswahl der CLI-Option `--lang` geprüft.

---

## Feed-Envelopes (typisierte Antwortstrukturen)

**`StationOverview`.** `{ [stationId: string]: JsonObject }` – die nach Stations-ID
geschlüsselte Antwort der Stationsübersicht. Die DWD-spezifischen Nutzdaten je Station
werden als unverändertes Roh-`JsonObject` bereitgestellt statt als geratener Typ.

**`WarningsFeed`.** Der gemeinsame Envelope des Nowcast- und des Gemeinde-Feeds:
`{ time: number; warnings: JsonObject[]; binnenSee?: JsonValue }`.

**`CoastWarningsFeed`.** Der Envelope des Küsten-Feeds: `{ time: number; warnings:
JsonObject }` – `warnings` ist nach Küstenzone geschlüsselt (ein Objekt, kein Array).

**`CrowdOverview`.** Der Envelope des Crowd-Feeds: `{ start?, end?,
highestSeverities?, meldungen: JsonObject[] }`.

**`JsonObject` / `JsonValue`.** Die allgemeinen JSON-Werttypen, die dort verwendet
werden, wo Nutzdaten so umfangreich und DWD-spezifisch sind, dass eine handgeschriebene
Schnittstelle nur geraten wäre.

---

## Verhalten von API & Client

**Rate-Limiting / vorübergehende Fehler.** Das Backend kann mit **429** (Too Many
Requests) oder **503** (Service Unavailable) antworten. Der Client wiederholt diese
automatisch mit linearem Backoff – die Zahl der Retries lässt sich mit
`--max-retries` einstellen (Standard `2`); die Grundwartezeit zwischen den Versuchen
wächst linear und ist ein interner Standardwert, keine CLI-Option.

**Weiterleitungen.** Die Engine folgt bis zu `maxRedirects` (Standard `5`)
HTTP-Weiterleitungen (301/302/303/307/308). Bei einer Weiterleitung auf einen anderen
Origin werden sensible Header (`Authorization`/`X-API-Key`/`Cookie`) entfernt, sodass
Zugangsdaten für einen Host nie an einen anderen weitergegeben werden.

**Schutz vor Dekompressionsbomben.** `maxResponseBytes` (Standard 100 MiB; `0` =
unbegrenzt) begrenzt sowohl die übertragenen Bytes als auch die *entpackte* Ausgabe,
sodass ein kleiner komprimierter Feed nicht zu einem Speicherüberlauf anwachsen kann.
Beim Überschreiten wird ein `DwdNetworkError` ausgelöst.

**Content-Type-Prüfung.** Eine `200`-Antwort, deren `Content-Type` eindeutig kein
JSON ist (z. B. eine HTML-Seite eines Captive Portals), wird als `DwdParseError` mit
dem tatsächlich gelieferten Typ gemeldet, statt an `JSON.parse` übergeben zu werden.

---

> **Bibliothek & Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `DwdClient`, die Request-Engine, Transport, Retry/Backoff, Fehlertypen,
> Query-Builder, Feed-Envelope-Typen – finden Sie jetzt in
> **[DEVELOPING.md](DEVELOPING.md)** (englisch).
