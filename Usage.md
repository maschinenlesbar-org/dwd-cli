# Usage — `dwd`

Use-case-driven examples for the `dwd` CLI, a read-only client for the open
[DWD Warnwetter app API](https://dwd.api.bund.dev/) (warnwetter.de): station
forecasts/observations and the published weather-warning feeds (nowcast,
municipality/Gemeinde, coastal) plus crowd-sourced reports. Every command prints
pretty JSON to stdout, so it composes cleanly with `jq`.

## Install

```bash
npm i -g @maschinenlesbar.org/dwd-cli
```

This installs the `dwd` binary. Without a global install you can run it straight
from a built checkout:

```bash
node dist/src/cli/index.js --help
```

All examples below use the installed bin name `dwd`.

## Use cases

### 1. Forecast/observation for a single station

Pull the current forecast/observation payload for one DWD station (e.g.
München-Stadt, id `10865`).

```bash
dwd station-overview --id 10865
```

Output is a JSON object keyed by station id. Each value carries the raw DWD
fields (`forecast1`, `forecast2`, `days`, `warnings`, `threeHourSummaries`) as scaled
integers (most ÷ 10, see [GLOSSARY.md](GLOSSARY.md)). The one change: the API's
missing-value marker `32767` is printed as `null` — expect `null` inside the arrays
(today's past hours at some stations, every `surfacePressure` value at mountain
stations), and skip it in sums and averages.

### 2. Compare several stations in one call

Fetch multiple stations at once by repeating `--id` — handy for a small dashboard
or a city-vs-city comparison.

```bash
dwd station-overview --id 10865 --id 10147
```

The result is keyed per station, so you can address each independently:
`jq '."10865"'`. An id the API doesn't know is left out of the answer (exit `0`); the CLI
names it on stderr: `note: no data for station id 99999 — the API answers an unknown id with
nothing, not an error`.

### 3. List which monitored stations currently have active warnings

`--compact` keeps it to one line for scripts; `jq` surfaces only the stations
whose payload contains warnings.

```bash
dwd --compact station-overview --id 10865 --id 10147 \
  | jq 'to_entries | map(select(.value.warnings != null and (.value.warnings | length) > 0)) | from_entries'
```

### 4. Current nationwide nowcast (short-term) warnings

The nowcast feed is the short-fuse warning layer (e.g. imminent thunderstorms).

```bash
dwd warnings nowcast
```

The feed envelope has a `time` (publish timestamp) and a `warnings` array. The CLI adds
`staleFeed` to every warning feed it prints: `true` when `time` is more than 60 minutes old
(DWD republishes every few minutes, so warnings issued since are missing), with a `note:`
line on stderr; `false` otherwise. Count the active entries:

```bash
dwd --compact warnings nowcast | jq '.warnings | length'
```

### 5. Nowcast warnings in English for a quick triage table

Switch the feed language with `--lang en`, then flatten event + severity level +
description into a compact table with `jq`. (The feed has no `headline`/`regionName`
fields; in `--lang en` only `event`/`descriptionText` are translated.)

```bash
dwd warnings nowcast --lang en \
  | jq -r '.warnings[] | [.event, .level, .descriptionText] | @tsv'
```

`--lang` accepts `de` (default) or `en`.

### 6. Municipality-level (Gemeinde) warnings

The Gemeinde feed resolves warnings down to municipality granularity — the layer
the app uses when you select your home town.

```bash
dwd warnings gemeinde --lang de
```

Same envelope shape as nowcast (`time` + `warnings[]`). Warnings carry no
`regionName` field (only `regions[]` geometry), so to find ones mentioning a
specific town, search the headline/description text:

```bash
dwd --compact warnings gemeinde \
  | jq '.warnings[] | select(((.headLine // "") + " " + (.descriptionText // "")) | test("München"))'
```

### 7. Coastal warnings by zone

Coastal warnings (gale/storm-surge style) for boating and the coast. Here the
`warnings` field is an object keyed by coastal zone rather than a flat array.

```bash
dwd warnings coast
```

List the zones that currently carry a warning:

```bash
dwd --compact warnings coast | jq '.warnings | keys'
```

### 8. Crowd-sourced weather reports overview

The crowd feed is the user-submitted reports overview (`meldungen`), useful as a
ground-truth cross-check against the official warnings.

```bash
dwd crowd
```

Count the submitted reports:

```bash
dwd --compact crowd | jq '.meldungen | length'
```

### 9. Snapshot a feed to a timestamped file (cron-friendly)

`--compact` plus a redirect gives you an archivable one-line snapshot per run.

```bash
dwd --compact warnings nowcast > "nowcast-$(date +%Y%m%dT%H%M).json"
```

### 10. Harden a call behind a flaky network

Tighten the timeout, cap the response size, and identify yourself politely —
all global options that apply to any command.

```bash
dwd --timeout 10000 --max-retries 3 --user-agent "my-monitor/1.0" \
    --max-response-bytes 5242880 \
    warnings gemeinde
```

`--timeout` bounds each attempt, not the whole command: with `--max-retries 3` a run can take up
to four timeouts plus the waits between them. Bound the whole run from outside if you need to
(for example with coreutils: `timeout 60 dwd …`).

## Global options recap

Global options may be given **before or after** the command — both
`dwd --compact warnings nowcast` and `dwd warnings nowcast --compact` work.

| Option | Description |
| --- | --- |
| `-V, --version` | Output the version number |
| `--base-url <url>` | Live web-service base URL, without `/v30` (default `https://app-prod-ws.warnwetter.de`) — used by `station-overview` |
| `--static-base-url <url>` | Static (S3) bucket base URL, without `/v16` (default `https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de`) — used by the `warnings` and `crowd` feeds |
| `--timeout <ms>` | Time limit per request attempt in milliseconds, reading the whole response included (default `30000`; `0` = no timeout; at most `2147483647`). Each retry gets the full limit again |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses and reset connections (`0`–`10`, default `2`; each backs off linearly from 200 ms, or longer if the server's `Retry-After` asks, up to 30 s) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default `104857600` / 100 MiB) |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-h, --help` | Display help for a command |

A base URL on plain `http:` to a remote host (not `localhost`, `127.0.0.0/8` or `::1`) gets one
`warning: … sent unencrypted to <host> (http:, not https:)` line on stderr before the command's
request; stdout and the exit code are unchanged. Only the base URL the command uses is checked.

### Command flags

| Command | Flag | Notes |
| --- | --- | --- |
| `station-overview` | `--id <stationId>` | **Required**, repeatable; 5-digit DWD station id |
| `warnings nowcast` | `--lang <lang>` | `de` (default) or `en` |
| `warnings gemeinde` | `--lang <lang>` | `de` (default) or `en` |
| `warnings coast` | `--lang <lang>` | `de` (default) or `en` |
| `crowd` | — | No flags beyond globals |
