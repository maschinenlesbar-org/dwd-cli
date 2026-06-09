# Developing & integrating

This document covers `dwd-cli` as a **TypeScript library**, plus its
architecture, testing and release setup. If you just want to use the
command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`dwd`) and a typed API client (`DwdClient`) for the
[DWD Warnwetter app API](https://dwd.api.bund.dev/) (`app-prod-ws.warnwetter.de`
and the static S3 bucket).

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed client surface and feed envelopes.
- **Transparent gzip** — the warning feeds are served gzip-encoded; the transport decompresses them automatically (gzip/deflate/brotli).
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.

## Build from source

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
dwd --help
```

## Library usage

```ts
import { DwdClient, DwdApiError } from "@maschinenlesbar.org/dwd-cli";

const client = new DwdClient(); // live + static defaults; no auth required

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

`client.weather.stationOverview(ids)`, `client.warnings` (`.nowcast(lang)` / `.gemeinde(lang)` / `.coast(lang)`),
and `client.crowd()`.

## Authentication internals

These endpoints require **no API key** — they are open, read-only, and
unauthenticated. `DwdClient` sends no credential headers. The CLI has no `--api-key`
option.

Redirects that cross an origin boundary (different scheme, host, or port) still
have sensitive headers (`Authorization`/`X-API-Key`/`Cookie`) stripped before
following, as a general safety measure — even though none are sent in normal
operation.

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

### Library / technical terms

**API client.** [`DwdClient`](src/client/client.ts) — the typed, resource-grouped
wrapper over the API. Usable as a library independently of the CLI. Runs two
`RequestEngine` instances (live web service + static bucket) over a single
transport, so the two-host topology is invisible to callers.

**Resource group.** A cohesive set of client methods for one part of the API
(`client.weather`, `client.warnings`) plus the standalone `client.crowd()`, and
the matching top-level CLI commands.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default uses Node's built-in
`http`/`https` and transparently decompresses gzip/deflate/brotli; tests inject a
mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, follows redirects, decodes JSON and
maps errors. Sits between the client's resource methods and the transport.
`DEFAULT_BASE_URL` is `https://app-prod-ws.warnwetter.de`.

**Query-string builder.** [`buildQueryString`](src/client/query.ts) — a
dependency-free serialiser: `undefined`/`null` omitted, arrays become repeated
keys, booleans become `"true"`/`"false"`, `Date`s become ISO-8601, spaces encoded
as `%20`.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object. Lets the whole
CLI run in tests with a mocked client and captured output — no subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `DwdApiError` (non-2xx,
carries `status`/`detail`/`isRetryable`), `DwdNetworkError` (transport
failure/timeout), `DwdParseError` (bad/non-JSON body), all extending `DwdError`.
The CLI maps `404` to exit code `4`, other API statuses to `5`, network failures
to `6`, parse failures to `7`, and any other error to `1`.

**Retry / backoff.** Transient `429` (rate limit) and `503` responses are
retried automatically with backoff, up to `--max-retries`. `DwdApiError` exposes
`isRetryable` (true for `429`/`503`).

**maxResponseBytes.** A cap on the response body size in bytes — applied to both
the wire bytes and the *decompressed* output (`0` = unlimited; default 100 MiB),
guarding against decompression bombs and unbounded responses.

**Feed envelopes (typed response shapes).**

- **`StationOverview`.** `{ [stationId: string]: JsonObject }` — the station-overview response keyed by station id.
- **`WarningsFeed`.** The common envelope of the nowcast and gemeinde feeds: `{ time: number; warnings: JsonObject[]; binnenSee?: JsonValue }`.
- **`CoastWarningsFeed`.** The coast feed envelope: `{ time: number; warnings: JsonObject }` — `warnings` is keyed by coastal zone.
- **`CrowdOverview`.** The crowd feed envelope: `{ start?, end?, highestSeverities?, meldungen: JsonObject[] }`.
- **`JsonObject` / `JsonValue`.** General JSON value types used where a payload is large and DWD-specific enough that a hand-written interface would be a guess.

**Content-Type guard.** A `200` response whose `Content-Type` is clearly not JSON
(e.g. a captive-portal HTML page) is reported as a `DwdParseError` naming the
actual type, rather than being fed to `JSON.parse`.

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

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
