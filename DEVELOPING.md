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
npm run build        # compiles every workspace (tsc -b) to its dist/
```

Run the locally built CLI without a global install:

```bash
node apps/cli/dist/src/cli/index.js --help    # or: npm start -- --help
# or, after `npm link --workspace apps/cli`:
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
  bigIntegerKeys: new Set(["_version_"]), // members whose numbers may pass 2^53: delivered as strings
  onWarning: (message) => console.warn(message), // text in an answer replaced with U+FFFD
});
```

**Exact answers.** A number a double can't carry exactly is a `DwdParseError`, never a changed
value (see "Decoding" below). A member named in `bigIntegerKeys` (a set or list of non-empty
member names, copied; default none, and the DWD API needs none: its numbers are scaled integers
and epoch-ms times far below 2^53) is the one exception: its number value is delivered as its
exact literal, as written, as a JSON string (`"1858054135406919680"`, `"5"`), whatever its size,
so its type is stable. The engine does both in one linear scan of the text before `JSON.parse`
(`scanNumbers`, which quotes the declared values in place; no reviver).

Every option is optional and typed `?: T | undefined`: an option given as `undefined`
means its default, as an omitted one does, so `{ baseUrl: process.env.DWD_BASE_URL }`
compiles under `exactOptionalPropertyTypes` too.

### Resource groups

`client.weather.stationOverview(ids)`, `client.warnings` (`.nowcast(lang)` / `.gemeinde(lang)` / `.coast(lang)`),
and `client.crowd()`. The arguments are checked before any request, as the CLI
does: `lang` must be `"de"` or `"en"` exactly (`langProblem`; else a `DwdValidationError`,
which the CLI's `--lang` parser turns into a usage error). `ids` are trimmed and in NFC
(`normalizeStationIds`, with `normalizeToken`, so `" 10865 "` is sent as `10865`) and must then be a
non-empty list (`listProblem`, which names the item: `item 2 of 3: …`) of non-blank ids without
commas, whitespace, `;`, control or invisible characters (`stationIdProblem`, which runs
`tokenProblem`: no Cc, no Cf such as a zero-width space, a word joiner, a soft hyphen or a
bidi mark, no lone surrogate; a value of only such characters is blank); anything else rejects
with a `DwdValidationError` (an empty slot in `stationIds`, `10865 10147` sent as one id, or
`10865` with a zero-width space copied along from a web page, would come back as `{}`, like an
unknown station). A refused value is quoted visibly (`quoteValue`: `"10865\u200b"`). The CLI
only splits an `--id` value on commas (`splitList`) and whitespace; commander's own echo of a
rejected value is escaped the same way (`escapeCommanderError` in `run.ts`).

The warning feeds come back as DWD published them. `staleFeedProblem(time, now?, maxAgeMs?)`
says whether one is stale — its `time` more than `STALE_FEED_MS` (60 minutes) old — as a
sentence, or `undefined` (also for a `time` that is no time: not finite, or beyond the
±8.64e15 ms a Date can hold; it never throws). The CLI's `warnings` commands print the feed with a `staleFeed`
boolean added after DWD's keys and, for a stale one, a note on stderr (an `INFO`
record of `dwd.api`, `<feed> warnings: <sentence>`); the library adds no field.

The station data is copied, never changed in place: `stationOverview()` turns the
missing-value marker into `null` (`replaceMissingValues`) and `decodeStationOverview` divides the
scaled fields. Both walk the data with a work list, not recursion (`copyTree` in `client.ts`), so
an answer nested thousands deep (only a broken or hostile mirror sends one) can't overflow the
stack: the library returns it, and the CLI prints it with `--compact` or refuses it with an
`ERROR` record of `dwd.output`. A member named `__proto__` stays an ordinary member of the copy.

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

The repository is an **npm workspace** with two folders: `apps/` holds the programs it
publishes, `packages/` the libraries they are built from.

```
package.json         # private workspace manifest: no version, never packed
apps/cli/            # @maschinenlesbar.org/dwd-cli — the published package
  package.json       # its version, bin, files (no workspace package in dependencies)
  src/index.ts       # library entry: re-exports @maschinenlesbar.org/dwd-client
  src/cli/           # the CLI (below)
  test/              # CLI tests and every conformance-*.test.ts
packages/client/     # @maschinenlesbar.org/dwd-client — private, shipped inside the CLI's tarball
  src/               # the API client (below)
  test/              # tests that only touch the client, + the transport helpers
tools/pack/          # prepack/postpack: ship the client (dist/node_modules) and commander in the tarball
tools/bump.mjs       # version bump + commit + tag (npm run bump)
tsconfig.docs.json   # TypeDoc only: the package entry, with the client read from its sources
```

- **The client is its own package** so a later MCP app can share it with the CLI. It is
  never published on its own: `apps/cli`'s `prepack` copies it into
  `apps/cli/dist/node_modules/`, where the CLI's imports find it, and the tarball ships it
  as plain files — so npm lists only commander (bundled) as a dependency, never the
  private client. `apps/cli/package.json` therefore doesn't name the client; prepack finds
  it through `apps/cli/tsconfig.json`'s project references. The library
  entry re-exports the client's `"."`, so `import { DwdClient } from
  "@maschinenlesbar.org/dwd-cli"` is unchanged.
- **The client's exports:** `"."` is the public library surface (`src/index.ts`);
  `"./internal/*"` maps to any module (`…/dwd-client/internal/engine`) for what the
  CLI needs beyond that; `"./test/*"` reaches the client's test helpers from the CLI's
  tests (not bundled). Only `"."` is part of the library.
- **Dependencies point one way:** the app depends on the client, the client on nothing
  in the workspace.
- **The version lives in `apps/cli/package.json`.** The root has none; a plain
  `npm version` at the root is refused. Release with `npm run bump -- <patch|minor|major>`,
  which bumps the app, commits (the bare version as the message) and tags `vX.Y.Z`.
- **TypeScript:** `tsconfig.base.json` holds the compiler options; every workspace has a
  `tsconfig.json` (`src/`) and a `tsconfig.test.json` (`test/`), and the root
  `tsconfig.json`/`tsconfig.test.json` reference them, built with `tsc -b`.

The client (`packages/client/src/`) and the CLI (`apps/cli/src/`):

```
packages/client/src/
    enums.ts     # Lang (de|en) value set (runtime + type)
    types.ts     # feed envelopes (station overview / warnings exposed as JsonObject)
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + node:http/https transport with gzip/deflate/br decoding
    engine.ts    # URL building, retry/backoff, redirects, JSON decoding, error mapping
    errors.ts    # DwdError / DwdApiError / DwdNetworkError / DwdParseError / DwdValidationError
    validate.ts  # input rules (Problem functions) + assertValid, shared with the CLI
    client.ts    # DwdClient — two engines (live ws + static bucket) over one transport
    index.ts     # the client's public surface (the library entry re-exports it)
apps/cli/src/cli/
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

**API client.** [`DwdClient`](packages/client/src/client.ts) — the typed, resource-grouped
wrapper over the API. Usable as a library independently of the CLI. Runs two
`RequestEngine` instances (live web service + static bucket) over a single
transport, so the two-host topology is invisible to callers.

**Resource group.** A cohesive set of client methods for one part of the API
(`client.weather`, `client.warnings`) plus the standalone `client.crowd()`, and
the matching top-level CLI commands.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](packages/client/src/http.ts)). The default uses Node's built-in
`http`/`https` and transparently decompresses gzip/deflate/brotli; tests inject a
mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](packages/client/src/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, follows redirects, decodes JSON and
maps errors. Sits between the client's resource methods and the transport.
`DEFAULT_BASE_URL` is `https://app-prod-ws.warnwetter.de`.

**Query-string builder.** [`buildQueryString`](packages/client/src/query.ts) — a
dependency-free serialiser: `undefined`/`null` omitted, arrays become repeated
keys, booleans become `"true"`/`"false"`, `Date`s become ISO-8601, spaces encoded
as `%20`.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](apps/cli/src/cli/io.ts)): a client factory plus an I/O object. Lets the whole
CLI run in tests with a mocked client and captured output — no subprocess.

**Error types.** [`errors.ts`](packages/client/src/errors.ts): `DwdApiError` (non-2xx,
carries `status`/`detail`/`isRetryable`), `DwdNetworkError` (transport
failure/timeout), `DwdParseError` (bad/non-JSON body), `DwdValidationError` (an
input the library rejects before any request), all extending `DwdError`.
Whatever an injected transport throws becomes a `DwdNetworkError`
(`GET <url> failed: <reason>`, the original as `cause`). No error and no client shows
the base URL's password: the engine keeps the base URL in a real `#private` field
(so `console.log(client)`, `util.inspect` and `JSON.stringify` don't reveal it), every
URL in a message goes through `redactUrl`, and the base URL's userinfo (raw and
percent-decoded), and the forms a server echoes it back in (the `Basic` value, the decoded
`user:password`, the password alone from 4 characters: `echoedCredentialForms`), are
scrubbed from error bodies and details, transport error text and the `cause` chain. The
CLI replaces the same forms: the `Basic` value and the pair on stdout and stderr, the
password alone on stderr only, since it may well occur in the data.
The CLI maps a `DwdValidationError` to the usage exit code `2`, `404` to exit
code `4`, other API statuses to `5`, network failures to `6`, parse failures to
`7`, and any other error to `1`.

**Input validation.** Every rule about what a request may contain lives in the
library, in [`validate.ts`](packages/client/src/validate.ts) or next to the option it
guards, as an exported `…Problem(value)` function that returns the reason a value
is invalid (or `undefined`). The library enforces it with `assertValid(name,
value, problem)`, which throws `DwdValidationError` with the message
`Invalid <name>: <reason>` before any request (methods that return a promise
reject; constructors throw). The CLI's option parsers call the same functions and
turn the reason into a usage error, so the CLI keeps no rules of its own. Tests
check this with the `parity()` helper in `apps/cli/test/helpers.ts`, which sends one input
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
user's input is cut too: a rejected `lang` or station id (quoted visibly by `quoteValue`), a
base URL's scheme and the base URL the `/v30`/`/v16` hint suggests at `MAX_QUOTED_LENGTH` (200,
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
(`redactionFor`, `withRedactedOutput`) takes the exact userinfo of every URL argument
(`credentialsIn`, exported) and replaces it with `***` in everything it prints —
commander's usage errors, which echo rejected values, and its own messages (unknown
command) — so a password with spaces, quotes, `#`, `?` or `/` is caught as well as an
ordinary one. Only a value that starts with a scheme counts (a bare `a:b@c` is a station
id, a User-Agent or a typed value as often as a credential), except as the `--base-url`
or `--static-base-url` value, where a `user:password@host` typed without its scheme is
still a credential. The log replaces it in each record's *message*, before the record is
cut and escaped, and writes to the raw stderr: the frame (time, level, topic) is never
touched, and a password with DEL, C1 or bidi characters is matched in its raw form. `redactUrl` falls
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
Each retry is announced: the engine option `onRetry(event: RetryEvent)` (exported type:
`{ retry` (1-based), `maxRetries`, `delayMs`, `status?` (absent for a reset), `url` (userinfo
redacted) `}`) is called once per retry right before the sleep, never when there is none, and
a throw in it is swallowed (both engines of `DwdClient` get it). The CLI's `action()` sets it
to log one `WARN` record of `dwd.http`, `HTTP 503 from <host>: retry 1 of 3 in 2 s`
(`retryMessage`; host only, whole seconds, ms under 1 s). Tests: `packages/client/test/engine.test.ts`,
`apps/cli/test/retry-log.test.ts`.

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
on the crowd feed, each epoch milliseconds a Date can hold (within ±8.64e15) — never the
records inside. Anything else throws `DwdParseError` with the text
`GET <url>: unexpected response shape: expected <what>.`, naming the request (`describeUrl`:
the full URL, without userinfo, cut at 200 characters), so a message says which of the two
hosts sent the bad answer.

**Decoding.** A JSON body is decoded by the Content-Type's `charset` (UTF-8 when
none is given; a leading byte-order mark is dropped); an unknown charset is a
`DwdParseError` (`GET <url>: unsupported response charset "…".`). Text is never changed
silently: bytes that are not valid in the charset, and lone surrogates written as JSON escapes
(`\ud800`, which `jq` refuses), are replaced with U+FFFD, so the result is well-formed, and the
engine option `onWarning` is told once per answer, naming the request: `GET <url>: 2 characters
of the answer were not valid text (invalid bytes or a lone surrogate) and replaced with
U+FFFD.` The CLI logs it as a `WARN` record of `dwd.api`. One bad character never sinks a
whole answer. A body too large to become one string (512 MB and more, possible only with
`maxResponseBytes: 0` or `--max-response-bytes 0`) is a `DwdParseError`, `GET <url>: the answer
is too large to read as text (N bytes; the longest string is 536870888 characters).`, not a
plain `Error` ("Unexpected error" in the CLI); an error status with such a body keeps its
`DwdApiError`, without the body. An empty body (or one of
whitespace only) is `GET <url>: empty response body.`, never "nothing found". A body that does
not parse raises `DwdParseError` `GET <url>: the answer is not valid JSON: <the parser's
reason>`. A body that parses
but holds a number `JSON.parse` cannot carry exactly — past 2^53 one that prints as a
different number, in any written form (`12345678901234567890`, which prints as
`12345678901234567000`, `…890.0`, `9007199254740993e0`, `9007199254740992.5`), out of a
double's range (`1e400`), non-zero and too small (`1e-400`, which becomes 0), or a subnormal
(below 2.2250738585072014e-308) that does not print as written (`3e-324`, which becomes
`5e-324`) — raises
`DwdParseError` `GET <url>: the number <N> cannot be represented
exactly.` rather than returning a changed value (`scanNumbers`, a linear scan of the
text before `JSON.parse` that skips strings). Below 2^53 and above the subnormal range a
decimal fraction keeps a double's precision, as JSON means it. Past 2^53 and below the normal
range the check compares the number as written with the number as printed (`String(value)`), not with the double's exact binary value: a double a
server printed in its shortest form (`1E23`, `1.7976931348623157E308`) reads back as the same
double, prints as the same number and passes. The station data's missing-value marker `32767` and the
epoch-ms times are far below 2^53: the marker handling after the parse is unchanged.

**Content-Type guard.** A `200` response whose `Content-Type` is clearly not JSON
(e.g. a captive-portal HTML page) is reported as a `DwdParseError` naming the
actual type (`GET <url>: expected a JSON answer, got Content-Type "text/html".`), rather than
being fed to `JSON.parse`.

**JSON rendering.** The CLI prints the answer pretty (two spaces) or with `--compact` on one
line (`renderJson` in `shared.ts`). An answer that can't be printed is an `OutputError`, an
ERROR record of `dwd.output` (exit 1) that names the cause, never a stack trace: "nested too
deeply" (the stack overflowed) or "too large (more than 536870888 characters of JSON)" (V8's
longest string, `Invalid string length`). "; try --compact" is added only when the compact form
of that very answer prints (`compactPrints`, probed, not assumed from the Node version). `--compact` takes
V8's fast path (`JSON.stringify(value)`), the only one that prints very deep nesting on Node 26,
unless the answer holds a string or key of 64 Mi characters or more (`holdsHugeString`, an
iterative walk without an allocation per value): the
fast path aborts the process on Node 26 on a ~250 MB string from `JSON.parse`, so such an
answer goes through the gap path with an empty gap, which prints the same text. The printed
JSON is terminal-safe: `escapeControlChars` writes what `JSON.stringify` leaves raw although a
terminal acts on it — DEL, the C1 range U+0080–U+009F and the bidi controls (`isBidiControl`,
exported by the library: U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069) — as `\uXXXX`
escapes, so a right-to-left override in a warning text prints as `\u202e` and can't reorder
the line on screen. The result parses to the same value. It measures the escaped length first (past V8's longest
string the answer is "too large to print (N characters once its control characters are
escaped)", an `OutputError`) and builds the text in 64 Ki chunks, so an answer full of DEL
characters prints within memory.

## Testing

```bash
npm test          # builds, then runs `node --test` over each workspace's dist/test
npm run coverage  # the same tests in one run, with a coverage report
node --test apps/cli/dist/test/cli.test.js   # one file, after a build
```

The client's tests are in `packages/client/test/` (`query`, `http`, `engine`, `client`, `types`),
everything that drives the CLI is in `apps/cli/test/`.

- **`query.test.ts`** — query-string serialisation.
- **`types.test.ts`** — a consumer compiled by `tsc` with `exactOptionalPropertyTypes` (it
  starts a process, so it has 30 s), and every option given as `undefined` meaning its default.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`: gzip/deflate
  (zlib + raw)/brotli decoding, malformed-body handling, the decompressed-size cap, and the timeout path.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, redirect following,
  `maxRedirects` exhaustion, and cross-origin credential stripping — mocked transport.
- **`client.test.ts`** — host routing (live vs static), URL/query mapping, language suffixes — mocked transport.
- **`cli.test.ts`** — end-to-end command parsing, validation and exit codes — mocked client.
- **`log.test.ts`** — the record helpers of `apps/cli/src/cli/log.ts` on their own (`escapeForRecord`,
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
  (`https://github.com/maschinenlesbar-org/dwd-cli/blob/main/<path>`), P23 the log format, and
  from the kit rollout (`.reviews/2026-10-21-kit-rollout/plan.md`) P24 the input corpus (every
  text filter and path id canonicalised or refused, CLI and library alike; dwd has neither, its
  station ids are a query parameter, so both lists are empty) and P25 the response corpus (a
  number the answer can't carry exactly, and an empty answer, are a parse error, never a changed
  value, and every answer error names the request; its adapter sets dwd's parse exit `7`), and
  from the fix round `.reviews/2026-10-21-exploratory/fix-plan.md` P27 big and odd answers (a
  large flat answer and one full of DEL characters print within a small heap, or past V8's
  longest string are one ERROR record of `dwd.output`; a lone surrogate or invalid bytes are
  replaced with U+FFFD and reported in a WARN of `dwd.api`; it starts the built bin, so 30 s).
  Their adapters use `kitParity`, `parity` with the library's error named by its class.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24/26 for every push and PR; then pack the
  real tarball, check the pack left nothing behind, install it globally with the registry out
  of reach and run the bin.
- **release.yml** — on a `v*` tag (made by `npm run bump`): verify the tag matches
  `apps/cli/package.json`, test, write the SBOMs (scoped to the `apps/cli` workspace), then
  `npm pack --workspace apps/cli`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch from the release tag (`gh workflow run publish.yml --ref vX.Y.Z`; the version is the tag's): `npm publish --workspace apps/cli` via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar.org/dwd-cli/> in English and
<https://maschinenlesbar.org/dwd-cli/de/> in German — is built from `site/` with
[Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components and
[Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` (which
also says where the published manifest and the built program are: `manifest:
apps/cli/package.json`, `program: apps/cli/dist/src/cli/program.js`) and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

The build also writes `sitemap.xml`: every page in both languages, and `/api/`. Crawlers
find it through `robots.txt` at the root of maschinenlesbar.org, which only the
organisation website can serve; its `site/_data/sites.yml` lists every site's sitemap, so a
new CLI gets a line there.

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

Every diagnostic line on stderr is a log record (`apps/cli/src/cli/log.ts`): a timestamp, a level
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
areas are `cli` (usage errors, commander's messages, unexpected errors), `api` (the
API's answers: HTTP errors, text replaced with U+FFFD (a WARN), the unknown-station note, the stale-feed note, and a malformed
answer, a `DwdParseError`: bad JSON, the wrong shape or content type, an unknown charset), `http` (the connection: network errors, the cleartext
warning) and `output` (a failed write to stdout, an answer too deeply nested or too large to
print). Code logs through `logOf(deps)` and never writes diagnostics with `io.err`
directly. `run()` builds the logger from argv before commander parses it
(`logFormatFromArgv`, used only for the records of a parse error: the last `--log-format`
counts, a second one being itself a usage error (`forbidRepeatedOptions`: every single-value
option may be given once, `--x may be given only once.`; `--id` is declared `repeatable`), and the value of one of the program's own value options is skipped, as commander reads it; a
`preAction` hook then sets the format commander parsed, so `--user-agent --log-format=jsonl`
logs text), so commander's own usage errors are records too (`writeCommanderErr`): its `error: …` an ERROR of `cli`
(a `(Did you mean …?)` line joined to it), followed by an INFO record pointing at the
command's help, `(run "dwd crowd --help" for usage)` (`showHelpAfterError` with a one-line
text, set per command in `configureTree`, rather than the whole help); anything else
commander writes to stderr is one INFO record per line, after an ERROR "missing command"
should there be no `error:` line, so every failed run has an ERROR record. The log is
built with the run's redaction (`withRedactedOutput`),
which replaces a secret in the message only, before it is escaped: the frame is never
touched, and a secret is kept out of the log in either format. `CliDeps.now` makes the timestamps testable. stdout
carries data only. A failed write to stdout other than a closed pipe (`handleOutputErrors`,
in the bin shim, outside `run()`) is an ERROR record of `dwd.output` (`Could not write to
stdout: …`), in the format argv asks for (`processLogger`). Node's own process warnings
(`NODE_TLS_REJECT_UNAUTHORIZED=0`) are WARN records of `dwd.cli` too: the bin shim installs
`installWarningLog`, which removes Node's default `warning` listener and logs
`(node) <name>: <message>` through the same logger. In `defaultDeps` a record waits for
stdout (`stderrAfterStdout`): it is held while stdout has a backlog and written, in order,
once it is gone, so with `2>&1 |` and a slow reader it never lands inside the data.
Conformance test P23 checks all of this, and its body is shared across the
*-cli repos.
