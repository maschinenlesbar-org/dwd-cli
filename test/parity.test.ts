// CLI <-> library parity: the same input through run() and through the library,
// on one recording mock transport, must give the same outcome — both reject with
// no request, or both send the identical request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DwdClient } from "../src/client/client.js";
import { DwdValidationError } from "../src/client/errors.js";
import { parity, jsonResponse } from "./helpers.js";

const overview = () => jsonResponse({ "10865": { forecast1: {} } });

/** Both sides rejected the input and neither sent a request. */
function assertBothReject(r: Awaited<ReturnType<typeof parity>>, cliMessage: RegExp): void {
  assert.equal(r.cli.code, 2, r.cli.err);
  assert.match(r.cli.err, cliMessage);
  assert.equal(r.cli.requests.length, 0);
  assert.equal(r.lib.ok, false);
  assert.ok(!r.lib.ok && r.lib.error instanceof DwdValidationError, String(!r.lib.ok && r.lib.error));
  assert.equal(r.lib.requests.length, 0);
}

test("parity: a blank, control-character or non-Latin-1 User-Agent is rejected by both", async () => {
  for (const [ua, message] of [
    ["", /Expected a non-empty value\./],
    ["   ", /Expected a non-empty value\./],
    ["a\r\nX-Injected: 1", /Value contains control characters\./],
    ["a\u007fb", /Value contains control characters\./],
    ["app/\u{1F600}", /Value contains characters outside Latin-1 \(above U\+00FF\)\./],
    ["€", /Value contains characters outside Latin-1 \(above U\+00FF\)\./],
  ] as const) {
    const r = await parity(
      ["--compact", "--user-agent", ua, "station-overview", "--id", "10865"],
      (transport) => new DwdClient({ transport, userAgent: ua }).weather.stationOverview(["10865"]),
      overview,
    );
    assertBothReject(r, message);
    assert.ok(!r.lib.ok && r.lib.error instanceof Error && r.lib.error.message.startsWith("Invalid userAgent: "));
  }
});

test("parity: a Latin-1 or tab-carrying User-Agent is sent the same by both", async () => {
  for (const ua of ["é", "my\ttool/1.0"]) {
    const r = await parity(
      ["--compact", "--user-agent", ua, "station-overview", "--id", "10865"],
      (transport) => new DwdClient({ transport, userAgent: ua }).weather.stationOverview(["10865"]),
      overview,
    );
    assert.equal(r.cli.code, 0, r.cli.err);
    assert.equal(r.lib.ok, true);
    assert.deepEqual(r.cli.requests, r.lib.requests);
    assert.equal(r.lib.requests[0]!.headers?.["User-Agent"], ua);
  }
});

test("parity: a malformed --base-url / baseUrl is rejected by both, as a validation error", async () => {
  for (const [bad, message] of [
    [" https://app-prod-ws.warnwetter.de ", /A base URL cannot have surrounding whitespace\./],
    ["https://app-prod-ws.warnwetter.de\t", /A base URL cannot have surrounding whitespace\./],
    ["https://app-prod-ws.warnwetter.de/?", /A base URL cannot have a query \(\?\) or fragment \(#\)\./],
    ["https://h.example?x=1", /A base URL cannot have a query \(\?\) or fragment \(#\)\./],
    ["https://h.example/#f", /A base URL cannot have a query \(\?\) or fragment \(#\)\./],
    ["ftp://h.example", /Unsupported scheme "ftp:"\. Expected an http\(s\) URL\./],
    ["https:", /Expected an absolute http\(s\) URL\./],
    ["h.example", /Expected an absolute http\(s\) URL\./],
    ["not a url", /A base URL cannot contain whitespace or control characters\./],
    ["", /Expected an absolute http\(s\) URL\./],
  ] as const) {
    const r = await parity(
      ["--compact", "--base-url", bad, "station-overview", "--id", "10865"],
      (transport) => new DwdClient({ transport, baseUrl: bad }).weather.stationOverview(["10865"]),
      overview,
    );
    assertBothReject(r, message);
    assert.ok(!r.lib.ok && r.lib.error instanceof Error && r.lib.error.message.startsWith("Invalid baseUrl: "));
  }
});

test("parity: a malformed --static-base-url / staticBaseUrl is rejected by both, as a validation error", async () => {
  for (const [bad, message] of [
    ["https://s3.example/bucket ", /A base URL cannot have surrounding whitespace\./],
    ["https://s3.example/bucket?", /A base URL cannot have a query \(\?\) or fragment \(#\)\./],
    ["ftp://s3.example", /Unsupported scheme "ftp:"\. Expected an http\(s\) URL\./],
    ["", /Expected an absolute http\(s\) URL\./],
  ] as const) {
    const r = await parity(
      ["--compact", "--static-base-url", bad, "crowd"],
      (transport) => new DwdClient({ transport, staticBaseUrl: bad }).crowd(),
      () => jsonResponse({ meldungen: [] }),
    );
    assertBothReject(r, message);
    assert.ok(!r.lib.ok && r.lib.error instanceof Error && r.lib.error.message.startsWith("Invalid staticBaseUrl: "));
  }
});

test("parity: a well-formed base URL with a path prefix is sent the same by both", async () => {
  const r = await parity(
    ["--compact", "--static-base-url", "https://mirror.test/prefix/", "crowd"],
    (transport) => new DwdClient({ transport, staticBaseUrl: "https://mirror.test/prefix/" }).crowd(),
    () => jsonResponse({ meldungen: [] }),
  );
  assert.equal(r.cli.code, 0, r.cli.err);
  assert.equal(r.lib.ok, true);
  assert.deepEqual(r.cli.requests, r.lib.requests);
  assert.equal(r.lib.requests[0]!.url, "https://mirror.test/prefix/v16/crowd_meldungen_overview_v2.json");
});

test("parity: padded station ids are trimmed by both and send the same request", async () => {
  const both = () => jsonResponse({ "10865": { forecast1: {} }, "10870": { forecast1: {} } });
  for (const [argv, ids, expected] of [
    [["--id", " 10865 "], [" 10865 "], "10865"],
    [["--id", "\t10865"], ["\t10865"], "10865"],
    [["--id", " 10865 ", "--id", "10870"], [" 10865 ", "10870"], "10865,10870"],
  ] as const) {
    const r = await parity(
      ["--compact", "station-overview", ...argv],
      (transport) => new DwdClient({ transport }).weather.stationOverview([...ids]),
      both,
    );
    assert.equal(r.cli.code, 0, r.cli.err);
    assert.equal(r.lib.ok, true);
    assert.deepEqual(r.cli.requests, r.lib.requests);
    assert.equal(new URL(r.lib.requests[0]!.url).searchParams.get("stationIds"), expected);
  }
});

test("parity: a blank station id is rejected by both, with no request", async () => {
  const r = await parity(
    ["--compact", "station-overview", "--id", "  "],
    (transport) => new DwdClient({ transport }).weather.stationOverview(["  "]),
    overview,
  );
  assertBothReject(r, /A station id must not be empty\./);
});

test("parity: a base URL ending in the /v30 or /v16 the client adds is rejected by both, with a hint", async () => {
  const S3 = "https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de";
  for (const [option, bad, call, hint] of [
    ["--base-url", "https://app-prod-ws.warnwetter.de/v30", "ws", "Leave out /v30: the client adds /v30 itself (try https://app-prod-ws.warnwetter.de)."],
    ["--base-url", "https://h.example/api/v30/", "ws", "Leave out /v30: the client adds /v30 itself (try https://h.example/api)."],
    ["--static-base-url", `${S3}/v16`, "static", `Leave out /v16: the client adds /v16 itself (try ${S3}).`],
    ["--static-base-url", `${S3}/v16/`, "static", `Leave out /v16: the client adds /v16 itself (try ${S3}).`],
  ] as const) {
    const r = await parity(
      ["--compact", option, bad, ...(call === "ws" ? ["station-overview", "--id", "10865"] : ["crowd"])],
      (transport) =>
        call === "ws"
          ? new DwdClient({ transport, baseUrl: bad }).weather.stationOverview(["10865"])
          : new DwdClient({ transport, staticBaseUrl: bad }).crowd(),
      () => jsonResponse({ meldungen: [], "10865": {} }),
    );
    assertBothReject(r, new RegExp(hint.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
    const name = call === "ws" ? "baseUrl" : "staticBaseUrl";
    assert.ok(!r.lib.ok && r.lib.error instanceof Error && r.lib.error.message === `Invalid ${name}: ${hint}`);
  }
});

test("parity: the other host's segment is just a path prefix for both", async () => {
  const r = await parity(
    ["--compact", "--base-url", "https://mirror.test/v16", "station-overview", "--id", "1"],
    (transport) => new DwdClient({ transport, baseUrl: "https://mirror.test/v16" }).weather.stationOverview(["1"]),
    overview,
  );
  assert.equal(r.cli.code, 0, r.cli.err);
  assert.deepEqual(r.cli.requests, r.lib.requests);
  assert.equal(new URL(r.lib.requests[0]!.url).pathname, "/v16/v30/stationOverviewExtended");
});
