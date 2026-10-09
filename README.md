# dwd-cli

[![CI](https://github.com/maschinenlesbar-org/dwd-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/dwd-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/dwd-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/dwd-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/dwd-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/dwd-cli)

**Website:** [English](https://maschinenlesbar-org.github.io/dwd-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/dwd-cli/de/) — command reference, guides and API docs

Query Germany's official **weather warnings, station forecasts, and crowd reports**
from your terminal. `dwd` is a small command-line tool over the open
[DWD Warnwetter app API](https://dwd.api.bund.dev/) operated by the Deutscher
Wetterdienst — no account, no API key, just data.

- **Works out of the box** — no account, no API key, no configuration. Install and run.
- **Clean JSON output** — pretty-printed by default, `--compact` for one-line/scripting.
- **Five commands** — `station-overview`, `warnings nowcast`, `warnings gemeinde`, `warnings coast`, and `crowd`.
- **Transparent gzip** — the warning feeds are served compressed; the tool decompresses them silently.
- **Read-only, open data** — these endpoints are public and unauthenticated; `dwd` only reads.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](https://github.com/maschinenlesbar-org/dwd-cli/blob/main/DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/dwd-cli
```

This installs the **`dwd`** command. Requires **Node.js 22.12+**.

Check it works:

```bash
dwd --help
```

## Quickstart

No setup needed. Your first command — current nationwide short-term warnings:

```bash
dwd warnings nowcast
```

The result is a JSON envelope with a `time` (publish timestamp) and a `warnings`
array. Count the active entries with `jq`:

```bash
dwd --compact warnings nowcast | jq '.warnings | length'
```

Fetch forecast and observation data for a DWD station (München-Stadt = `10865`):

```bash
dwd station-overview --id 10865
```

## Commands

```text
station-overview --id <stationId> [--id …]   forecasts/observations for one or more stations
warnings nowcast  [--lang de|en]             short-term (nowcast) warnings
warnings gemeinde [--lang de|en]             municipality-level warnings
warnings coast    [--lang de|en]             coastal warnings (by zone)
crowd                                        crowd-sourced reports overview
```

### `station-overview` flags

| Flag | Meaning |
| --- | --- |
| `--id <stationId>` | **Required, repeatable.** 5-digit DWD station id (e.g. `10865` for München-Stadt); one value may also be a comma- or space-separated list (`--id "10865 10147"`) |
| `--decode` | Print the scaled integers in real units (°C, %, hPa, km/h, °, mm, minutes of sun) instead of tenths |

The values are DWD's scaled integers, tenths of their unit (`97` is 9.7 °C; see
[GLOSSARY.md](https://github.com/maschinenlesbar-org/dwd-cli/blob/main/GLOSSARY.md)), except
that the API's missing-value marker `32767` is printed as `null`. With `--decode` they come in
real units (`9.7`); timestamps, icon codes and the array layout stay the same. The library
does the same with `decodeStationOverview(overview)`.

### `warnings` flags

Applies to all three `warnings` subcommands (`nowcast`, `gemeinde`, `coast`):

| Flag | Meaning |
| --- | --- |
| `--lang <lang>` | Feed language: `de` (default) or `en` |

### `crowd` flags

No flags beyond the global options.

The **[Glossary](https://github.com/maschinenlesbar-org/dwd-cli/blob/main/GLOSSARY.md)** explains domain terms — station ids, feed envelopes,
coastal zones, and the German/English equivalents.

## Two hosts

The DWD app data lives on two hosts; `dwd` talks to both automatically:

- **Live web service** — `https://app-prod-ws.warnwetter.de/v30` — used by `station-overview`.
- **Static S3 bucket** — `https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16` — used by `warnings` and `crowd`.

Override them with `--base-url` (live) and `--static-base-url` (static) if you
need to point at a proxy or staging host. Pass the host or bucket root **without**
the version segment — `--base-url https://app-prod-ws.warnwetter.de`,
`--static-base-url https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de`;
the client adds `/v30` and `/v16` itself (a value ending in them is rejected with a hint
naming the value to use; a login in it appears there as `***@`).
Credentials in the URL (`https://user:pw@proxy.example/`) are sent as HTTP Basic auth
and shown as `***` in everything the CLI prints — error messages, and the usage error
for a rejected `--base-url` / `--static-base-url` or a URL typed where a command goes.

A base URL on plain `http:` to a remote host makes the command log one warning on stderr
before its request, a `WARN` record of `dwd.http` — `… WARN  [dwd.http] requests to proxy.example are sent unencrypted (http:, not
https:)`, or `… WARN  [dwd.http] the base URL's credentials are sent unencrypted to proxy.example
(http:, not https:)` when the URL carries a login (never the login itself). Only the base URL
of the host the command talks to is checked (`--base-url` for `station-overview`,
`--static-base-url` for `warnings` and `crowd`); loopback hosts (`localhost`, `127.0.0.0/8`,
`::1`) don't warn. stdout and the exit code are unchanged.

## Common tasks

A few recipes to get going — see **[Usage.md](https://github.com/maschinenlesbar-org/dwd-cli/blob/main/Usage.md)** for the full,
use-case-driven set.

```bash
# Current nowcast warnings in English
dwd warnings nowcast --lang en

# Municipality-level warnings — find ones whose text mentions München
# (warnings have no `regionName`; search the headline/description text instead)
dwd --compact warnings gemeinde \
  | jq '.warnings[] | select(((.headLine // "") + " " + (.descriptionText // "")) | test("München"))'

# Coastal-warning zones that currently carry a warning
dwd --compact warnings coast | jq '.warnings | keys'

# Forecast for several stations at once
dwd station-overview --id 10865 --id 10147

# Address a single station from a multi-station response
dwd station-overview --id 10865 --id 10147 | jq '."10865"'

# Crowd-sourced reports — count how many were submitted
dwd --compact crowd | jq '.meldungen | length'

# Snapshot the nowcast feed to a timestamped file (cron-friendly)
dwd --compact warnings nowcast > "nowcast-$(date +%Y%m%dT%H%M).json"
```

## Output & scripting

Every command prints **pretty JSON to stdout**. Errors and diagnostics go to
stderr, so piping stdout into `jq` stays clean.

Each line on stderr is a **log record**: a timestamp (UTC), a level (`ERROR`, `WARN`,
`INFO`) and a topic, the program and the area it comes from (`dwd.cli` for usage
errors, `dwd.api` for the API's answers and the notes about them, `dwd.http` for the
connection). By default it is written log4j style; `--log-format jsonl` writes one JSON
object per line instead. A record is always one line: a line break, a control character or
a bidi control in a message (a server's text, a value you typed) is written as an escape
(`\n`, `\u001b`, `\u202e`), so it can neither split a record nor forge another one, nor
steer the terminal; a message longer than 4000 characters is cut and ends in
`… (N more characters)`:

```text
2026-10-09T14:03:12.481Z WARN  [dwd.http] requests to proxy.example are sent unencrypted (http:, not https:)
2026-10-09T14:03:12.902Z ERROR [dwd.api] HTTP 404 for GET https://app-prod-ws.warnwetter.de/v30/stationOverviewExtended?stationIds=10865: Not Found
```

```bash
dwd --log-format jsonl warnings coast 2>log.jsonl   # {"ts":"…","level":"INFO","topic":"dwd.api","msg":"coast warnings: the feed was published …"}
```

```bash
# Flatten nowcast warnings into an event/level/description TSV
# (the feed has no `headline`/`regionName`; in --lang en only event/description translate)
dwd warnings nowcast --lang en \
  | jq -r '.warnings[] | [.event, .level, .descriptionText] | @tsv'

# When was the Gemeinde feed last published? Read the time field.
dwd --compact warnings gemeinde | jq '.time'

# Is a feed stale? staleFeed is true when time is more than 60 minutes old
dwd --compact warnings coast | jq '.staleFeed'
```

The three `warnings` commands add one field to the feed they print: **`staleFeed`**, `true`
when the feed's `time` is more than 60 minutes old (`STALE_FEED_MS` in the library), else
`false`. DWD republishes the feeds every few minutes, so an hour-old feed means publishing has
stopped or a mirror serves an old copy, and warnings issued since are missing. A stale feed
also gets one note on stderr, an `INFO` record of `dwd.api` — `… INFO  [dwd.api] coast warnings: the feed was published 125 minutes ago
(time …), more than 60 minutes; …` — and the exit code stays `0`.

Use `--compact` for single-line JSON in pipelines and logs:

```bash
dwd --compact warnings nowcast | jq -c '.warnings[]'
```

`--compact` (and every global option) works **before or after** the command —
both `dwd --compact warnings nowcast` and `dwd warnings nowcast --compact` do the
same thing.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | Success (also `--help` / `--version`) |
| `2` | Bad usage / invalid argument (nothing was sent) |
| `4` | Resource not found (`404`) |
| `5` | API returned a non-404, non-success status |
| `6` | Network/transport failure (DNS, connection, timeout, oversized response, unsupported protocol, too many redirects) |
| `7` | Response body could not be parsed as JSON |
| `1` | Any other error |

A reader that stops early (`dwd crowd | head -c 100`) is ordinary use: the CLI exits `0`
quietly. If stderr's reader is gone (`2>&1 | true`), a failed run still exits with its
own code.

## Troubleshooting

- **`command not found: dwd`** — the global npm bin directory isn't on your
  `PATH`. Run `npm prefix -g` to find the prefix and add its `bin` directory
  (`"$(npm prefix -g)/bin"`), or run via
  `npx @maschinenlesbar.org/dwd-cli …`.
- **Exit `4` / "not found"** — a requested feed or resource returned `404`. Note
  that an unknown **station id** is *not* a 404: `station-overview` returns `{}`
  with exit `0` for an id the catalogue doesn't know (and drops unknown ids from a
  multi-id response), so empty `{}` there means a bad id, not a server error. The CLI
  says so on stderr — `… INFO  [dwd.api] no data for station id 99999 — the API answers an unknown
  id with nothing, not an error` — and stdout and the exit code stay as they are. Double-check the id against the DWD Warnwetter app; DWD station ids are
  typically 5-digit numeric codes.
- **Exit `5` / API error** — the upstream service returned an unexpected status.
  The service is public but may be temporarily unavailable; retry later. With a
  custom `--static-base-url`, an `HTTP 403` usually means a wrong path, not an
  outage: S3 answers a missing file with `403`.
- **Exit `6` / network error** — connectivity, DNS, or a timeout. Try again, or
  raise the limit with `--timeout 60000`. If a feed is large and getting cut off,
  try `--max-response-bytes 0` (unlimited).
- **Exit `7` / parse error** — the response wasn't valid JSON (e.g. a captive-portal
  HTML page). Check your network path; captive portals often intercept HTTPS on
  public Wi-Fi.
- **Empty `warnings` array** — the feed is live but no warnings are currently
  active. That's the normal situation when the weather is calm.

## Global options

These apply to every command and may be given **before or after** it:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--log-format <format>` | How errors, warnings and notes are written to stderr: `text` (default; log4j style, `2026-10-09T14:03:12.481Z WARN  [dwd.http] …`) or `jsonl` (one JSON object per line: `ts`, `level`, `topic`, `msg`). stdout is not affected |
| `--base-url <url>` | Live web-service base URL, without `/v30` (default `https://app-prod-ws.warnwetter.de`) |
| `--static-base-url <url>` | Static S3 bucket base URL, without `/v16` (default `https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de`) |
| `--timeout <ms>` | Time limit per request attempt, reading the whole response included (default `30000`; `0` = no timeout; at most `2147483647`). Each retry gets the full limit again, so a run with retries can take longer than `--timeout` |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses and reset connections (`0`–`10`, default `2`). Each retry backs off linearly from 200 ms, or waits longer if the server's `Retry-After` asks (up to 30 s; a longer one is not retried, and the error names the requested wait) — never shorter |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

> An option that takes a value consumes the **next token** as that value, so give
> a value-taking option its value explicitly: `--user-agent "my-tool" --compact`,
> not `--user-agent --compact` (which would treat the literal `--compact` as the
> User-Agent and silently drop the flag).

## Learn more

- **[SKILLS.md](https://github.com/maschinenlesbar-org/dwd-cli/blob/main/SKILLS.md)** — Claude Code Agent Skills that drive this CLI for real-world weather questions.
- **[Usage.md](https://github.com/maschinenlesbar-org/dwd-cli/blob/main/Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](https://github.com/maschinenlesbar-org/dwd-cli/blob/main/GLOSSARY.md)** — domain terms, station ids, feed envelopes, and exit codes.
- **[DEVELOPING.md](https://github.com/maschinenlesbar-org/dwd-cli/blob/main/DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

## Data license

This CLI is a **client** — it accesses data it does not own or redistribute. The
upstream data is © its provider and licensed **separately from this tool's code**.
See **[DATA_LICENSE.md](DATA_LICENSE.md)**.

> **Deutscher Wetterdienst** — GeoNutzV / CC BY 4.0. Attribution required ("Quelle:
> Deutscher Wetterdienst"); commercial use allowed. Special rule: if you *modify* an
> official warning, the DWD source label must be removed.

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
