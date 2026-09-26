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
  const mt = constantJson({ time: 1, warnings: {}, vorabInformation: {} });
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

test("an unsupported lang rejects with a DwdError instead of serving the German feed", async () => {
  const { DwdError } = await import("../src/client/errors.js");
  const mt = constantJson({ time: 1, warnings: [] });
  const client = clientWith(mt);
  for (const call of [
    () => client.warnings.nowcast("fr" as never),
    () => client.warnings.gemeinde("EN" as never),
    () => client.warnings.coast(null as never),
  ]) {
    await assert.rejects(call, (err: unknown) => err instanceof DwdError && /^Invalid lang: expected one of de, en, got /.test(err.message));
  }
  assert.equal(mt.calls.length, 0);
});

test("stationOverview rejects an empty list, a blank id or an id with a comma before any request", async () => {
  const { DwdError } = await import("../src/client/errors.js");
  const mt = constantJson({});
  const client = clientWith(mt);
  await assert.rejects(
    () => client.weather.stationOverview([]),
    (err: unknown) => err instanceof DwdError && err.message === "Invalid stationIds: expected at least one station id.",
  );
  for (const ids of [["1,2"], ["10865", ""], [" "]]) {
    await assert.rejects(
      () => client.weather.stationOverview(ids),
      (err: unknown) => err instanceof DwdError && /^Invalid station id: expected a non-blank id without commas/.test(err.message),
      JSON.stringify(ids),
    );
  }
  assert.equal(mt.calls.length, 0);
});

test("a 2xx body without the promised top-level shape is a DwdParseError", async () => {
  const { DwdParseError } = await import("../src/client/errors.js");
  const cases: Array<[unknown, (c: DwdClient) => Promise<unknown>, string]> = [
    [null, (c) => c.crowd(), "/v16/crowd_meldungen_overview_v2.json: expected a JSON object with a meldungen array."],
    [{}, (c) => c.crowd(), "/v16/crowd_meldungen_overview_v2.json: expected a JSON object with a meldungen array."],
    [{ time: 1, warnings: {} }, (c) => c.warnings.nowcast(), "/v16/warnings_nowcast.json: expected a JSON object with a warnings array."],
    [[], (c) => c.warnings.gemeinde(), "/v16/gemeinde_warnings_v2.json: expected a JSON object with a warnings array."],
    [{ time: 1, warnings: [] }, (c) => c.warnings.coast(), "/v16/warnings_coast.json: expected a JSON object with a warnings object."],
    [null, (c) => c.weather.stationOverview(["1"]), "/v30/stationOverviewExtended: expected a JSON object."],
    [[1], (c) => c.weather.stationOverview(["1"]), "/v30/stationOverviewExtended: expected a JSON object."],
  ];
  for (const [body, call, message] of cases) {
    await assert.rejects(
      () => call(clientWith(constantJson(body))),
      (err: unknown) => err instanceof DwdParseError && err.message === `Unexpected response shape from ${message}`,
      message,
    );
  }
  // The live shapes pass, empty feeds included.
  assert.deepEqual(await clientWith(constantJson({})).weather.stationOverview(["nope"]), {});
  await clientWith(constantJson({ time: 1, warnings: [], binnenSee: null })).warnings.nowcast();
  await clientWith(constantJson({ time: 1, warnings: {}, vorabInformation: {} })).warnings.coast();
});
