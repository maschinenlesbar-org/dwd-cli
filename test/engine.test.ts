import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine } from "../src/client/engine.js";
import { DwdApiError, DwdNetworkError, DwdParseError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

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

test("buildUrl rejects a scheme-only base URL instead of mangling the host", () => {
  const e = new RequestEngine({ baseUrl: "https:" });
  assert.throws(() => e.buildUrl("/v30/stationOverviewExtended"), DwdNetworkError);
});

test("buildUrl rejects a base URL carrying a query string", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/?foo=bar" });
  assert.throws(() => e.buildUrl("/v30/x"), DwdNetworkError);
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
