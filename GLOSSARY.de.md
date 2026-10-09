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
Überschreiben in der CLI: `--base-url`; das Versionssegment im Pfad ist **`/v30`**. Der
Client ergänzt es selbst, der überschriebene Wert (Bibliothek: `baseUrl`) ist also nur
der Host (`https://app-prod-ws.warnwetter.de`). Ein Wert, der auf `/v30` endet, wird mit
einem Hinweis zurückgewiesen – von der CLI wie von der Bibliothek.

**Statischer S3-Bucket.** `https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16`
– ein Amazon-S3-Bucket, der die regelmäßig veröffentlichten Warn- und Crowd-Feeds als
statische JSON-Dateien bereithält. Überschreiben in der CLI: `--static-base-url`; das
Versionssegment im Pfad ist **`/v16`**. Der Client ergänzt es selbst, der überschriebene
Wert (Bibliothek: `staticBaseUrl`) ist also die Bucket-Wurzel; ein Wert, der auf `/v16`
endet, wird mit einem Hinweis zurückgewiesen. S3 beantwortet eine fehlende Datei mit **403**, nicht 404.

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
komma- oder leerzeichengetrennte Liste sein (`--id 10865,01766`, `--id "10865 01766"`).
Die Formen sind gleichwertig – alle werden kommagetrennt als `stationIds=10865,01766`
an den Webdienst gesendet. Der Client entfernt Leerraum um jede ID (`" 10865 "` wird
als `10865` gesendet) und weist eine leere ID oder eine mit Komma, Leerraum, `;` oder
Steuerzeichen (die API beantwortete sie mit `{}` wie eine unbekannte Station) vor jeder
Anfrage zurück – für die CLI wie für Aufrufe der Bibliothek. Eine unbekannte ID beantwortet
die API mit Status 200 und ohne Eintrag für sie (`{}` bei einer einzelnen ID);
`missingStationIds(ids, overview)` nennt solche IDs, und die CLI meldet sie auf stderr als
Hinweis, einen `INFO`-Eintrag von `dwd.api` (Exit-Code `0` unverändert).

**`forecast1` / `forecast2`.** Zwei Vorhersagereihen je Station in einer
Stationsübersicht. `forecast1` ist stündlich (`timeStep` 3600000) ab Mitternacht des
aktuellen Tages: `temperature` reicht zehn Tage ab `start`, die kürzeren Arrays
(`precipitationTotal`, `sunshine`, `humidity` …) sind dagegen am Ende ausgerichtet: Sie
enden bei `start` + 72 h und beginnen nicht bei `start`. `forecast2` setzt dort in Dreistundenschritten fort
(`timeStep` 10800000) und ist keine stündliche Kopie von `forecast1`.

**Skalierte Ganzzahlen.** Die Messwerte der Stationsdaten kommen als ganze Zahlen in
Zehnteln ihrer Einheit: `temperature`, `temperatureMin`/`Max` und `dewPoint2m` in °C,
`humidity` in %, `surfacePressure` in hPa, `windSpeed`/`windGust` in km/h,
`windDirection` in Grad, `precipitation`/`precipitationTotal` in mm und `sunshine` in
Sonnenminuten im Zeitraum (`97` sind 9,7 °C, `10216` sind 1021,6 hPa, `2700` sind 270°).
Die CLI gibt sie unverändert aus; `station-overview --decode` gibt sie in echten Einheiten
aus, über `decodeStationOverview(overview)` aus der Bibliothek (Feldliste
`STATION_SCALED_FIELDS`, Faktor `STATION_SCALE`). Dekodiert werden nur diese Zahlen:
Zeitstempel (Epoch-ms), `timeStep`, `icon`-Codes, `isDay`, die Länge der Arrays und ihre
Ausrichtung am Ende bleiben, wie sie sind, ebenso Felder mit unbestätigter Skalierung
(`temperatureStd`, `precipitationProbablity`, `cloudCoverTotal`).

**Fehlwert-Markierung (`32767`).** Das „kein Wert“ der Stationsdaten: die größte
16-Bit-Ganzzahl, die der Webdienst in ein Array skalierter Ganzzahlen setzt, wo er
keinen Wert hat – in den vergangenen Stunden des heutigen Tages an manchen Stationen
(`temperature`, `precipitationTotal`, `icon`) und in jedem `surfacePressure`-Wert,
vergangen wie künftig, an Bergstationen (Zugspitze, Feldberg, Fichtelberg …). Nach der
÷-10-Regel gelesen wären das 3276,7 °C, mm oder hPa. Der Client macht daraus `null`
(`STATION_MISSING_VALUE`, `replaceMissingValues`) in `forecast1`, `forecast2`, `days` und
`threeHourSummaries`; `null` in einem Array heißt also „kein Wert für diese Stunde“, wie
ein ganzes Array, das `null` ist.

**`days`.** Der Block mit der mehrtägigen Vorhersagezusammenfassung einer
Stationsübersicht: je lokalem Datum (`dayDate`) Tiefst- und Höchsttemperatur,
Niederschlag, Wind, Böen, Sonnenauf- und -untergang und ein Symbol; beim Abgleich
stimmten sie mit der MOSMIX-Vorhersage des DWD überein.

**`days[].sunshine`.** Nicht verlässlich. Der Wert ist entweder genau die Tagessumme der
stündlichen (`forecast1`) und dreistündlichen (`forecast2`) `sunshine`-Werte oder `0` –
und er war an etwa 44 % der geprüften künftigen Tage `0` (49 Stationen am 05. und
06.10.2026), in Phasen wechselhaften Wetters, an Tagen mit bis zu 6–7 h Sonne in den
Stundenwerten und in MOSMIX. Weder die Tageselemente von MOSMIX (`SunD`, `RSunD`) noch
ein Schwellenwert erklären die Nullen; die Regel des App-Backends ist nicht
dokumentiert. Stattdessen die Reihen je lokalem Tag summieren (das Rezept steht im Skill
`dwd-station-forecast`); für heute decken die Reihen nur die Stunden ab etwa jetzt ab.

**`threeHourSummaries`.** Auf drei Stunden aggregierte Vorhersagezusammenfassungen
innerhalb einer Stationsübersicht.

**`warnings` (Station).** Der in eine Stationsübersicht eingebettete Warnungsblock,
also Warnungen, die für den Standort dieser Station relevant sind.

**`time`.** Der Unix-Epoch-Zeitstempel (eine `number`) im Envelope jedes Warn-Feeds;
er gibt an, wann der Feed erzeugt wurde.

**`staleFeed`.** Von der CLI (nicht vom DWD) jedem ausgegebenen Warn-Feed hinzugefügt:
`true`, wenn `time` des Feeds mehr als 60 Minuten zurückliegt (`STALE_FEED_MS`; geprüft mit
`staleFeedProblem(time)`), sonst `false`. Der DWD veröffentlicht die Feeds alle paar Minuten
neu (am 2026-10-06 war der Nowcast-Feed 4 Minuten alt, Gemeinde und Küste 10), einem
veralteten Feed fehlen also die seither ausgegebenen Warnungen. Ein veralteter Feed bekommt
zusätzlich einen Hinweis auf stderr (einen `INFO`-Eintrag von `dwd.api`).

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
werden als unverändertes Roh-`JsonObject` bereitgestellt statt als geratener Typ – nur
die Fehlwert-Markierung `32767` kommt als `null`.

**`WarningsFeed`.** Der gemeinsame Envelope des Nowcast- und des Gemeinde-Feeds:
`{ time: number; warnings: JsonObject[]; binnenSee?: JsonValue }`.

**`CoastWarningsFeed`.** Der Envelope des Küsten-Feeds: `{ time: number; warnings:
JsonObject; vorabInformation?: JsonObject }` – `warnings` ist nach Küstenzone
geschlüsselt (ein Objekt, kein Array); `vorabInformation` (Vorabinformationen) ist
genauso geschlüsselt.

**`CrowdOverview`.** Der Envelope des Crowd-Feeds: `{ start?, end?, windowsSizeHours?,
highestSeverities?, meldungen: JsonObject[] }`.

**`JsonObject` / `JsonValue`.** Die allgemeinen JSON-Werttypen, die dort verwendet
werden, wo Nutzdaten so umfangreich und DWD-spezifisch sind, dass eine handgeschriebene
Schnittstelle nur geraten wäre.

**Formprüfung.** Der Client prüft nur die oberste Ebene jeder Antwort: Die
Stationsübersicht muss ein JSON-Objekt sein, die Nowcast- und Gemeinde-Feeds brauchen ein
`warnings`-Array, der Küsten-Feed ein `warnings`-Objekt und der Crowd-Feed ein
`meldungen`-Array. Alles andere (`null`, `[]`, ein Fehlerdokument von S3 oder einem Proxy)
löst einen `DwdParseError` aus (Exit `7`), statt als Feed ausgegeben zu werden.

---

## Verhalten von API & Client

**Rate-Limiting / vorübergehende Fehler.** Das Backend kann mit **429** (Too Many
Requests) oder **503** (Service Unavailable) antworten. Der Client wiederholt diese
automatisch mit linearem Backoff, oder länger, wenn das `Retry-After` der Antwort es
verlangt (bis 30 s; ein längeres wird nicht wiederholt, und der Fehler nennt die verlangte
Wartezeit), aber nie kürzer: auch `Retry-After: 0` wartet den Backoff ab – die Zahl der Retries lässt sich mit
`--max-retries` einstellen (`0`–`10`, Standard `2`); die Grundwartezeit zwischen den
Versuchen wächst linear und ist ein interner Standardwert, keine CLI-Option. Eine
abgebrochene Verbindung (Reset) wird ebenso wiederholt, ein Timeout nicht.

**Weiterleitungen.** Die Engine folgt bis zu `maxRedirects` (Standard `5`)
HTTP-Weiterleitungen (301/302/303/307/308). Jeder andere 3xx-Status (etwa `304`) wird
nicht verfolgt, sondern als API-Fehler gemeldet, der das Ziel nennt (Exit `5`). Bei einer
Weiterleitung auf einen anderen Origin werden sensible Header
(`Authorization`/`X-API-Key`/`Cookie`) entfernt, sodass Zugangsdaten für einen Host nie
an einen anderen weitergegeben werden; eine Weiterleitung auf denselben Origin (relative
oder absolute `Location`) behält sie. Ein `user:pw@` in der Basis-URL wird als dieser
`Authorization`-Header gesendet, nie in der URL selbst, und Zugangsdaten in einer
`Location` werden ignoriert.

**Schutz vor Dekompressionsbomben.** `maxResponseBytes` (Standard 100 MiB; `0` =
unbegrenzt) begrenzt sowohl die übertragenen Bytes als auch die *entpackte* Ausgabe,
sodass ein kleiner komprimierter Feed nicht zu einem Speicherüberlauf anwachsen kann.
Beim Überschreiten wird ein `DwdNetworkError` ausgelöst.

**Content-Type-Prüfung.** Eine `200`-Antwort, deren `Content-Type` eindeutig kein
JSON ist (z. B. eine HTML-Seite eines Captive Portals), wird als `DwdParseError` mit
dem tatsächlich gelieferten Typ gemeldet, statt an `JSON.parse` übergeben zu werden.

**Log-Eintrag (log record).** Jede Diagnosezeile, die die CLI nach stderr schreibt: ein
Zeitstempel, eine Stufe (`ERROR`, `WARN`, `INFO`) und ein Thema `dwd.<Bereich>`, als Text
(im Stil von log4j) oder mit `--log-format jsonl` als ein JSON-Objekt pro Zeile. Die
Bereiche: `cli` (Bedienfehler, Meldungen von commander, unerwartete Fehler), `api` (die
Antworten der API: ein Fehlerstatus, die Hinweise auf eine unbekannte Station und einen
veralteten Feed und eine fehlerhafte Antwort — ungültiges JSON, die falsche Form oder der
falsche Inhaltstyp), `http` (die Verbindung, die Klartext-Warnung) und `output` (ein
Schreibfehler auf stdout). Ein Eintrag ist immer eine Zeile; Steuerzeichen darin werden
maskiert.

---

> **Bibliothek & Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `DwdClient`, die Request-Engine, Transport, Retry/Backoff, Fehlertypen,
> Query-Builder, Feed-Envelope-Typen – finden Sie jetzt in
> **[DEVELOPING.md](DEVELOPING.md)** (englisch).
