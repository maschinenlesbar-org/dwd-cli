import { test } from "node:test";
import assert from "node:assert/strict";
import { DwdClient } from "../src/client/client.js";
import { DwdApiError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>): DwdClient {
  return new DwdClient({ transport: mt.transport });
}

test("stationOverview hits the live ws host with joined ids", async () => {
  const mt = constantJson({ "10865": {} });
  await clientWith(mt).weather.stationOverview(["10865", "01766"]);
  const url = new URL(mt.last().url);
  assert.equal(url.host, "app-prod-ws.warnwetter.de");
  assert.equal(url.pathname, "/v30/stationOverviewExtended");
  assert.equal(url.searchParams.get("stationIds"), "10865,01766");
});

test("warnings.nowcast (de) hits the static bucket, no suffix", async () => {
  const mt = constantJson({ time: 1, warnings: [] });
  await clientWith(mt).warnings.nowcast("de");
  const url = new URL(mt.last().url);
  assert.equal(url.host, "s3.eu-central-1.amazonaws.com");
  assert.equal(url.pathname, "/app-prod-static.warnwetter.de/v16/warnings_nowcast.json");
});

test("warnings.nowcast (en) uses the _en suffix", async () => {
  const mt = constantJson({ time: 1, warnings: [] });
  await clientWith(mt).warnings.nowcast("en");
  assert.match(new URL(mt.last().url).pathname, /warnings_nowcast_en\.json$/);
});

test("warnings.gemeinde defaults to German", async () => {
  const mt = constantJson({ time: 1, warnings: [] });
  await clientWith(mt).warnings.gemeinde();
  assert.match(new URL(mt.last().url).pathname, /gemeinde_warnings_v2\.json$/);
});

test("warnings.coast (en) uses the static bucket with the _en suffix", async () => {
  const mt = constantJson({ time: 1, warnings: [] });
  await clientWith(mt).warnings.coast("en");
  const url = new URL(mt.last().url);
  assert.equal(url.host, "s3.eu-central-1.amazonaws.com");
  assert.match(url.pathname, /warnings_coast_en\.json$/);
});

test("crowd hits the static bucket", async () => {
  const mt = constantJson({ meldungen: [] });
  await clientWith(mt).crowd();
  assert.match(new URL(mt.last().url).pathname, /\/v16\/crowd_meldungen_overview_v2\.json$/);
});

test("a custom staticBaseUrl is honoured", async () => {
  const mt = constantJson({ time: 1, warnings: [] });
  await new DwdClient({ transport: mt.transport, staticBaseUrl: "https://example.test" }).warnings.nowcast();
  assert.equal(new URL(mt.last().url).host, "example.test");
});

test("a 404 raises DwdApiError with status 404", async () => {
  const mt = makeMockTransport(() => jsonResponse({}, 404));
  await assert.rejects(
    () => clientWith(mt).weather.stationOverview(["x"]),
    (err) => err instanceof DwdApiError && err.status === 404,
  );
});
