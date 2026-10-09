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
import { DwdClient, DwdApiError, decodeStationOverview, missingStationIds } from "@maschinenlesbar.org/dwd-cli";

const client = new DwdClient(); // live + static defaults; no auth required

const overview = await client.weather.stationOverview(["10865"]);
// Tenths of a unit as delivered (temperature 97); decoded: 9.7 (°C). Once, never twice.
const real = decodeStationOverview(overview);
const nowcast = await client.warnings.nowcast("de");
const gemeinde = await client.warnings.gemeinde("en");
const crowd = await client.crowd();

// An unknown station id is not an error: the API answers {} (and drops unknown
// ids from a multi-id request). missingStationIds names them (the CLI prints a
// stderr note from it).
const unknown = await client.weather.stationOverview(["nope"]); // {}
for (const id of missingStationIds(["nope"], unknown)) console.error(`no such station: ${id}`);

// A non-2xx status (the service down, a feed missing) throws DwdApiError.
try {
  await client.crowd();
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
  maxRetries: 3,              // 429 / 503 are retried (Retry-After, else linear backoff)
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

### Resource groups

`client.weather.stationOverview(ids)`, `client.warnings` (`.nowcast(lang)` / `.gemeinde(lang)` / `.coast(lang)`),
and `client.crowd()`. The arguments are checked before any request, as the CLI
does: `lang` must be `"de"` or `"en"` (else a `DwdValidationError`). `ids` are trimmed
(`normalizeStationIds`, so `" 10865 "` is sent as `10865`) and must then be a
non-empty list of non-blank ids without commas, whitespace, `;` or control characters
(`stationIdProblem`); anything else rejects with a `DwdValidationError` (an empty slot
in `stationIds`, or `10865 10147` sent as one id, would come back as `{}`, like an
unknown station). The CLI only splits an `--id` value on commas and whitespace.

The warning feeds come back as DWD published them. `staleFeedProblem(time, now?, maxAgeMs?)`
says whether one is stale — its `time` more than `STALE_FEED_MS` (60 minutes) old — as a
sentence, or `undefined`. The CLI's `warnings` commands print the feed with a `staleFeed`
boolean added after DWD's keys and, for a stale one, a note on stderr (an `INFO`
record of `dwd.api`, `<feed> warnings: <sentence>`); the library adds no field.

## Authentication internals

These endpoints require **no API key** — they are open, read-only, and
unauthenticated. `DwdClient` sends no credential headers. The CLI has no `--api-key`
option.

The one credential the client can send is the userinfo of a base URL you set
(`https://user:pw@mirror/`, for a proxy or mirror behind a login). The engine never
puts it into the URL a transport sees: it sends it as an `Authorization: Basic` header
per hop. A redirect to the same origin (scheme, host and port), with a relative or an
absolute `Location`, keeps it; one that crosses an origin boundary has the sensitive
headers (`Authorization`/`X-API-Key`/`Cookie`) stripped before following, and a
`401`/`403` from the target then says so ("the server redirected http→https, which
dropped the base URL's credentials; use an https base URL"). Userinfo in a `Location`
is never used. Transports are told `redirect: "manual"` (`HttpRequest.redirect`): the
engine follows redirects itself, and a response whose `HttpResponse.url` lies on
another origin (a fetch transport that followed one) is rejected as a
`DwdNetworkError`.

## Architecture

```
src/
  client/
    enums.ts     # Lang (de|en) value set (runtime + type)
    types.ts     # feed envelopes (station overview / warnings exposed as JsonObject)
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + node:http/https transport with gzip/deflate/br decoding
    engine.ts    # URL building, retry/backoff, redirects, JSON decoding, error mapping
    errors.ts    # DwdError / DwdApiError / DwdNetworkError / DwdParseError / DwdValidationError
    validate.ts  # input rules (Problem functions) + assertValid, shared with the CLI
    client.ts    # DwdClient — two engines (live ws + static bucket) over one transport
  cli/
    io.ts        # injectable I/O seam (stdout/stderr/file), the logger and the clock
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
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
  so the two-host topology is invisible to callers. Redirects are followed up to `maxRedirects`; the
  base URL's credentials go along to the same origin only: if a redirect crosses to a different
  origin, sensitive headers (`Authorization`/`X-API-Key`/`Cookie`) are stripped so credentials issued
  for one host are never forwarded to another.
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
failure/timeout), `DwdParseError` (bad/non-JSON body), `DwdValidationError` (an
input the library rejects before any request), all extending `DwdError`.
Whatever an injected transport throws becomes a `DwdNetworkError`
(`GET <url> failed: <reason>`, the original as `cause`). No error and no client shows
the base URL's password: the engine keeps the base URL in a real `#private` field
(so `console.log(client)`, `util.inspect` and `JSON.stringify` don't reveal it), every
URL in a message goes through `redactUrl`, and the base URL's userinfo (raw and
percent-decoded) is scrubbed from error bodies and details, transport error text and
the `cause` chain.
The CLI maps a `DwdValidationError` to the usage exit code `2`, `404` to exit
code `4`, other API statuses to `5`, network failures to `6`, parse failures to
`7`, and any other error to `1`.

**Input validation.** Every rule about what a request may contain lives in the
library, in [`validate.ts`](src/client/validate.ts) or next to the option it
guards, as an exported `…Problem(value)` function that returns the reason a value
is invalid (or `undefined`). The library enforces it with `assertValid(name,
value, problem)`, which throws `DwdValidationError` with the message
`Invalid <name>: <reason>` before any request (methods that return a promise
reject; constructors throw). The CLI's option parsers call the same functions and
turn the reason into a usage error, so the CLI keeps no rules of its own. Tests
check this with the `parity()` helper in `test/helpers.ts`, which sends one input
through `run()` and through the library on one recording mock transport.

**Engine options.** The numeric options (`timeoutMs`, `maxRetries`,
`retryDelayMs`, `maxRedirects`, `maxResponseBytes`) must be integers within their
documented range (`0` = off for the timeout and the size cap); anything else — a
negative, fractional, `NaN`, oversized or non-number value — makes the constructor
throw a `DwdValidationError` naming the option; so does a `transport` or `sleep` that
isn't a function. Server text in a message (an error `detail`, a redirect target, an
echoed Content-Type, a transport's reason) is cut at 500 characters
(`MAX_SERVER_TEXT_LENGTH`), never inside a surrogate pair (`cutText`), so the message stays
well-formed; `DwdApiError.body` keeps all of it. A value an own message quotes from the
user's input is cut too: a rejected `lang` or station id at 50 characters, a base URL's
scheme and the base URL the `/v30`/`/v16` hint suggests at `MAX_QUOTED_LENGTH` (200,
`cutForMessage`, in `errors.ts`), so `err.message` stays bounded for a library caller.

`userAgent` is checked there too, with the same rule as the CLI's `--user-agent`
(`headerValueProblem`, also exported as `assertHeaderValue(name, value)`): a blank
value, a control character other than tab (CR/LF would inject a header), DEL or a
character above U+00FF throws a `DwdValidationError` before any request, whatever
the transport. Only an omitted `userAgent` selects the default `dwd-cli`.

`baseUrl` and `staticBaseUrl` are checked in the constructor as well, with the same
rule as the CLI's `--base-url` / `--static-base-url` (`baseUrlProblem`, also exported
as `validateBaseUrl(raw, name)`): a blank value, surrounding or inner whitespace or
control characters, an unparseable URL, a scheme other than `http:`/`https:`, a
query or fragment, or a `%` in the user name or password that doesn't start an escape
(write a literal `%` as `%25`) throws a `DwdValidationError` ("Invalid baseUrl: …" /
"Invalid staticBaseUrl: …") before any request. It is a configuration error, not a
`DwdNetworkError`. Userinfo (`https://user:pw@proxy/`) is allowed and sent as Basic
auth. The reasons never repeat the value. The CLI also redacts on output: `run.ts`
(`redactionFor`, `withRedactedOutput`) takes the exact userinfo of every argument
(`credentialsIn`, exported) and replaces it with `***` in everything it prints. The log
replaces it in each record's *message*, before the record is cut and escaped, and writes
to the raw stderr: the frame (time, level, topic) is never touched, and a password with
DEL, C1 or bidi characters is matched in its raw form — commander's usage errors,
which echo rejected values, and its own messages (unknown command) — so a password with
spaces, quotes, `#`, `?` or `/` is caught as well as an ordinary one. `redactUrl` falls
back to the same text-based cut (`redactCredentials`, exported) for a value that doesn't
parse as a URL. Only an omitted value selects the default host. The client adds the version
segment itself (`WS_VERSION` `/v30`, `STATIC_VERSION` `/v16`), so a value whose path
ends in it throws a `DwdValidationError` with a hint (`serviceBaseUrlProblem`):
`Invalid baseUrl: Leave out /v30: the client adds /v30 itself (try https://app-prod-ws.warnwetter.de).`
A URL with a login keeps it in the suggestion, shown the way every message shows it
(`redactUrl`): `https://alice:pw@proxy/api/v30` gets `(try https://***@proxy/api)`.

**Plain `http:`.** `cleartextProblem(baseUrl, secrets = [])` (engine, exported) says whether
requests to a base URL travel unencrypted: `undefined` for `https:`, an unparseable URL and a
loopback host (`localhost`, `127.0.0.0/8`, `::1`), otherwise one sentence naming `url.host` and,
when the URL carries userinfo, "the base URL's credentials" (never the password). The DWD API
takes no key, so the CLI passes no `secrets`. The CLI's `action()` wrapper (`shared.ts`) checks
the base URL of the host the command talks to (`--base-url` for `station-overview`,
`--static-base-url` for the feeds) and logs the sentence as a `WARN` record of `dwd.http` on stderr once, before the
client is built; help, version and usage errors never reach it.

**Retry / backoff.** Transient `429` (rate limit) and `503` responses are
retried automatically, up to `--max-retries` (`0`–`10` in the CLI). Each retry waits
`retryDelayMs * attempt` (200 ms, 400 ms, …), or longer if the response's `Retry-After`
— delay-seconds or an IMF-fixdate HTTP-date, parsed by `parseRetryAfter` — asks for it,
never shorter: `Retry-After: 0` or a date in the past still waits the backoff, so
retries never burst. A `Retry-After` longer than `MAX_RETRY_AFTER_MS` (30 s) is not
retried: the `DwdApiError` surfaces at once, and its message names the requested wait
("the server asked to wait 120 s (Retry-After), longer than the 30 s the client waits;
retrying sooner won't help"). `DwdApiError` exposes `isRetryable` (true for
`429`/`503`). A reset connection (`ECONNRESET`/`EPIPE`/`ECONNABORTED`, or undici's
`UND_ERR_SOCKET`, anywhere in the error's `cause` chain — `isTransientNetworkError`)
is retried with the linear backoff too, whichever transport reported it. Only `GET`
and `HEAD` are retried; a timeout is not.

**Transport contract.** The engine enforces its limits for every transport, not only
the built-in one: each call runs under the `timeoutMs` deadline (the request carries
an `AbortSignal` in `HttpRequest.signal`, which the built-in transport honours, and the
engine rejects at the deadline whether the transport stops or not), and the body it
gets back is checked against `maxResponseBytes`. It accepts any `ArrayBuffer` view
(`Buffer`, a fetch `Uint8Array`, a `DataView`) or `ArrayBuffer` as the body, from any
realm, and reads headers from a plain object in any case, a `Headers` object or a
`Map`. A malformed response (no status, no headers, a string body) and anything a
transport throws become a `DwdNetworkError`.

**maxResponseBytes.** A cap on the response body size in bytes — applied to both
the wire bytes and the *decompressed* output by the built-in transport, and to the
body any transport returns by the engine (`0` = unlimited; default 100 MiB), guarding
against decompression bombs and unbounded responses. The message names the option and
the CLI flag: `Response exceeded the size limit of <n> bytes (maxResponseBytes;
--max-response-bytes on the CLI)`.

**Feed envelopes (typed response shapes).**

- **`StationOverview`.** `{ [stationId: string]: JsonObject }` — the station-overview response keyed by station id.
- **`WarningsFeed`.** The common envelope of the nowcast and gemeinde feeds: `{ time: number; warnings: JsonObject[]; binnenSee?: JsonValue }`.
- **`CoastWarningsFeed`.** The coast feed envelope: `{ time: number; warnings: JsonObject; vorabInformation?: JsonObject }` — `warnings` (and `vorabInformation`) keyed by coastal zone.
- **`CrowdOverview`.** The crowd feed envelope: `{ start?, end?, windowsSizeHours?, highestSeverities?, meldungen: JsonObject[] }`.
- **`JsonObject` / `JsonValue`.** General JSON value types used where a payload is large and DWD-specific enough that a hand-written interface would be a guess.

**Shape check.** The client (`getChecked` in `client.ts`) checks only the top
level the types promise — a JSON object for the station overview, a `warnings`
array (nowcast/gemeinde), a `warnings` object (coast), a `meldungen` array (crowd),
a numeric `time` on the three warning feeds and, when present, a numeric `start`/`end`
on the crowd feed — never the records inside. Anything else throws `DwdParseError` with the text
`Unexpected response shape from <path>: expected <what>.`

**Decoding.** A JSON body is decoded by the Content-Type's `charset` (UTF-8 when
none is given; a leading byte-order mark is dropped); an unknown charset is a
`DwdParseError`. A body that does not parse raises `DwdParseError`
`Failed to parse JSON response from <path>: <the parser's reason>`.

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
- **`log.test.ts`** — the record helpers of `src/cli/log.ts` on their own (`escapeForRecord`,
  `formatLogRecord`); the CLI-level checks are P23's.
- **`conformance-p*.test.ts`** — the checks shared across the `*-cli` repos (fix plan
  `.reviews/2026-10-05-exploratory/fix-plan.md` in the workspace), one file per pattern, the same
  code in every repo apart from an adapter block at the top: P1 credential redaction in CLI output,
  P2 in library objects and errors, P3 credentials across redirects, P4/P19 base-URL validation,
  P5 the transport contract (timeout, size cap, body types, header shapes, resets), P6 the retry
  floor, P7 pipes and exit codes (spawns the built bin), P8/P9/P13 charset, 2xx body shapes and
  error classes, and from the follow-up round (`.reviews/2026-10-06-followup/round.md`) P20 the
  stderr warning for a plain-`http:` base URL and P21 README links: README.md ships in the npm
  tarball and shows on npmjs.com, so a relative link in it may only point to a file the
  `files` allowlist ships; other documents are linked by their GitHub URL
  (`https://github.com/maschinenlesbar-org/dwd-cli/blob/main/<path>`).

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch from the release tag (`gh workflow run publish.yml --ref vX.Y.Z`; the version is the tag's): publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/dwd-cli/> in English and
<https://maschinenlesbar-org.github.io/dwd-cli/de/> in German — is built from `site/` with
[Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components and
[Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/dwd-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## The log on stderr

Every diagnostic line on stderr is a log record (`src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `dwd.<area>`. `--log-format text` (the default)
writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. Before that a lone surrogate (half a character,
which jq rejects, stopping the whole stream) becomes U+FFFD (`toWellFormed`), and a message
longer than `MAX_RECORD_MESSAGE` (4000 characters, exported) is cut at a code point and ends
in `… (N more characters)` (a long id list in the unknown-station note, a request URL with
thousands of ids). The library's error messages keep a server's line
breaks (`sanitizeServerText` strips only the other controls); the record escapes them. The
areas are `cli` (usage errors, commander's messages, parse errors of a
response, unexpected errors), `api` (the API's answers: HTTP errors, the unknown-station
note, the stale-feed note) and `http` (the connection: network errors, the cleartext
warning). Code logs through `logOf(deps)` and never writes diagnostics with `io.err`
directly. `run()` builds the logger from argv before commander parses it, so commander's
own usage errors are records too, and with the run's redaction (`withRedactedOutput`),
which replaces a secret in the message only, before it is escaped: the frame is never
touched, and a secret is kept out of the log in either format. `CliDeps.now` makes the timestamps testable. stdout
carries data only. The one line that is not a record is `handleOutputErrors`'
`Output error: …` (stdout itself failed; it writes to `process.stderr` directly, outside
any run). Conformance test P23 checks all of this, and its body is shared across the
*-cli repos.
