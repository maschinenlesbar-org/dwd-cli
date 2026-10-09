# Glossary

A reference for the domain concepts and project-specific terms used throughout
`dwd-cli`. The data comes from the **Deutscher Wetterdienst (DWD)** Warnwetter
app backend (`warnwetter.de`); the domain is German, so this glossary gives the
English term used in the CLI/API alongside the original German where one exists.

> **Translation table.** The CLI follows these:
>
> | German | English / API term |
> | --- | --- |
> | Warnung | warning |
> | Gemeinde | municipality |
> | Küste / Binnensee | coast / inland lake |
> | Vorhersage | forecast |
> | Meldung | (crowd-sourced) report |
> | Wetterstation | weather station |

---

## The DWD Warnwetter source

**DWD — Deutscher Wetterdienst.** Germany's national meteorological service.
It operates the public weather-warning system and the *Warnwetter* app, whose
backend this tool wraps.

**Warnwetter app.** DWD's official weather-warning app for the public. Its
backend serves both live station forecasts and the periodically-published
warning feeds; both are open (no authentication) and read-only.

**warnwetter.de.** The host domain of the Warnwetter backend. The data is split
across two hosts (see *Live web service* and *Static S3 bucket*).

**Open / no-auth endpoints.** The endpoints this client uses require no API key.
They are all `GET` and read-only; `dwd-cli` never writes.

---

## The two hosts

**Live web service.** `https://app-prod-ws.warnwetter.de/v30` — the live backend
that answers station-overview requests, queried with parameters. CLI override:
`--base-url` (library: `baseUrl`); the path version segment is **`/v30`**, which the
client adds, so the override is the host alone (`https://app-prod-ws.warnwetter.de`).
A value ending in `/v30` is rejected with a hint, by the CLI and the library alike.

**Static S3 bucket.** `https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16`
— an Amazon S3 bucket holding the periodically-published warning and crowd feeds
as static JSON files. CLI override: `--static-base-url`; the path version segment
is **`/v16`**, which the client adds, so the override is the bucket root (library:
`staticBaseUrl`); a value ending in `/v16` is rejected with a hint. S3 answers a
missing file with **403**, not 404.

**gzip-encoded feeds.** The static warning files are stored on S3 with
`Content-Encoding: gzip` and are served compressed regardless of the request's
`Accept-Encoding`. The client's transport transparently decompresses
gzip/deflate/brotli bodies.

---

## Resources & endpoints

**Station overview (`stationOverviewExtended`).** Forecasts/observations for one
or more DWD weather stations, returned by the live web service. The response is
an object keyed by station id; each value carries `forecast1`, `forecast2`,
`days`, `warnings` and `threeHourSummaries`. Client:
`client.weather.stationOverview(ids)`. CLI: `station-overview --id <stationId>`.

**Nowcast warnings (`warnings_nowcast.json`).** Short-term ("nowcast") weather
warnings — imminent severe weather. Static-bucket feed. Client:
`client.warnings.nowcast(lang)`. CLI: `warnings nowcast`.

**Gemeinde warnings (`gemeinde_warnings_v2.json`).** Municipality-level weather
warnings, i.e. warnings resolved to the German *Gemeinde* (municipality). Static
feed. Client: `client.warnings.gemeinde(lang)`. CLI: `warnings gemeinde`.

**Coast warnings (`warnings_coast.json`).** Coastal weather warnings, with
`warnings` keyed by coastal zone (and inland-lake / *Binnensee* areas). Unlike
the nowcast and Gemeinde items, coast items carry no `regions` geometry and no
`start`/`end`. Static feed. Client: `client.warnings.coast(lang)`. CLI:
`warnings coast`.

**Crowd overview (`crowd_meldungen_overview_v2.json`).** An overview of
crowd-sourced weather reports (*Meldungen*) submitted by app users. Static feed.
Client: `client.crowd()`. CLI: `crowd`.

---

## Identifiers, units & response fields

**Station id.** The identifier of a DWD weather station, used by the Warnwetter
app — typically a 5-digit numeric id (e.g. München-Stadt = `10865`). Repeatable
on the CLI (`--id 10865 --id 01766`); a single value may also be a comma- or
space-separated list (`--id 10865,01766`, `--id "10865 01766"`), and the forms are
equivalent — all are sent to the web service joined by commas as
`stationIds=10865,01766`. The client trims each id (`" 10865 "` is sent as `10865`)
and rejects a blank id, or one containing a comma, whitespace, `;` or a control
character (the API would answer such an id with `{}`, like an unknown station), before
any request, for the CLI and library callers alike. An unknown id is answered with status
200 and no entry for it (`{}` for one id); `missingStationIds(ids, overview)` names such
ids, and the CLI logs them as a note on stderr, an `INFO` record of `dwd.api` (exit `0` unchanged).

**`forecast1` / `forecast2`.** Two forecast series carried per station in a
station overview. `forecast1` is hourly (`timeStep` 3600000) from midnight of the
current day: `temperature` runs ten days from `start`, while the shorter arrays
(`precipitationTotal`, `sunshine`, `humidity`, …) are end-aligned at `start` + 72 h
rather than anchored at `start`. `forecast2` continues from there in three-hour
steps (`timeStep` 10800000); it is not an hourly copy of `forecast1`.

**Scaled integers.** The station data's measurements come as whole numbers in tenths of
their unit: `temperature`, `temperatureMin`/`Max` and `dewPoint2m` in °C, `humidity` in %,
`surfacePressure` in hPa, `windSpeed`/`windGust` in km/h, `windDirection` in degrees,
`precipitation`/`precipitationTotal` in mm and `sunshine` in minutes of sun in the period
(`97` is 9.7 °C, `10216` is 1021.6 hPa, `2700` is 270°). The CLI prints them as delivered;
`station-overview --decode` prints them in real units, through the library's
`decodeStationOverview(overview)` (field list `STATION_SCALED_FIELDS`, factor
`STATION_SCALE`). Decoding changes only those numbers: timestamps (epoch ms), `timeStep`,
`icon` codes, `isDay`, the array lengths and their end-alignment stay as they are, and so
do fields whose scale is not confirmed (`temperatureStd`, `precipitationProbablity`,
`cloudCoverTotal`).

**Missing-value marker (`32767`).** The station data's "no value": the largest
16-bit integer, which the web service puts into a scaled-integer array where it has no
value — today's past hours at some stations (`temperature`, `precipitationTotal`,
`icon`), and every `surfacePressure` value, past and future, at mountain stations
(Zugspitze, Feldberg, Fichtelberg, …). Read with the ÷ 10 rule it would be
3276.7 °C, mm or hPa. The client turns it into `null` (`STATION_MISSING_VALUE`,
`replaceMissingValues`) in `forecast1`, `forecast2`, `days` and `threeHourSummaries`,
so `null` inside an array means "no value for this hour", like a whole array that is
`null`.

**`days`.** The multi-day forecast summary block of a station overview: per local
date (`dayDate`) the min/max temperature, precipitation, wind, gust, sunrise/sunset
and an icon, which matched DWD's MOSMIX forecast when checked.

**`days[].sunshine`.** Not reliable. It is either exactly the day's sum of the hourly
(`forecast1`) and 3-hourly (`forecast2`) `sunshine` values, or `0` — and it was `0` on
about 44 % of the future days checked (49 stations on 2026-10-05 and 06), in runs of
unsettled weather, on days with up to 6–7 h of sun in the hourly data and in MOSMIX.
Neither MOSMIX's daily elements (`SunD`, `RSunD`) nor any threshold explains the zeros;
the app backend's rule is not documented. Sum the series per local day instead (the
`dwd-station-forecast` skill has the recipe); for today the series only cover the hours
from about now.

**`threeHourSummaries`.** Three-hour aggregated forecast summaries within a
station overview.

**`warnings` (station).** The warnings block embedded in a station overview,
i.e. warnings relevant to that station's location.

**`time`.** The Unix-epoch timestamp (a `number`, milliseconds) stamped on every warning
feed envelope, marking when that feed was generated. A feed without one, or with one no
date can hold (beyond ±8.64e15 ms), is a malformed answer (exit `7`).

**`staleFeed`.** Added by the CLI (not DWD) to every warning feed it prints: `true` when the
feed's `time` is more than 60 minutes old (`STALE_FEED_MS`; checked with
`staleFeedProblem(time)`), else `false`. DWD republishes the feeds every few minutes (on
2026-10-06 the nowcast feed was 4 minutes old, Gemeinde and coast 10), so a stale feed misses
the warnings issued since. A stale feed also gets a note on stderr (an `INFO` record of `dwd.api`).

**`binnenSee`.** *Inland lake.* An optional block on the nowcast/gemeinde warning
envelopes carrying inland-lake (large-lake) warnings. With none active it has come
back as `null` (nowcast) and `{}` (gemeinde).

**`meldungen`.** The array of crowd-sourced reports in the crowd overview. May be
accompanied by `start`, `end` and `highestSeverities`. `start`/`end` bound the
window the reports cover (12 hours when checked); the feed's `windowsSizeHours`
field did not match that window, so each report's `timestamp` is the reliable time.

**Coastal zone.** The key by which coastal warnings are grouped in the coast
feed (each zone maps to its own warnings object).

---

## Enums & codes the client surfaces

**Lang (`de` | `en`).** The language of a warning feed. German (`de`, the
default) feeds have no filename suffix; English (`en`) feeds use the `_en`
filename suffix (e.g. `warnings_nowcast_en.json`). Exposed as `LangValues`
(runtime array) and the `Lang` union type, and validated as the CLI `--lang`
choice on every `warnings` subcommand.

---

## Feed envelopes (typed response shapes)

**`StationOverview`.** `{ [stationId: string]: JsonObject }` — the
station-overview response keyed by station id. The DWD-specific per-station
payload is exposed as a faithful raw `JsonObject` rather than a guessed type — except
that the missing-value marker `32767` comes back as `null`.

**`WarningsFeed`.** The common envelope of the nowcast and gemeinde feeds:
`{ time: number; warnings: JsonObject[]; binnenSee?: JsonValue }`.

**`CoastWarningsFeed`.** The coast feed envelope: `{ time: number; warnings:
JsonObject; vorabInformation?: JsonObject }` — `warnings` is keyed by coastal zone
(an object, not an array); `vorabInformation` (advance information) is keyed the same
way.

**`CrowdOverview`.** The crowd feed envelope: `{ start?, end?, windowsSizeHours?,
highestSeverities?, meldungen: JsonObject[] }`.

**`JsonObject` / `JsonValue`.** The general JSON value types used where a payload
is large and DWD-specific enough that a hand-written interface would be a guess.

**Shape check.** The client checks only the top level of each response: the
station overview must be a JSON object, the nowcast/gemeinde feeds need a `warnings`
array, the coast feed a `warnings` object and the crowd feed a `meldungen` array.
Anything else (`null`, `[]`, an error document from S3 or a proxy) raises a
`DwdParseError` (exit `7`) instead of being printed as a feed.

---

## API & client behaviour

**Rate limiting / transient errors.** The backend may answer with **429** (too
many requests) or **503** (service unavailable). The client retries these
automatically, backing off linearly, or longer if the response's `Retry-After` asks
(up to 30 s; a longer one is not retried, and the error names the requested wait), but
never shorter: `Retry-After: 0` still waits the backoff — the number of retries is tunable with
`--max-retries` (`0`–`10`, default `2`); the base inter-attempt delay grows linearly
and is an internal default, not a CLI flag. A reset connection is retried the same way;
a timeout is not.

**Redirects.** The engine follows up to `maxRedirects` (default `5`) HTTP
redirects (301/302/303/307/308). Any other 3xx (such as `304`) is not followed: it
surfaces as an API error that names the target (exit `5`). On a cross-origin
redirect, sensitive headers (`Authorization`/`X-API-Key`/`Cookie`) are stripped so
credentials issued for one host are never forwarded to another; a same-origin redirect
(relative or absolute `Location`) keeps them. A base URL's `user:pw@` is sent as that
`Authorization` header, never inside the URL, and a `Location`'s own userinfo is
ignored.

**Decompression bomb cap.** `maxResponseBytes` (default 100 MiB; `0` = unlimited)
bounds both the wire bytes and the *decompressed* output, so a small compressed
feed cannot expand into an out-of-memory condition. Exceeding it raises a
`DwdNetworkError`.

**Content-Type guard.** A `200` response whose `Content-Type` is clearly not
JSON (e.g. a captive-portal HTML page) is reported as a `DwdParseError` naming
the type actually returned, rather than being fed to `JSON.parse`.

**Log record.** Every diagnostic line the CLI writes to stderr: a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic `dwd.<area>`, as text (log4j style) or with
`--log-format jsonl` as one JSON object per line. The areas: `cli` (usage errors,
commander's messages, unexpected errors), `api` (the API's answers: an error status, the
unknown-station and stale-feed notes, and a malformed answer — bad JSON, the wrong shape or
content type), `http` (the connection, the cleartext warning) and `output` (a failed write
to stdout). A record is always one line; control characters in it are escaped.

---

> **Library & internals.** Terms for the TypeScript client and its internals —
> `DwdClient`, the request engine, transport, retry/backoff, error types, query
> builder, feed envelope types — now live in **[DEVELOPING.md](DEVELOPING.md)**.
