# dwd-cli

A TypeScript **API client** and **command-line interface** for the open
[DWD Warnwetter app API](https://dwd.api.bund.dev/) operated by the **Deutscher
Wetterdienst** — station **forecasts/observations** and the published **weather
warning** feeds (nowcast, municipality, coastal) plus crowd-sourced reports.

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed client surface and feed envelopes.
- **Transparent gzip** — the warning feeds are served gzip-encoded; the transport decompresses them.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — these endpoints need no key; this client only reads.

## Two hosts

The DWD app data lives on two hosts, and this client talks to both:

- **Live web service** — `https://app-prod-ws.warnwetter.de/v30` — station overviews/forecasts (queried with parameters).
- **Static S3 bucket** — `https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16` — the periodically-published warning feeds (gzip JSON).

Override them with `--base-url` (live) and `--static-base-url` (static).

## Requirements

- Node.js **>= 20** (uses the stable built-in test runner, ESM and top-level `await`).

## Install

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link` / global install:
dwd --help
```

---

## CLI usage

Every command prints pretty JSON to stdout (`--compact` for a single line).

### Global options

| Option | Description |
| --- | --- |
| `--base-url <url>` | live web-service base URL (default `https://app-prod-ws.warnwetter.de`) |
| `--static-base-url <url>` | static S3 bucket base URL |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line |

Global options go **before** the command, e.g. `dwd --compact warnings nowcast`.

### Commands

```text
station-overview --id <stationId> [--id <stationId> ...]   forecasts/observations
warnings nowcast  [--lang de|en]    short-term (nowcast) warnings
warnings gemeinde [--lang de|en]    municipality-level warnings
warnings coast    [--lang de|en]    coastal warnings (by zone)
crowd                               crowd-sourced reports overview
```

### Examples

```bash
# Forecast/observation for a station (München-Stadt = 10865)
dwd station-overview --id 10865

# Several stations at once
dwd station-overview --id 10865 --id 01766

# Current nowcast warnings, English
dwd warnings nowcast --lang en

# Municipality-level warnings
dwd warnings gemeinde
```

DWD station ids are the 5-digit ids used by the Warnwetter app (e.g. `10865`).

Exit codes: `0` success, `4` on a `404` from the API, `1` for any other error, non-zero for usage errors.

---

## Library usage

```ts
import { DwdClient, DwdApiError } from "dwd-cli";

const client = new DwdClient(); // live + static defaults

const overview = await client.weather.stationOverview(["10865"]);
const nowcast = await client.warnings.nowcast("de");
const gemeinde = await client.warnings.gemeinde("en");
const crowd = await client.crowd();

try {
  await client.weather.stationOverview(["nope"]);
} catch (err) {
  if (err instanceof DwdApiError) console.error(err.status, err.detail);
}
```

### Client options

```ts
new DwdClient({
  baseUrl: "https://app-prod-ws.warnwetter.de",          // live web service
  staticBaseUrl: "https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de",
  timeoutMs: 15_000,
  maxRetries: 3,              // 429 / 503 are retried with linear backoff
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

### Resource groups

`client.weather.stationOverview(ids)`, `client.warnings` (`.nowcast` / `.gemeinde` / `.coast`),
and `client.crowd()`.

---

## Architecture

```
src/
  client/
    enums.ts     # Lang (de|en) value set (runtime + type)
    types.ts     # feed envelopes (station overview / warnings exposed as JsonObject)
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + node:http/https transport with gzip/deflate/br decoding
    engine.ts    # URL building, retry/backoff, redirects, JSON decoding, error mapping
    errors.ts    # DwdError / DwdApiError / DwdNetworkError / DwdParseError
    client.ts    # DwdClient — two engines (live ws + static bucket) over one transport
  cli/
    io.ts        # injectable I/O seam (stdout/stderr/file)
    shared.ts    # option parsers, global-option resolver, JSON renderer
    commands/    # station-overview / warnings / crowd
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Design notes**

- The HTTP layer is a single `Transport` function (`(req) => Promise<HttpResponse>`). The default
  uses `node:http`/`node:https` and transparently decompresses gzip, deflate (both zlib-wrapped and raw
  DEFLATE) and brotli bodies; decoding runs asynchronously (off the event loop) and the decompressed
  output is bounded by `maxResponseBytes` so a small compressed body cannot expand into an
  out-of-memory "decompression bomb". Tests inject a mock.
- The client runs two `RequestEngine` instances (live + static host) sharing the same options/transport,
  so the two-host topology is invisible to callers. Redirects are followed up to `maxRedirects`; if a
  redirect crosses to a different origin, sensitive headers (`Authorization`/`X-API-Key`/`Cookie`) are
  stripped so credentials issued for one host are never forwarded to another.
- The CLI is built around injectable `CliDeps` (client factory + I/O), so the whole program can be
  driven in-process by tests with a mocked client and captured output — no subprocesses.

---

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`: gzip/deflate
  (zlib + raw)/brotli decoding, malformed-body handling, the decompressed-size cap, and the timeout path.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, redirect following,
  `maxRedirects` exhaustion, and cross-origin credential stripping — mocked transport.
- **`client.test.ts`** — host routing (live vs static), URL/query mapping, language suffixes — mocked transport.
- **`cli.test.ts`** — end-to-end command parsing, validation and exit codes — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*` tag.

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
