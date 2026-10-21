import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RETRY_AFTER_MS, RequestEngine, bigIntegerKeysOption, firstInexactNumber, parseRetryAfter, scanNumbers } from "../src/engine.js";
import { DwdApiError, DwdNetworkError, DwdParseError, DwdValidationError, cutText, toWellFormed } from "../src/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";
import type { HttpResponse } from "../src/http.js";

// Control chars are built via char codes so no raw control bytes ever appear in
// this source file (which would otherwise be mangled by editors/tooling).
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b); // a C1 control

/** True if the string contains any C0/C1 control char except tab/newline. */
function hasControlChars(s: string): boolean {
  return [...s].some((c) => {
    const n = c.charCodeAt(0);
    return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
  });
}

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("v30/"), "https://example.test/v30/");
  assert.equal(
    e.buildUrl("/x", { a: "1", b: ["2", "3"] }),
    "https://example.test/x?a=1&b=2&b=3",
  );
});

test("buildUrl preserves a base URL path prefix", () => {
  const e = new RequestEngine({ baseUrl: "https://host.test/api" });
  assert.equal(e.buildUrl("/v16/x"), "https://host.test/api/v16/x");
});

test("the constructor rejects a scheme-only base URL instead of mangling the host", () => {
  assert.throws(
    () => new RequestEngine({ baseUrl: "https:" }),
    (err: unknown) => err instanceof DwdValidationError && !(err instanceof DwdNetworkError),
  );
});

test("the constructor rejects a base URL carrying a query string", () => {
  assert.throws(
    () => new RequestEngine({ baseUrl: "https://example.test/?foo=bar" }),
    (err: unknown) =>
      err instanceof DwdValidationError &&
      err.message === "Invalid baseUrl: A base URL cannot have a query (?) or fragment (#).",
  );
});

test("the constructor rejects every malformed base-URL shape, with no request", () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  for (const bad of ["", " https://h.example", "https://h.example/ ", "https://h.example/p\t", "ftp://h.example", "https://h.example#f"]) {
    assert.throws(() => new RequestEngine({ baseUrl: bad, transport: mt.transport }), DwdValidationError, JSON.stringify(bad));
  }
  assert.equal(mt.calls.length, 0);
});

test("getJson parses a JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: true });
});

test("getJson throws DwdParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), DwdParseError);
});

test("a number the JSON cannot carry exactly is a parse error, never a changed value", async () => {
  // JSON.parse rounds 12345678901234567890 (in any form: .0, e0, E-1) and 9007199254740992.5 to the
  // nearest double, turns 1e400 into Infinity (printed as null) and 1e-400 into 0, silently.
  const body = (n: string) => `{"id":"a","n":${n},"text":"12345678901234567890 in a string"}`;
  for (const n of [
    "12345678901234567890", "-9007199254740993", "1e400", "-1E400", "12345678901234567890.0", "9007199254740993e0",
    "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399",
    "123456789012345678901234567890",
    // Below the smallest normal double a subnormal has fewer digits: 3e-324 became 5e-324.
    "3e-324", "4e-324", "-4.9e-324", "1.2345678901234567e-310", "2.225073858507201e-309",
  ]) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    await assert.rejects(e.getJson("/v30/stationOverviewExtended"), (err: unknown) => {
      assert.ok(err instanceof DwdParseError, n);
      assert.equal(err.message, `GET https://app-prod-ws.warnwetter.de/v30/stationOverviewExtended: the number ${n} cannot be represented exactly.`);
      return true;
    });
  }
  // What a double carries exactly, or as JSON means it (a decimal fraction below 2^53), passes:
  // the station data's "no value" marker 32767 and epoch-ms times among them.
  const exact: Array<[string, number]> = [
    ["9007199254740991", 9007199254740991], ["9007199254740992.0", 2 ** 53], ["9007199254740992e0", 2 ** 53],
    ["90071992547409920E-1", 2 ** 53], ["1e21", 1e21], ["1.2e21", 1.2e21], ["0", 0], ["-0", -0], ["0.0e-500", 0],
    ["1.10", 1.1], ["0.1", 0.1], ["1.00000000000000001", 1], ["5e-324", 5e-324], ["32767", 32767],
    ["1760000000000", 1760000000000], ["100000000000000000000", 1e20],
    // A double a server printed in its shortest form reads back as that double and prints as the
    // same number: not a changed value, though the decimal is not the double's exact binary value.
    ["1e23", 1e23], ["100000000000000000000000", 1e23], ["1E23", 1e23], ["1.7976931348623157E308", Number.MAX_VALUE], ["-1.7976931348623157e308", -Number.MAX_VALUE],
    ["4.35e30", 4.35e30],
    // A subnormal or the smallest normal double that prints as written.
    ["-5e-324", -5e-324], ["1e-310", 1e-310], ["2.2250738585072014e-308", 2.2250738585072014e-308],
  ];
  for (const [n, value] of exact) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    assert.equal((await e.getJson<{ n: number }>("/x")).n, value, n);
  }
});

test("the number check skips strings and costs one pass over the text", async () => {
  // Escaped quotes and backslashes must not end a string early and expose its digits.
  const tricky = `{"id":"a","s":"\\\\\\"12345678901234567890\\\\","t":"1e400","n":[1,2.5,-3e2]}`;
  const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(tricky, "application/json")).transport });
  assert.deepEqual(await e.getJson("/x"), JSON.parse(tricky));
  // 1 MB of numbers: the scan is linear.
  const big = `[${Array.from({ length: 200_000 }, (_, i) => i * 7).join(",")}]`;
  const f = new RequestEngine({ transport: makeMockTransport(() => rawResponse(big, "application/json")).transport });
  assert.equal((await f.getJson<number[]>("/x")).length, 200_000);
});

test("a 503 is retried up to maxRetries then surfaces as DwdApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ detail: "busy" }, 503);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async () => {},
  });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof DwdApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

// ---- Retry-After ----

function retryingEngine(retryAfter: string | undefined, maxRetries = 2) {
  const delays: number[] = [];
  const mt = makeMockTransport(() => ({
    status: 429,
    headers: {
      "content-type": "application/json",
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    },
    body: Buffer.from(JSON.stringify({ detail: "slow down" })),
  }));
  const engine = new RequestEngine({
    transport: mt.transport,
    maxRetries,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { engine, mt, delays };
}

test("a 429 with Retry-After in seconds waits that long before each retry", async () => {
  const { engine, mt, delays } = retryingEngine("1");
  await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof DwdApiError && e.status === 429);
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test("without a usable Retry-After the retries back off linearly", async () => {
  for (const header of [undefined, "", "-1", "1.5", "soon", "1e3", "2026-09-26T10:00:00Z"]) {
    const { engine, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getJson("/x"));
    assert.deepEqual(delays, [200, 400], String(header));
  }
});

test("a Retry-After above MAX_RETRY_AFTER_MS is not retried: the error surfaces at once", async () => {
  for (const header of ["31", "99999999", "99999999999999999999", "Fri, 31 Dec 9999 23:59:59 GMT"]) {
    const { engine, mt, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof DwdApiError && e.status === 429);
    assert.equal(mt.calls.length, 1, header);
    assert.deepEqual(delays, [], header);
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdate HTTP-dates", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter(" 30 ", now), 30_000);
  assert.equal(parseRetryAfter(["2", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0); // past date: retry now
  for (const bad of [undefined, "", "-1", "+5", "1.5", "1e3", "0x10", "Saturday, 26-Sep-26 10:00:05 GMT"]) {
    assert.equal(parseRetryAfter(bad, now), undefined, String(bad));
  }
  assert.equal(MAX_RETRY_AFTER_MS, 30_000);
});

test("a retried request that then succeeds resolves", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});

test("follows a redirect, resolving a relative Location", async () => {
  let calls = 0;
  const mt = makeMockTransport((req) => {
    calls += 1;
    if (calls === 1) {
      return { status: 302, headers: { location: "/moved" }, body: Buffer.from("") };
    }
    assert.equal(new URL(req.url).pathname, "/moved");
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

test("stops following redirects past maxRedirects with a clear 'too many redirects' error", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return { status: 302, headers: { location: "/loop" }, body: Buffer.from("") };
  });
  const e = new RequestEngine({
    baseUrl: "https://example.test",
    transport: mt.transport,
    maxRedirects: 2,
  });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof DwdNetworkError && /Too many redirects/.test(err.message),
  );
  assert.equal(calls, 3); // initial + 2 redirect hops
});

test("strips sensitive headers on a cross-origin redirect but keeps them same-origin", async () => {
  // The engine reuses a single headers object across redirect hops. We seed a
  // sensitive header into that object on the first hop (via the transport, which
  // receives the very same object), then assert it is dropped only when the
  // redirect target is a different origin.
  function run(location: string): Promise<{ origin: string; auth: unknown }> {
    let calls = 0;
    const mt = makeMockTransport((req) => {
      calls += 1;
      if (calls === 1) {
        // Simulate a per-host credential having been attached upstream.
        if (req.headers) req.headers["Authorization"] = "Bearer secret";
        return { status: 302, headers: { location }, body: Buffer.from("") };
      }
      return jsonResponse({ ok: 1 });
    });
    const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
    return e.getJson("/x").then(() => ({
      origin: new URL(mt.last().url).origin,
      auth: mt.last().headers?.["Authorization"],
    }));
  }

  const cross = await run("https://evil.test/grab");
  assert.equal(cross.origin, "https://evil.test");
  assert.equal(cross.auth, undefined); // stripped across origins

  const same = await run("https://example.test/moved");
  assert.equal(same.origin, "https://example.test");
  assert.equal(same.auth, "Bearer secret"); // preserved on the same origin
});

test("refuses to follow a redirect to a non-http(s) scheme (defends a custom transport)", async () => {
  // A hostile server tries to steer a custom transport at file:. The engine must
  // reject the scheme before ever calling the transport again.
  const mt = makeMockTransport((req) => {
    if (req.url.endsWith("/x")) {
      return { status: 302, headers: { location: "file:///etc/passwd" }, body: Buffer.from("") };
    }
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof DwdNetworkError && /unsupported protocol/i.test(err.message),
  );
  // The redirect target was never fetched.
  assert.equal(mt.calls.length, 1);
});

test("a malformed redirect Location surfaces as a typed DwdNetworkError", async () => {
  const mt = makeMockTransport(() => ({
    status: 302,
    headers: { location: "http://[not-a-valid-host" },
    body: Buffer.from(""),
  }));
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof DwdNetworkError && /invalid redirect location/i.test(err.message),
  );
});

test("error detail is stripped of terminal control characters", async () => {
  // ESC + CSI + BEL interleaved with printable text, delivered as a JSON error body.
  const evil = `boom${ESC}[31mred${BEL}${CSI}2J`;
  const mt = makeMockTransport(() =>
    jsonResponse({ detail: evil }, 500),
  );
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 0 });

  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof DwdApiError);
      // The control bytes are gone from both the structured detail and the
      // human-readable message that run.ts prints to stderr...
      assert.ok(!hasControlChars(err.detail ?? ""));
      assert.ok(!hasControlChars(err.message));
      // ...while the printable characters are preserved.
      assert.equal(err.detail, "boom[31mred2J");
      return true;
    },
  );
});

test("the echoed Content-Type in a parse error is stripped of control characters", async () => {
  const evilType = `text/html${ESC}[2J`;
  const mt = makeMockTransport(() => rawResponse("<html>", evilType));
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 0 });

  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof DwdParseError);
      assert.ok(!hasControlChars(err.message));
      return true;
    },
  );
});

test("base-URL errors do not echo userinfo", () => {
  assert.throws(
    () => new RequestEngine({ baseUrl: "http://user:s3cret@example.test/?x=1" }),
    (err: unknown) => err instanceof DwdValidationError && !err.message.includes("s3cret"),
  );
});

test("a malformed redirect Location is printed without its control characters", async () => {
  const mt = makeMockTransport(() => ({
    status: 302,
    headers: { location: `http://[x${CSI}2J${ESC}[31m` },
    body: Buffer.from(""),
  }));
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => err instanceof Error && !hasControlChars(err.message) && err.message.includes("http://[x2J[31m"),
  );
});

test("only 301/302/303/307/308 are followed; another 3xx names its target and is not followed", async () => {
  for (const status of [300, 304, 305, 306]) {
    const mt = makeMockTransport(() => ({
      status,
      headers: { location: "/ok" },
      body: Buffer.from(""),
    }));
    const e = new RequestEngine({ baseUrl: "https://user:pw@example.test", transport: mt.transport });
    await assert.rejects(
      () => e.getJson("/x"),
      (err: unknown) =>
        err instanceof DwdApiError &&
        err.status === status &&
        // The base URL's userinfo travels as the Authorization header, never in a URL.
        err.location === "https://example.test/ok" &&
        err.message === `HTTP ${status} for GET https://example.test/x: redirect to https://example.test/ok not followed` &&
        mt.last().headers?.["Authorization"] === `Basic ${Buffer.from("user:pw").toString("base64")}` &&
        !mt.last().url.includes("user"),
    );
    assert.equal(mt.calls.length, 1, String(status));
  }
  const noLocation = makeMockTransport(() => ({ status: 302, headers: {}, body: Buffer.from("") }));
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: noLocation.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) =>
      err instanceof DwdApiError &&
      err.message === "HTTP 302 for GET https://example.test/x: redirect not followed (no Location header)",
  );
});

test("numeric engine options must be integers in range; a negative timeoutMs no longer disables the timeout", () => {
  const bad: Array<[string, number]> = [
    ["timeoutMs", -5],
    ["timeoutMs", Number.NaN],
    ["timeoutMs", 1.5],
    ["timeoutMs", 2 ** 31],
    ["maxRetries", -1],
    ["maxRetries", Number.POSITIVE_INFINITY],
    ["maxRetries", 11],
    ["retryDelayMs", 30_001],
    ["maxRedirects", Number.NaN],
    ["maxRedirects", 21],
    ["maxResponseBytes", -1],
  ];
  for (const [name, value] of bad) {
    assert.throws(
      () => new RequestEngine({ [name]: value }),
      (err: unknown) =>
        err instanceof Error &&
        err.message.startsWith(`Invalid option ${name}: expected an integer from 0 to `),
      `${name}=${value}`,
    );
  }
  // 0 stays valid: no timeout, no retries, no redirects, no size cap.
  new RequestEngine({ timeoutMs: 0, maxRetries: 0, retryDelayMs: 0, maxRedirects: 0, maxResponseBytes: 0 });
});

test("a UTF-8 BOM is ignored and the Content-Type charset is honoured", async () => {
  const bom = makeMockTransport(() =>
    rawResponse(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]), "application/json"),
  );
  assert.deepEqual(await new RequestEngine({ transport: bom.transport }).getJson("/x"), { a: 1 });

  const latin1 = makeMockTransport(() =>
    rawResponse(Buffer.from('{"place":"München"}', "latin1"), "application/json; charset=iso-8859-1"),
  );
  assert.deepEqual(await new RequestEngine({ transport: latin1.transport }).getJson("/x"), { place: "München" });

  const unknown = makeMockTransport(() => rawResponse("{}", `application/json; charset=x-bogus${ESC}[2J`));
  await assert.rejects(
    () => new RequestEngine({ transport: unknown.transport }).getJson("/x"),
    (err: unknown) =>
      err instanceof DwdParseError && err.message === 'GET https://app-prod-ws.warnwetter.de/x: unsupported response charset "x-bogus[2J".',
  );
});

test("a JSON parse error names the parser's reason; an empty body says it is empty", async () => {
  for (const [body, reason] of [
    ["", /^GET https:\/\/app-prod-ws\.warnwetter\.de\/x: empty response body\.$/],
    ['{"a":', /: the answer is not valid JSON: Unexpected end of JSON input$/],
    ["nope", /: the answer is not valid JSON: Unexpected token/],
  ] as const) {
    const mt = makeMockTransport(() => rawResponse(body, "application/json"));
    await assert.rejects(
      () => new RequestEngine({ transport: mt.transport }).getJson("/x"),
      (err: unknown) =>
        err instanceof DwdParseError &&
        err.message.startsWith("GET https://app-prod-ws.warnwetter.de/x: ") &&
        reason.test(err.message),
      JSON.stringify(body),
    );
  }
});

test("custom transports: header names in any case are read (Location, Content-Type)", async () => {
  let n = 0;
  const mt = makeMockTransport(() =>
    n++ === 0
      ? { status: 302, headers: { Location: "/moved" } as unknown as HttpResponse["headers"], body: Buffer.alloc(0) }
      : { status: 200, headers: { "Content-Type": "text/html" } as unknown as HttpResponse["headers"], body: Buffer.from("<html>") },
  );
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof DwdParseError && /Content-Type "text\/html"/.test(err.message),
  );
  assert.equal(new URL(mt.last().url).pathname, "/moved");
});

test("custom transports: a Uint8Array error body keeps its detail and text", async () => {
  const body = new Uint8Array(Buffer.from('{"detail":"no such feed"}'));
  const mt = makeMockTransport(() => ({ status: 404, headers: { "content-type": "application/json" }, body: body as Buffer }));
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof DwdApiError && err.detail === "no such feed" && err.body === '{"detail":"no such feed"}',
  );
});

test("custom transports: a string body or missing headers is a DwdNetworkError, not a raw TypeError", async () => {
  for (const response of [
    { status: 200, headers: {}, body: "{}" },
    { status: 200, body: Buffer.from("{}") },
  ]) {
    const e = new RequestEngine({ transport: async () => response as unknown as HttpResponse });
    await assert.rejects(() => e.getJson("/x"), DwdNetworkError);
  }
});

test("server text in a message is cut at 500 characters; the error body keeps it all", async () => {
  const long = "x".repeat(200_000);
  const mt = makeMockTransport(() => jsonResponse({ detail: long }, 500));
  const e = new RequestEngine({ baseUrl: "https://example.test", transport: mt.transport, maxRetries: 0 });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof DwdApiError && err.detail?.length === 501 && err.detail.endsWith("…") && err.body.length > 200_000,
  );
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a� b� \u{1f600}");
});

test("a server detail cut at 500 characters keeps the message well-formed", async () => {
  for (const detail of ["\u{1f600}".repeat(600), "a" + "\u{1f600}".repeat(600)]) {
    const engine = new RequestEngine({
      baseUrl: "https://example.test",
      transport: async () => ({ status: 500, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ detail })) }),
      maxRetries: 0,
    });
    await assert.rejects(engine.getJson("/v30/x"), (err: Error) => {
      assert.equal(toWellFormed(err.message), err.message);
      assert.match(err.message, /…$/);
      return true;
    });
  }
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  // The engine sends the pair UTF-8 encoded (basicAuthorization), so that is the form a server echoes.
  const basic = Buffer.from("alice:pä ss-pw", "utf8").toString("base64");
  const body = JSON.stringify({ detail: `no: Basic ${basic} / alice:pä ss-pw / pä ss-pw` });
  const engine = new RequestEngine({
    baseUrl: "https://alice:p%C3%A4%20ss-pw@mirror.example",
    maxRetries: 0,
    transport: async () => ({ status: 401, headers: { "content-type": "application/json" }, body: Buffer.from(body) }),
  });
  await assert.rejects(engine.getJson("/v30/x"), (err: DwdApiError) => {
    for (const form of [basic, "alice:pä ss-pw", "pä ss-pw"]) assert.ok(!err.message.includes(form), err.message);
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    return true;
  });
});

test("onRetry is called once per retry, with the event fields, right before the sleep", async () => {
  const log: string[] = [];
  const events: unknown[] = [];
  let n = 0;
  const mt = makeMockTransport(() =>
    n++ < 2
      ? { status: 503, headers: n === 1 ? { "retry-after": "2" } : {}, body: Buffer.from("{}") }
      : jsonResponse({ ok: 1 }),
  );
  const e = new RequestEngine({
    transport: mt.transport,
    baseUrl: "https://user:pw@example.test",
    maxRetries: 3,
    sleep: async (ms) => void log.push(`sleep ${ms}`),
    onRetry: (ev) => {
      events.push(ev);
      log.push("retry");
    },
  });
  await e.getJson("/x");
  assert.deepEqual(log, ["retry", "sleep 2000", "retry", "sleep 400"]);
  assert.deepEqual(events, [
    { retry: 1, maxRetries: 3, delayMs: 2000, status: 503, url: "https://example.test/x" },
    { retry: 2, maxRetries: 3, delayMs: 400, status: 503, url: "https://example.test/x" },
  ]);
});

test("onRetry reports a reset connection without a status", async () => {
  let n = 0;
  const events: unknown[] = [];
  const mt = makeMockTransport(() => {
    if (n++ === 0) throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    return jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {}, onRetry: (ev) => void events.push(ev) });
  await e.getJson("/x");
  assert.equal(events.length, 1);
  assert.equal((events[0] as { status?: number }).status, undefined);
  assert.equal((events[0] as { retry: number }).retry, 1);
});

test("onRetry is never called without a retry, and a throw in it is swallowed", async () => {
  const events: unknown[] = [];
  const onRetry = (ev: unknown) => void events.push(ev);
  const ok = new RequestEngine({ transport: makeMockTransport(() => jsonResponse({ ok: 1 })).transport, sleep: async () => {}, onRetry });
  await ok.getJson("/x");
  const notFound = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 404, headers: { "content-type": "application/json" }, body: Buffer.from('{"detail":"no"}') })).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(notFound.getJson("/x"), DwdApiError);
  // retries exhausted: the last 503 is an error, not a retry
  const down = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: {}, body: Buffer.from("{}") })).transport,
    maxRetries: 1,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(down.getJson("/x"), DwdApiError);
  assert.equal(events.length, 1);
  // a Retry-After over the cap is not retried
  const long = new RequestEngine({
    transport: makeMockTransport(() => ({ status: 503, headers: { "retry-after": "999999" }, body: Buffer.from("{}") })).transport,
    sleep: async () => {},
    onRetry,
  });
  await assert.rejects(long.getJson("/x"), DwdApiError);
  assert.equal(events.length, 1);
  let n = 0;
  const throwing = new RequestEngine({
    transport: makeMockTransport(() => (n++ === 0 ? { status: 503, headers: {}, body: Buffer.from("{}") } : jsonResponse({ ok: 1 }))).transport,
    sleep: async () => {},
    onRetry: () => {
      throw new Error("boom");
    },
  });
  await throwing.getJson("/x");
});

test("onRetry must be a function", () => {
  assert.throws(() => new RequestEngine({ onRetry: 5 as never }), DwdValidationError);
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  const headers = JSON.parse('{"__proto__":{"content-type":"text/html"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from('{"a":1}') }) });
  // With the prototype set, "text/html" was read as the Content-Type and the answer refused.
  assert.deepEqual(await e.getJson("/x"), { a: 1 });
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/json"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await f.getJson("/x"), { a: 1 });
});

test("bigIntegerKeys: a declared member's number is its exact literal as a string; others keep the rule (D3)", async () => {
  const body = '{"_version_":1858054135406919680,"small":{"_version_":5},"neg":{"\\u005fversion_":-12345678901234567890},' +
    '"s":{"_version_":"text"},"n":{"_version_":null},"arr":{"_version_":[1]},"t":"\\"_version_\\":1","n2":42}';
  const e = new RequestEngine({
    bigIntegerKeys: new Set(["_version_"]),
    transport: makeMockTransport(() => rawResponse(body, "application/json")).transport,
  });
  assert.deepEqual(await e.getJson("/x"), {
    _version_: "1858054135406919680", small: { _version_: "5" }, neg: { _version_: "-12345678901234567890" },
    s: { _version_: "text" }, n: { _version_: null }, arr: { _version_: [1] }, t: '"_version_":1', n2: 42,
  });
  assert.deepEqual([...e.bigIntegerKeys], ["_version_"]);
  // An undeclared big number is still refused; a declared member doesn't make others exact.
  const other = new RequestEngine({
    bigIntegerKeys: ["_version_"] as unknown as ReadonlySet<string>,
    transport: makeMockTransport(() => rawResponse('{"_version_":1858054135406919680,"id":12345678901234567890}', "application/json")).transport,
  });
  await assert.rejects(other.getJson("/x"), /the number 12345678901234567890 cannot be represented exactly/);
  // Malformed stays malformed: a declared member with a leading zero still fails JSON.parse.
  const malformed = new RequestEngine({ bigIntegerKeys: new Set(["_version_"]), transport: makeMockTransport(() => rawResponse('{"_version_":01}', "application/json")).transport });
  await assert.rejects(malformed.getJson("/x"), /the answer is not valid JSON/);
  for (const bad of [new Set([""]), new Set([1]), "x", 5, null]) {
    assert.throws(() => new RequestEngine({ bigIntegerKeys: bad as unknown as ReadonlySet<string> }),
      (err: unknown) => err instanceof DwdValidationError && err.message === "Invalid option bigIntegerKeys: expected a set of non-empty member names.");
  }
  // The option reader copies a set or a list; undefined is none.
  const names = new Set(["a"]);
  const copy = bigIntegerKeysOption(names);
  names.add("b");
  assert.deepEqual([...copy], ["a"]);
  assert.deepEqual([...bigIntegerKeysOption(["x", "y"] as unknown as ReadonlySet<string>)], ["x", "y"]);
  assert.equal(bigIntegerKeysOption(undefined).size, 0);
  // Without declarations the scan is the plain number check.
  assert.equal(firstInexactNumber('{"a":"1e400","b":3e-324}'), "3e-324");
  assert.deepEqual(scanNumbers('{"a":1}'), { json: '{"a":1}', inexact: undefined });
});

test("an answer error names the request: method and URL, userinfo redacted (D9)", async () => {
  const answers: Array<[string, () => HttpResponse]> = [
    ["the answer is not valid JSON", () => rawResponse("{", "application/json")],
    ["expected a JSON answer, got Content-Type \"text/html\"", () => rawResponse("<html>", "text/html")],
    ["empty response body", () => rawResponse(" ", "application/json")],
    ["cannot be represented exactly", () => rawResponse('{"n":1e400}', "application/json")],
    ["unsupported response charset", () => rawResponse("{}", "application/json; charset=x-bogus")],
  ];
  const base = new URL("https://app-prod-ws.warnwetter.de");
  base.username = "alice";
  base.password = "s3cret";
  for (const [what, respond] of answers) {
    const e = new RequestEngine({ baseUrl: base.href, transport: makeMockTransport(respond).transport });
    await assert.rejects(e.getJson("/v30/stationOverviewExtended", { stationIds: "10865" }), (err: unknown) => {
      assert.ok(err instanceof DwdParseError, what);
      // dwd's request URLs carry no userinfo (it is sent as a header): the messages show none.
      assert.ok(err.message.startsWith(`GET ${base.protocol}//${base.host}/v30/stationOverviewExtended?stationIds=10865: `), err.message);
      assert.ok(err.message.includes(what), `${what}: ${err.message}`);
      assert.ok(!err.message.includes("s3cret") && !err.message.includes("alice"), err.message);
      return true;
    });
  }
});
