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
