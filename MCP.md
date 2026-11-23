# dwd-mcp

An [MCP](https://modelcontextprotocol.io/) server for the open data of the Deutscher Wetterdienst
(DWD) from its WarnWetter app: the official weather warnings (nowcast, Gemeinde, coast), station
forecasts and crowd-sourced weather reports, as tools for AI agents. Read-only, no API key;
free reuse with attribution (GeoNutzV).

The data lives on two DWD hosts: the live web service (`app-prod-ws.warnwetter.de`, station
forecasts) and a static bucket (`app-prod-static.warnwetter.de` on S3, the warning feeds and the
crowd reports). Both are the backend of DWD's WarnWetter app, documented by the community at
[dwd.api.bund.dev](https://dwd.api.bund.dev/), not by DWD: they can change without notice.

It is the MCP side of [dwd-cli](https://github.com/maschinenlesbar-org/dwd-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/dwd-mcp
```

This installs the **`dwd-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/dwd-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add dwd -- dwd-mcp
# or with the image:
claude mcp add dwd -- docker run -i --rm ghcr.io/maschinenlesbar-org/dwd-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "dwd": { "command": "dwd-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "dwd": { "type": "stdio", "command": "dwd-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
dwd-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http dwd http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/dwd-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/dwd-cli/releases) instead of
`latest`: `…/dwd-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/dwd-mcp:<version> --repo maschinenlesbar-org/dwd-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `getWarningBriefing` | The active warnings of the nowcast, Gemeinde and coast feeds in one list, most severe first, each with DWD's own level (1 to 4: Wetterwarnung to extreme Unwetterwarnung; the feeds' number is that + 1); for a place (lat/lon), only the warnings whose area contains it. Identical warnings over several areas counted once; advance information apart; a stale feed named. |
| `getWarningAreas` | The warning areas as a GeoJSON FeatureCollection, one feature per area, most severe first, a page at a time. |
| `getStationForecast` | A DWD station's forecast in real units, hour by hour from now and day by day (sunshine summed from the series), with the station's warnings; an unknown station id is named as missing. |
| `checkCrowdReports` | Crowd reports of the WarnWetter app near a place or a point, per category, with photos and likes as corroboration, optionally against the official warnings there; a place name matching towns far apart is reported as ambiguous. Positions rounded to about 10 km, times to the hour. |
| `getWarningFeed` | One warning feed as DWD sends it, without the areas, a page at a time. |
| `getStationOverview` | One station's overview as the web service sends it, decoded to real units. |

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from and the data licence. A failure is a tool error that says what to change.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API base URL (default https://app-prod-ws.warnwetter.de): a mirror
                           of both hosts (its /v30 and /v16 under one base); without it, each
                           host is its default
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages. With
  `--auth-token-file <path>` every request must send `Authorization: Bearer <token>` (the file holds
  one token of at least 32 characters, mode 600, owned by the user the server runs as; read once at
  start; `(umask 077; openssl rand -hex 32 > mcp-token)` makes one); anything else is answered 401.
  Exposed beyond localhost (it logs a warning then), it belongs behind a proxy that authenticates or
  at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses on HTTP 429 (as long as its Retry-After asks, at most 30 s), and stops a
  tool call after its deadline. A request those limits would hold longer than it or its call may
  wait is not sent: the call fails at once, naming the limit and when to ask again (and the log says
  so).
- **Results are data.** Text from the API is cleaned (control, bidi and zero-width characters
  removed), but it is still other people's text: a model can be told things in it. The server
  can't act on that (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new
  connection and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal
  ends it at once. On stdio it ends at once, and when stdin ends.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/dwd-cli/blob/main/LICENSING.md)).
Data: the Deutscher Wetterdienst's, under the GeoNutzV: free reuse, also commercial, with the
source named ([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/dwd-cli/blob/main/DATA_LICENSE.md)).
The tools process the data (values decoded, warnings merged, ranked and shortened), so every
result's `licence` field says "Datenbasis: Deutscher Wetterdienst, eigene Bearbeitung", the
template DWD gives for modified data. DWD has a rule of its own for warnings: an altered warning
must not be shown under a DWD source label, and the authoritative warnings are those on
[dwd.de](https://www.dwd.de/warnungen) and in the WarnWetter app. Running this server as a
service for others passes DWD's data on: the attribution and that rule go with it.
