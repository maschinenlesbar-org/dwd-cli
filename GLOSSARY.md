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
`--base-url`; the path version segment is **`/v30`**.

**Static S3 bucket.** `https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16`
— an Amazon S3 bucket holding the periodically-published warning and crowd feeds
as static JSON files. CLI override: `--static-base-url`; the path version segment
is **`/v16`**.

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
`warnings` keyed by coastal zone (and inland-lake / *Binnensee* areas). Static
feed. Client: `client.warnings.coast(lang)`. CLI: `warnings coast`.

**Crowd overview (`crowd_meldungen_overview_v2.json`).** An overview of
crowd-sourced weather reports (*Meldungen*) submitted by app users. Static feed.
Client: `client.crowd()`. CLI: `crowd`.

---

## Identifiers, units & response fields

**Station id.** The identifier of a DWD weather station, used by the Warnwetter
app — typically a 5-digit numeric id (e.g. München-Stadt = `10865`). Repeatable
on the CLI (`--id 10865 --id 01766`); sent to the web service joined by commas as
`stationIds=10865,01766`.

**`forecast1` / `forecast2`.** Two forecast series carried per station in a
station overview — hourly/short-range forecast data for that station.

**`days`.** The multi-day forecast summary block of a station overview.

**`threeHourSummaries`.** Three-hour aggregated forecast summaries within a
station overview.

**`warnings` (station).** The warnings block embedded in a station overview,
i.e. warnings relevant to that station's location.

**`time`.** The Unix-epoch timestamp (a `number`) stamped on every warning feed
envelope, marking when that feed was generated.

**`binnenSee`.** *Inland lake.* An optional block on the nowcast/gemeinde warning
envelopes carrying inland-lake (large-lake) warnings.

**`meldungen`.** The array of crowd-sourced reports in the crowd overview. May be
accompanied by `start`, `end` and `highestSeverities`.

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
payload is exposed as a faithful raw `JsonObject` rather than a guessed type.

**`WarningsFeed`.** The common envelope of the nowcast and gemeinde feeds:
`{ time: number; warnings: JsonObject[]; binnenSee?: JsonValue }`.

**`CoastWarningsFeed`.** The coast feed envelope: `{ time: number; warnings:
JsonObject }` — `warnings` is keyed by coastal zone (an object, not an array).

**`CrowdOverview`.** The crowd feed envelope: `{ start?, end?,
highestSeverities?, meldungen: JsonObject[] }`.

**`JsonObject` / `JsonValue`.** The general JSON value types used where a payload
is large and DWD-specific enough that a hand-written interface would be a guess.

---

## API & client behaviour

**Rate limiting / transient errors.** The backend may answer with **429** (too
many requests) or **503** (service unavailable). The client retries these
automatically with linear backoff — the number of retries is tunable with
`--max-retries` (default `2`); the base inter-attempt delay grows linearly and
is an internal default, not a CLI flag.

**Redirects.** The engine follows up to `maxRedirects` (default `5`) HTTP
redirects (301/302/303/307/308). On a cross-origin redirect, sensitive headers
(`Authorization`/`X-API-Key`/`Cookie`) are stripped so credentials issued for one
host are never forwarded to another.

**Decompression bomb cap.** `maxResponseBytes` (default 100 MiB; `0` = unlimited)
bounds both the wire bytes and the *decompressed* output, so a small compressed
feed cannot expand into an out-of-memory condition. Exceeding it raises a
`DwdNetworkError`.

**Content-Type guard.** A `200` response whose `Content-Type` is clearly not
JSON (e.g. a captive-portal HTML page) is reported as a `DwdParseError` naming
the type actually returned, rather than being fed to `JSON.parse`.

---

> **Library & internals.** Terms for the TypeScript client and its internals —
> `DwdClient`, the request engine, transport, retry/backoff, error types, query
> builder, feed envelope types — now live in **[DEVELOPING.md](DEVELOPING.md)**.
