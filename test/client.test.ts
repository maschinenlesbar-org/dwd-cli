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
    // A warning feed must carry its publication time (finding 02#1).
    [{ warnings: [] }, (c) => c.warnings.nowcast(), "/v16/warnings_nowcast.json: expected a numeric time (epoch milliseconds)."],
    [{ time: "yesterday", warnings: [] }, (c) => c.warnings.gemeinde("en"), "/v16/gemeinde_warnings_v2_en.json: expected a numeric time (epoch milliseconds)."],
    [{ warnings: {} }, (c) => c.warnings.coast(), "/v16/warnings_coast.json: expected a numeric time (epoch milliseconds)."],
    [{ start: "x", meldungen: [] }, (c) => c.crowd(), "/v16/crowd_meldungen_overview_v2.json: expected a numeric start (epoch milliseconds) when it is present."],
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
  await clientWith(constantJson({ meldungen: [] })).crowd();
  await clientWith(constantJson({ start: 1, end: 2, meldungen: [] })).crowd();
});

test("stationOverview rejects an id with inner whitespace, ';' or a control character (finding 01#3)", async () => {
  const { DwdValidationError } = await import("../src/client/errors.js");
  const mt = constantJson({});
  for (const id of ["10865 10147", "10865\n10147", "10865;10147", "108\u009b65"]) {
    await assert.rejects(
      () => clientWith(mt).weather.stationOverview([id]),
      (err: unknown) => err instanceof DwdValidationError && /^Invalid station id: expected one id/.test(err.message) && !/[\u0080-\u009f]/.test(err.message),
      JSON.stringify(id),
    );
  }
  assert.equal(mt.calls.length, 0);
});

test("stationOverview turns the missing-value marker 32767 into null (finding 01#2)", async () => {
  const { STATION_MISSING_VALUE, replaceMissingValues } = await import("../src/client/client.js");
  assert.equal(STATION_MISSING_VALUE, 32767);
  const raw = {
    "10739": {
      forecast1: { start: 1, timeStep: 3600000, temperature: [97, 32767], precipitationTotal: [32767, 4], icon: [32767, 3], surfacePressure: [32767] },
      forecast2: { surfacePressure: [32767, 32767], sunshine: [10] },
      days: [{ dayDate: "2026-10-05", temperatureMax: 32767, sunshine: 0 }],
      threeHourSummaries: null,
      warnings: [{ level: 32767 }],
    },
    "x": 5,
  };
  const out = await clientWith(constantJson(raw)).weather.stationOverview(["10739"]);
  const st = out["10739"] as Record<string, any>;
  assert.deepEqual(st["forecast1"].temperature, [97, null]);
  assert.deepEqual(st["forecast1"].precipitationTotal, [null, 4]);
  assert.deepEqual(st["forecast1"].icon, [null, 3]);
  assert.deepEqual(st["forecast2"].surfacePressure, [null, null]);
  assert.equal(st["days"][0].temperatureMax, null);
  assert.equal(st["days"][0].sunshine, 0);
  assert.equal(st["forecast1"].start, 1);
  // warnings carry no scaled values: left alone.
  assert.deepEqual(st["warnings"], [{ level: 32767 }]);
  assert.equal(out["x"], 5);
  assert.deepEqual(replaceMissingValues({ a: { days: [32767] } }), { a: { days: [null] } });
});

test("missingStationIds names the requested ids the answer has no data for", async () => {
  const { missingStationIds } = await import("../src/index.js");
  assert.deepEqual(missingStationIds(["10865"], {}), ["10865"]);
  assert.deepEqual(missingStationIds([" 10865 ", "99999", "99999", "10147"], { "10865": { days: [] }, "10147": {} }), ["99999", "10147"]);
  assert.deepEqual(missingStationIds(["10865"], { "10865": { forecast1: {} } }), []);
  // An inherited key is not data.
  assert.deepEqual(missingStationIds(["toString"], {}), ["toString"]);
});

test("staleFeedProblem: older than STALE_FEED_MS is stale, newer, future or non-finite is not", async () => {
  const { staleFeedProblem, STALE_FEED_MS } = await import("../src/index.js");
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  assert.equal(STALE_FEED_MS, 3_600_000);
  assert.equal(staleFeedProblem(now - STALE_FEED_MS, now), undefined);
  assert.equal(staleFeedProblem(now + 60_000, now), undefined);
  assert.equal(staleFeedProblem(Number.NaN, now), undefined);
  assert.equal(
    staleFeedProblem(now - 90 * 60_000, now),
    "the feed was published 90 minutes ago (time 2026-10-06T10:30:00.000Z), more than 60 minutes; " +
      "DWD republishes it every few minutes, so warnings issued since are missing",
  );
  assert.match(staleFeedProblem(now - 20 * 60_000, now, 10 * 60_000) ?? "", /20 minutes ago .* more than 10 minutes/);
});

test("decodeStationOverview turns the scaled integers into real units and leaves the rest", async () => {
  const { decodeStationOverview, STATION_SCALE, STATION_SCALED_FIELDS } = await import("../src/index.js");
  assert.equal(STATION_SCALE, 10);
  assert.equal(STATION_SCALED_FIELDS["surfacePressure"], "hPa");
  const raw = {
    "10865": {
      forecast1: {
        stationId: "10865", start: 1791151200000, timeStep: 3600000,
        temperature: [97, -12, null, 32767], humidity: [904], surfacePressure: [10216],
        sunshine: [350], precipitationTotal: [14], windSpeed: null, icon: [4, 7], isDay: [false],
        temperatureStd: [3], cloudCoverTotal: [],
      },
      forecast2: { start: 1791410400000, timeStep: 10800000, dewPoint2m: [103], temperature: [] },
      days: [{ dayDate: "2026-10-05", temperatureMin: 124, temperatureMax: 220, precipitation: 12, windSpeed: 55,
        windGust: 167, windDirection: 3120, sunshine: 4120, sunrise: 1791177521000, icon: 3, icon1: null }],
      threeHourSummaries: null,
      warnings: [{ level: 2, temperature: 5 }],
    },
    "99999": "not an object",
  };
  const decoded = decodeStationOverview(raw as never);
  assert.deepEqual(decoded["10865"], {
    forecast1: {
      stationId: "10865", start: 1791151200000, timeStep: 3600000,
      temperature: [9.7, -1.2, null, null], humidity: [90.4], surfacePressure: [1021.6],
      sunshine: [35], precipitationTotal: [1.4], windSpeed: null, icon: [4, 7], isDay: [false],
      temperatureStd: [3], cloudCoverTotal: [],
    },
    forecast2: { start: 1791410400000, timeStep: 10800000, dewPoint2m: [10.3], temperature: [] },
    days: [{ dayDate: "2026-10-05", temperatureMin: 12.4, temperatureMax: 22, precipitation: 1.2, windSpeed: 5.5,
      windGust: 16.7, windDirection: 312, sunshine: 412, sunrise: 1791177521000, icon: 3, icon1: null }],
    threeHourSummaries: null,
    warnings: [{ level: 2, temperature: 5 }], // not station data: untouched
  });
  assert.equal(decoded["99999"], "not an object");
  // The input is not modified.
  assert.deepEqual((raw["10865"].forecast1.temperature), [97, -12, null, 32767]);
});

test("a feed time no Date can hold is a DwdParseError, not a RangeError (02 Bug 1)", async () => {
  const { DwdParseError } = await import("../src/client/errors.js");
  // ±8.64e15 ms is the range of a JavaScript Date; a time beyond it is no epoch time.
  for (const time of [-1e20, 1e20, -8.64e15 - 1, 8.64e15 + 1]) {
    const feeds: Array<[(c: DwdClient) => Promise<unknown>, unknown]> = [
      [(c) => c.warnings.nowcast(), []],
      [(c) => c.warnings.gemeinde("en"), []],
      [(c) => c.warnings.coast(), {}],
    ];
    for (const [call, warnings] of feeds) {
      const body = { time, warnings };
      await assert.rejects(
        () => call(clientWith(constantJson(body))),
        (err: unknown) => err instanceof DwdParseError && /expected a numeric time \(epoch milliseconds\)\.$/.test(err.message),
        String(time),
      );
    }
    await assert.rejects(() => clientWith(constantJson({ start: time, meldungen: [] })).crowd(), DwdParseError, `start ${time}`);
  }
  // The ends of the range are times.
  await clientWith(constantJson({ time: -8.64e15, warnings: [] })).warnings.nowcast();
  await clientWith(constantJson({ time: 8.64e15, warnings: [] })).warnings.nowcast();
});

test("staleFeedProblem never throws: a time no Date can hold is never stale, like NaN (02 Bug 1)", async () => {
  const { staleFeedProblem } = await import("../src/index.js");
  for (const time of [-1e20, -8.64e15 - 1, 1e20]) assert.equal(staleFeedProblem(time), undefined, String(time));
  assert.match(staleFeedProblem(-8.64e15) ?? "", /\(time -271821-04-20T00:00:00\.000Z\)/);
});
