# dwd-cli

[![CI](https://github.com/maschinenlesbar-org/dwd-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/dwd-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/dwd-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/dwd-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/dwd-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/dwd-cli)

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
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/dwd-cli
```

This installs the **`dwd`** command. Requires **Node.js 20+**.

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
| `--id <stationId>` | **Required, repeatable.** 5-digit DWD station id (e.g. `10865` for München-Stadt) |

### `warnings` flags

Applies to all three `warnings` subcommands (`nowcast`, `gemeinde`, `coast`):

| Flag | Meaning |
| --- | --- |
| `--lang <lang>` | Feed language: `de` (default) or `en` |

### `crowd` flags

No flags beyond the global options.

The **[Glossary](GLOSSARY.md)** explains domain terms — station ids, feed envelopes,
coastal zones, and the German/English equivalents.

## Two hosts

The DWD app data lives on two hosts; `dwd` talks to both automatically:

- **Live web service** — `https://app-prod-ws.warnwetter.de/v30` — used by `station-overview`.
- **Static S3 bucket** — `https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16` — used by `warnings` and `crowd`.

Override them with `--base-url` (live) and `--static-base-url` (static) if you
need to point at a proxy or staging host.

## Common tasks

A few recipes to get going — see **[Usage.md](Usage.md)** for the full,
use-case-driven set.

```bash
# Current nowcast warnings in English
dwd warnings nowcast --lang en

# Municipality-level warnings — find ones mentioning München
dwd --compact warnings gemeinde | jq '.warnings[] | select(.regionName | test("München"))'

# Coastal-warning zones that currently carry a warning
dwd --compact warnings coast | jq '.warnings | keys'

# Forecast for several stations at once
dwd station-overview --id 10865 --id 01766

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

```bash
# Flatten nowcast warnings into a headline/region/event TSV
dwd warnings nowcast --lang en \
  | jq -r '.warnings[] | [.headline, .regionName, .event] | @tsv'

# When was the Gemeinde feed last published? Read the time field.
dwd --compact warnings gemeinde | jq '.time'
```

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
| `6` | Network/transport failure (DNS, connection, timeout, oversized response) |
| `7` | Response body could not be parsed as JSON |
| `1` | Any other error |

## Troubleshooting

- **`command not found: dwd`** — the global npm bin directory isn't on your
  `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/dwd-cli …`.
- **Exit `4` / "not found"** — the station id doesn't exist in the DWD catalogue.
  Double-check the id against the DWD Warnwetter app or docs; DWD station ids are
  typically 5-digit numeric codes.
- **Exit `5` / API error** — the upstream service returned an unexpected status.
  The service is public but may be temporarily unavailable; retry later.
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
| `--base-url <url>` | Live web-service base URL (default `https://app-prod-ws.warnwetter.de`) |
| `--static-base-url <url>` | Static S3 bucket base URL |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

## Learn more

- **[SKILLS.md](SKILLS.md)** — Claude Code Agent Skills that drive this CLI for real-world weather questions.
- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — domain terms, station ids, feed envelopes, and exit codes.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

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
