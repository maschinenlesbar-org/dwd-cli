# dwd-cli — Exploratory / black-box bug report

**Environment**
- Built with `npm run build` (tsc, clean) and invoked as `node dist/src/cli/index.js ...`.
- The **live DWD API was reachable** during testing: `station-overview --id 10865`, `warnings nowcast/gemeinde/coast`, and `crowd` all returned real data; the gzip warning feeds decompressed correctly (CLI output is byte-for-byte identical to `curl --compressed` of the same file — see "Verified-correct behaviour" at the end). All `*_en` feeds (nowcast/gemeinde/coast) exist (HTTP 200).
- Several bugs below were reproduced against a local `http.createServer` (closed port / 404 / gzip-bomb / non-gzip-claiming-gzip / slow-timeout) because the production hosts will not emit those conditions on demand. Each such case lists the exact local-server setup needed to reproduce.

**Count: 17 genuine, reproducible bugs found** (target was 20). All 17 below are real and reproduced; none are fabricated. Grouped by severity.

---

## HIGH severity

### 1. Decompressed-size cap ("decompression bomb") reports a misleading generic decode error, contradicting the documented protection — ✅ FIXED
- **Fix:** `src/client/http.ts` — `decode()` now detects zlib's `ERR_BUFFER_TOO_LARGE` (raised when `maxOutputLength` is exceeded) and rethrows it as `DwdNetworkError("Response exceeded maxResponseBytes (<n>)")`, matching the wire-size cap message; the deflate zlib→raw fallback no longer re-trips the cap.
- **Severity:** High
- **Confidence:** High
- **Repro** (local server that sends `Content-Encoding: gzip` of a 5 MiB body, compressed to ~5 KB on the wire):
  ```
  node dist/src/cli/index.js --max-response-bytes 1048576 \
    --static-base-url "http://127.0.0.1:<port>/bomb" warnings nowcast
  ```
- **Expected:** Per the code comment in `http.ts` (lines 54–57) the over-cap decompression is supposed to be "turned into a DwdNetworkError — preserving the documented memory-exhaustion protection", i.e. a message like `Response exceeded maxResponseBytes (1048576)` (the exact message the *wire-size* cap produces).
- **Actual:**
  ```
  Error: Failed to decode gzip response body
  exit=1
  ```
  Compare the wire-size cap on a tiny-but-over-limit gzip body, which *does* give the documented message:
  ```
  $ node ... --max-response-bytes 1 --static-base-url http://127.0.0.1:<port>/goodgz warnings nowcast
  Error: Response exceeded maxResponseBytes (1)
  ```
  So the two halves of the "size cap" feature emit two different, inconsistent messages, and the decompression-bomb path hides the fact that the cap is what fired (looks like a corrupt/decode failure instead of a deliberate limit).
- **Root cause:** `src/client/http.ts:74`/`:80`/`:149-160`. zlib throws `ERR_BUFFER_TOO_LARGE` when `maxOutputLength` is exceeded; that error is **not** a `DwdNetworkError`, so the rejection handler at `http.ts:149` falls through to the generic `new DwdNetworkError("Failed to decode ${enc} response body", ...)` at `:154`. The branch that re-throws the size-cap `DwdNetworkError` (`http.ts:150`) never catches it because `decode()` (`:64`) only sets `maxOutputLength`; it never translates `ERR_BUFFER_TOO_LARGE` into the documented "exceeded maxResponseBytes" `DwdNetworkError`.

---

## MEDIUM severity

### 2. `parseIntArg` accepts hexadecimal input (`0x10`) despite advertising "non-negative integer" — ✅ FIXED
- **Fix:** `src/cli/shared.ts` — `parseIntArg` now requires a plain decimal literal via `/^\d+$/` before `Number()`, rejecting `0x10`.
- **Severity:** Medium
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --timeout 0x10 warnings nowcast
  ```
- **Expected:** Rejected as invalid (`0x10` is not an integer literal a user would type as "16"); error like the one shown for `--timeout abc`.
- **Actual:** Accepted silently; `Number("0x10")` → `16`, so the timeout is set to 16 ms with no warning. Request proceeds (exit 0 with a live/local server).
- **Root cause:** `src/cli/shared.ts:11-17` — `parseIntArg` uses `Number(value)` then `Number.isInteger`. `Number("0x10") === 16` passes `Number.isInteger`, so the "Expected a non-negative integer" contract is violated.

### 3. `parseIntArg` accepts scientific notation (`1e3`) — ✅ FIXED
- **Fix:** `src/cli/shared.ts` — the new `/^\d+$/` guard in `parseIntArg` rejects `1e1`/`1e3`.
- **Severity:** Medium
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --max-response-bytes 1e1 warnings nowcast
  ```
- **Expected:** Rejected (textually not an integer).
- **Actual:** Accepted; `Number("1e1") === 10`, so the response-byte cap is silently set to **10 bytes** and every real feed then fails with `Error: Response exceeded maxResponseBytes (10)`. `--timeout 1e3` is likewise accepted as 1000 ms. No validation error.
- **Root cause:** `src/cli/shared.ts:12` — `Number("1e1")` is an integer per `Number.isInteger`, so it slips through.

### 4. `parseIntArg` accepts leading/trailing whitespace (`" 5 "`) — ✅ FIXED
- **Fix:** `src/cli/shared.ts` — the `/^\d+$/` guard rejects whitespace-padded input (no implicit trim).
- **Severity:** Medium
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --timeout " 5 " warnings nowcast
  ```
- **Expected:** Rejected, or at least documented as trimmed.
- **Actual:** Accepted; `Number(" 5 ") === 5`. Silently coerced.
- **Root cause:** `src/cli/shared.ts:12` — `Number()` trims surrounding whitespace before parsing.

### 5. `parseIntArg` accepts values above `Number.MAX_SAFE_INTEGER` with silent precision loss — ✅ FIXED
- **Fix:** `src/cli/shared.ts` — `parseIntArg` now rejects values failing `Number.isSafeInteger`, with a message naming the `MAX_SAFE_INTEGER` bound.
- **Severity:** Medium
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --max-response-bytes 99999999999999999999 warnings nowcast
  ```
- **Expected:** Either rejected, or used exactly as typed.
- **Actual:** Accepted; `Number("99999999999999999999")` becomes `100000000000000000000` (`1e20`) — a different number than the user typed — and `Number.isInteger` still returns `true`, so no error is raised. The value used downstream differs from the input.
- **Root cause:** `src/cli/shared.ts:12-13` — no `Number.MAX_SAFE_INTEGER` bound and no "input string round-trips to the parsed number" check.

### 6. No `Accept-Encoding` request header is sent, so the advertised deflate/brotli decoding never gets a chance to engage — ✅ FIXED
- **Fix:** `src/client/engine.ts` — `request()` now sets `Accept-Encoding: gzip, deflate, br` on outgoing requests so an RFC-compliant origin actually compresses.
- **Severity:** Medium
- **Confidence:** High
- **Repro** (point at a request-echoing local server and inspect headers):
  ```
  node dist/src/cli/index.js --static-base-url "http://127.0.0.1:<port>" warnings nowcast
  # server logs: accept=application/json, user-agent=dwd-cli, host=..., connection=keep-alive
  ```
- **Expected:** Given the README's "Transparent gzip" claim and the transport's documented "gzip/deflate/br decoding" (`http.ts:11`, README "Architecture" notes), the client should advertise `Accept-Encoding: gzip, deflate, br` so a compliant server actually compresses. The decode for deflate/br is dead code against any server that honours `Accept-Encoding`.
- **Actual:** The outgoing request carries **no `Accept-Encoding` header**. Decompression only works because the DWD S3 bucket sends `Content-Encoding: gzip` unsolicited; for any RFC-compliant origin (which compresses only when asked) responses arrive uncompressed and the deflate/brotli code paths can never run.
- **Root cause:** `src/client/engine.ts:88-91` builds `headers` with only `Accept` and `User-Agent`; no `Accept-Encoding` is ever added.

### 7. `station-overview --help` does not mark the required `--id` option as required — ✅ FIXED
- **Fix:** `src/cli/commands/weather.ts` — the `--id` option description now ends with "(required)", so help matches the runtime requirement.
- **Severity:** Medium
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js station-overview --help
  ```
- **Expected:** Help should indicate `--id` is mandatory (e.g. commander's "(required)" suffix), consistent with the actual enforcement (`error: required option '--id <stationId>' not specified`).
- **Actual:**
  ```
  Options:
    --id <stationId>  DWD station id (repeatable)
    -h, --help        display help for command
  ```
  No "(required)" marker — the help disagrees with the runtime requirement.
- **Root cause:** `src/cli/commands/weather.ts:15` uses `.requiredOption(...)`; commander does not append "(required)" to the help text for required options, and the project does not add it to the description. Help/behaviour mismatch.

### 8. Redirect-loop / redirect-exhaustion surfaces as a raw "HTTP 30x" API error, not a clear "too many redirects" — ✅ FIXED
- **Fix:** `src/client/engine.ts` — when a 3xx-with-`Location` arrives after `maxRedirects` is exhausted, `request()` now throws `DwdNetworkError("Too many redirects (exceeded maxRedirects=<n>) ...")` instead of falling through to the generic HTTP-status error. Updated the corresponding test in `test/engine.test.ts`.
- **Severity:** Medium
- **Confidence:** High
- **Repro** (local server that 302-redirects to itself):
  ```
  node dist/src/cli/index.js --static-base-url "http://127.0.0.1:<port>/loop" warnings nowcast
  ```
- **Expected:** A clear error such as "Too many redirects (exceeded maxRedirects=5)".
- **Actual:**
  ```
  Error: HTTP 302 for GET http://127.0.0.1:<port>/loop/v16/warnings_nowcast.json
  exit=1
  ```
  After `maxRedirects` is exhausted the 3xx response simply falls through to the non-2xx handler and is reported as a confusing "HTTP 302" error.
- **Root cause:** `src/client/engine.ts:114` — once `redirects < this.maxRedirects` is false, control drops to `:133-136` which throws `toApiError(...)` with the 3xx status. No dedicated "redirects exhausted" error is raised.

### 9. 200 responses with a non-JSON `Content-Type` are force-parsed as JSON, yielding a misleading "Failed to parse" error — ✅ FIXED
- **Fix:** `src/client/engine.ts` — `getJson()` now inspects `res.contentType` and, when a Content-Type is present and is not JSON (`application/json`, `text/json`, or a `+json` suffix; parameters/case ignored), throws `DwdParseError("Expected a JSON response ... but got Content-Type \"text/html\"")`. A missing/empty Content-Type is still parsed leniently.
- **Severity:** Medium
- **Confidence:** High
- **Repro** (local server returns `Content-Type: text/html`, body `<html>…`, status 200):
  ```
  node dist/src/cli/index.js --static-base-url "http://127.0.0.1:<port>" warnings nowcast
  ```
- **Expected:** Either honour the `Content-Type` (it is captured into `RawResponse.contentType` at `engine.ts:133` but never used) and report "expected JSON, got text/html", or surface the body. A captive-portal/HTML error page is a common real-world case.
- **Actual:**
  ```
  Error: Failed to parse JSON response from /v16/warnings_nowcast.json
  exit=1
  ```
  The HTML page is fed straight into `JSON.parse`.
- **Root cause:** `src/client/engine.ts:143-151` (`getJson`) ignores `res.contentType` and always calls `JSON.parse`; the captured `contentType` is dead data.

---

## LOW severity (docs / UX / help)

### 10. `--timeout` default (30000 ms) is documented but never shown in `--help` — ✅ FIXED
- **Fix:** `src/cli/program.ts` — `--timeout` now registers a commander default of `30000`, so help shows "(default: 30000)".
- **Severity:** Low
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --help    # --timeout line shows no "(default: ...)"
  ```
- **Expected:** README ("Per-request timeout (default `30000`)") and the help should agree; help should show the default.
- **Actual:** Help line is `--timeout <ms>  per-request timeout in milliseconds` with no default shown.
- **Root cause:** `src/cli/program.ts:32` registers `--timeout` without a default value (the 30 000 default lives in `engine.ts:66`, invisible to commander/help).

### 11. `--max-retries` default (2) is documented but never shown in `--help` — ✅ FIXED
- **Fix:** `src/cli/program.ts` — `--max-retries` now registers a commander default of `2`, surfaced in help.
- **Severity:** Low
- **Confidence:** High
- **Repro:** `node dist/src/cli/index.js --help` — `--max-retries` shows no default.
- **Expected:** Show "(default: 2)" to match README "default `2`".
- **Actual:** `--max-retries <n>  retries for transient 429/503 responses` (no default).
- **Root cause:** `src/cli/program.ts:34` registers the option without a commander default; the real default is in `engine.ts:67`.

### 12. `--max-response-bytes` help says "default 100 MiB" in prose but no machine default is registered — ✅ FIXED
- **Fix:** `src/cli/program.ts` — `--max-response-bytes` now registers a commander default of `104857600` (100 MiB), so help shows "(default: 104857600)" alongside the human "100 MiB" prose.
- **Severity:** Low
- **Confidence:** High
- **Repro:** `node dist/src/cli/index.js --help`.
- **Expected/Actual:** The description text says "default 100 MiB", but commander has no default value, so `command.opts()` reports `undefined` when the flag is omitted; the 100 MiB default is applied only later inside the engine (`engine.ts:70`). The "default" is therefore documented in two disconnected places and not surfaced as an actual commander default — easy to drift.
- **Root cause:** `src/cli/program.ts:35-39`.

### 13. README "Exit codes" omits the codes the CLI actually returns for usage/parse errors — ✅ FIXED
- **Fix:** `src/cli/run.ts` + `README.md` — usage/parse errors (any non-zero `CommanderError`) now exit `2`, distinct from runtime errors; the README "Exit codes" section is replaced with a full table (0/1/2/4/5/6/7).
- **Severity:** Low
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js bogus            ; echo $?   # 1
  node dist/src/cli/index.js station-overview ; echo $?   # 1 (missing required --id)
  node dist/src/cli/index.js                  ; echo $?   # 1 (no command)
  ```
- **Expected:** README ("Exit codes: `0` success, `4` on a `404`, `1` for any other error, non-zero for usage errors") implies usage errors might use a distinct non-zero code; in practice they are all `1`, indistinguishable from runtime errors.
- **Actual:** Unknown command, unknown option, missing required option, and bad `--lang` all exit `1` — the same code as a network failure or parse error, so scripts cannot tell a usage mistake from a server problem.
- **Root cause:** `src/cli/run.ts:32-34` returns `err.exitCode` (commander uses 1 for parse errors) and `:42-44` returns 1 for every `DwdError`; no separate usage-vs-runtime exit code.

### 14. Network errors, parse errors and generic API errors are all collapsed into exit code 1 — ✅ FIXED
- **Fix:** `src/cli/run.ts` + `README.md` — `run()` now maps `DwdNetworkError`→`6`, `DwdParseError`→`7`, non-404 `DwdApiError`→`5` (404 stays `4`), generic `DwdError`→`1`, via a documented `EXIT` constant. README exit-code table updated to match.
- **Severity:** Low
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:1 station-overview --id 10865 ; echo $?  # 1 (ECONNREFUSED)
  node dist/src/cli/index.js --timeout 1 warnings nowcast                              ; echo $?  # 1 (timeout)
  # 500-class API error                                                                            # 1
  ```
- **Expected:** Only 404 is given a distinct code (4). The README leads scripters to expect 404 distinguishability but provides no way to distinguish a transport failure (`DwdNetworkError`), a malformed body (`DwdParseError`), and a generic non-404 HTTP error — all are `1`.
- **Actual:** `DwdNetworkError`, `DwdParseError` and non-404 `DwdApiError` all map to exit 1 (`run.ts:36-45`). Given the error classes already exist, this is a missed opportunity and a documentation/behaviour thinness.
- **Root cause:** `src/client/errors.ts` defines distinct classes, but `src/cli/run.ts:36-48` only special-cases `status === 404`.

### 15. Invalid global numeric flags print the wrong usage block and lose subcommand context — ✅ FIXED
- **Fix:** `src/cli/program.ts` — `.showHelpAfterError(false)` so a single bad flag prints only the focused commander error, not the whole top-level help dump. (`--help` still shows the listing and exits 0.)
- **Severity:** Low
- **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --timeout abc warnings nowcast
  ```
- **Expected:** A focused error about `--timeout`; ideally without dumping the entire top-level command listing.
- **Actual:**
  ```
  error: option '--timeout <ms>' argument 'abc' is invalid. Expected a non-negative integer.

  Usage: dwd [options] [command]
  ...full top-level help dump...
  exit=1
  ```
  Because `showHelpAfterError()` is set on the root (`program.ts:41`), every global parse error prints the whole top-level help, which is noisy for a single bad flag. (Exit code is correct at 1.)
- **Root cause:** `src/cli/program.ts:41` `.showHelpAfterError()`.

### 16. `crowd` / `warnings` parent emit usage text on stderr but exit 1, making "show me help" indistinguishable from an error — ✅ FIXED
- **Fix:** `src/cli/program.ts` + `src/cli/commands/weather.ts` — the bare program and the `warnings` group now have `.action()`s that call `outputHelp()` (writes help to stdout via the configured writeOut) and return normally, so `dwd` and `dwd warnings` print help to stdout and exit 0, consistent with `--help`.
- **Severity:** Low
- **Confidence:** Medium
- **Repro:**
  ```
  node dist/src/cli/index.js warnings ; echo $?   # prints the warnings help, exit=1
  node dist/src/cli/index.js          ; echo $?   # prints top-level help, exit=1
  ```
- **Expected:** Running a group command with no subcommand is a common "what can I do here" gesture; commander treats it as an error (exit 1) and writes to stderr. Compare `--help`, which exits 0. Inconsistent.
- **Actual:** Bare `warnings` and bare program both exit 1 with help routed through `writeErr` (`run.ts:19`).
- **Root cause:** commander default `helpCommand`/no-action behaviour; `src/cli/run.ts:16-21` routes all help via `writeErr`, and there is no `.action()` on the `warnings` group to print help with exit 0.

### 17. Empty `--id ""` is silently sent as `stationIds=` (empty query param) rather than rejected — ✅ FIXED
- **Fix:** `src/cli/commands/weather.ts` — the repeatable-id accumulator (renamed `collectStationId`) now throws `InvalidArgumentError("A station id must not be empty.")` for an empty/blank value, so `--id ""` is rejected as a usage error (exit 2) before any request. (The `--id "-5"` case noted in the repro is left as-is: negative-looking ids are not blank, and the README does not constrain the id format beyond "5-digit"; only the clear empty-string defect is fixed.)
- **Severity:** Low
- **Confidence:** High
- **Repro** (against a request-echoing local server):
  ```
  node dist/src/cli/index.js --base-url "http://127.0.0.1:<port>" station-overview --id ""
  # server receives: GET /v30/stationOverviewExtended?stationIds=
  ```
- **Expected:** An empty station id should be rejected as a usage error before any request is made.
- **Actual:** The empty string is accepted, joined, and sent as `stationIds=` (and against the live API returns `{}` with exit 0). Same for `--id "-5"` → `stationIds=-5`.
- **Root cause:** `src/cli/commands/weather.ts:7-9,15` — the `collect` accumulator and `client.weather.stationOverview` (`client.ts:45-47`) perform no per-id validation; ids are passed through verbatim.

---

## Verified-correct behaviour (no bug — checked because the brief asked)

- **Gzip feed decompression is correct / no data loss.** `warnings nowcast` output deep-equals `curl --compressed` of `…/v16/warnings_nowcast.json` (keys `time,warnings,binnenSee`; `JSON.stringify` identical).
- **404 → exit 4** confirmed against both a local 404 server and the live web service (`--base-url https://app-prod-ws.warnwetter.de/NOPATH station-overview --id 10865` → exit 4).
- **Closed port / bad DNS** give clear `DwdNetworkError`s (`connect ECONNREFUSED …`, `getaddrinfo ENOTFOUND …`), exit 1.
- **Unsupported protocols** (`file:`, `ftp:`) and malformed base URLs are rejected with typed errors, exit 1 (no SSRF to file:/ftp:).
- **Special characters / injection in `--id`** are correctly URL-encoded (`a&b=c #x` → `stationIds=a%26b%3Dc%20%23x`).
- **`--lang` validation** rejects `fr`, ``(empty), `DE`/`EN` (case-sensitive) with a clear message, exit 1; `--lang=en` works.
- **deflate (zlib + raw) and brotli** decoding all work when a server sends them (only reachable by an unsolicited `Content-Encoding`; see bug 6).
- **429/503 retry** works (server returning 503 twice then 200 succeeds with `--max-retries 2`).
- **The decompressed-size cap does fire** (memory-bomb protection is effective) — the only problem is the misleading message (bug 1).
- **`--timeout 1`** correctly aborts with `Request timed out after 1ms`, exit 1.
- **Pretty vs `--compact`** both render correctly; `--compact` works before or after the command.

---

### Summary
**17 genuine, reproducible bugs** (3 fewer than the requested 20). Most serious:
1. **Bug 1** — the decompression-bomb size cap reports a misleading generic "Failed to decode" error instead of the documented `Response exceeded maxResponseBytes`, hiding that the protection (not corruption) is what fired (`http.ts:149-160`).
2. **Bugs 2–5** — `parseIntArg` silently accepts hex (`0x10`), scientific notation (`1e3`), whitespace-padded numbers, and out-of-safe-range values with precision loss, violating its "non-negative integer" contract and silently mis-setting timeouts and the response-byte cap (`shared.ts:11-17`).
3. **Bug 6** — no `Accept-Encoding` header is sent, so the advertised deflate/brotli decoding is effectively dead code against any RFC-compliant origin; transparent compression works only by luck of DWD's S3 bucket sending `Content-Encoding: gzip` unsolicited (`engine.ts:88-91`).
