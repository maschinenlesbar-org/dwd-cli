// This server's tools against a mock of the DWD API, with the skills' traps as cases: DWD's level,
// never the feed's number; calm is empty and a stale feed is named; the warning areas as GeoJSON,
// a page at a time; a forecast from the current hour with the end-aligned series and an unknown
// station as missing; crowd reports without what points to a person, an ambiguous place reported;
// the static feeds' source on the bucket, not the web service. The rules every server follows are
// the conformance tests (M1–M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, staticBase } from "../src/mcp/api.js";
import { parseConfig } from "../src/mcp/config.js";
import { listTools } from "../src/mcp/server.js";
import { connect } from "./harness.js";
import { coast, crowd, dwdApi, gemeinde, NOW, nowcast, REPORTS, station } from "./helpers.js";

const HOUR = 3_600_000;
/** The fixtures' feeds with the real clock: the tools read Date.now(). */
const shift = Date.now() - NOW;
const at = <T extends Record<string, unknown>>(feed: T): T => JSON.parse(JSON.stringify(feed), (key, value) => (["time", "start", "end", "timestamp"].includes(key) && typeof value === "number" ? value + shift : value));

test("six tools: the four use cases first, then the two generic ones", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["getWarningBriefing", "getWarningAreas", "getStationForecast", "checkCrowdReports", "getWarningFeed", "getStationOverview"]);
});

test("getWarningBriefing: DWD's level and stage, never the feed's number; its source the bucket's feeds", async () => {
  const connection = await connect({ transport: dwdApi({ gemeinde: at(gemeinde()), nowcast: at(nowcast()), coast: at(coast()) }) });
  const result = await connection.call("getWarningBriefing", {});
  const answer = result.structuredContent as Record<string, unknown>;
  assert.equal(answer["status"], "ok", result.content[0]?.text);
  const [first] = answer["warnings"] as { event: string; dwdLevel: number; stage: string }[];
  assert.deepEqual([first?.event, first?.dwdLevel, first?.stage], ["ORKANARTIGE BÖEN", 3, "Unwetterwarnung (red)"]);
  const bucket = "https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16";
  assert.equal(answer["source"], `${bucket}/warnings_nowcast.json, ${bucket}/gemeinde_warnings_v2.json, ${bucket}/warnings_coast.json`, "every feed read, each a URL of its own");
  assert.match(String(answer["licence"]), /Datenbasis: Deutscher Wetterdienst/);
  await connection.close();
});

test("getWarningBriefing: calm is empty with the reason; a stale feed is named, not called calm", async () => {
  const connection = await connect({ transport: dwdApi({ nowcast: { time: Date.now() - 3 * HOUR, warnings: [], binnenSee: null } }) });
  const answer = (await connection.call("getWarningBriefing", { feeds: ["nowcast"] })).structuredContent as Record<string, unknown>;
  assert.equal(answer["status"], "empty");
  assert.match(String(answer["reason"]), /over an hour ago, so newer warnings may be missing/);
  assert.match(String(answer["source"]), /\/v16\/warnings_nowcast\.json$/);
  await connection.close();
});

test("getWarningAreas: a FeatureCollection a page at a time, most severe first, with where the next page starts", async () => {
  const connection = await connect({ transport: dwdApi({ gemeinde: at(gemeinde()), nowcast: at(nowcast()) }) });
  const answer = (await connection.call("getWarningAreas", { limit: 2 })).structuredContent as Record<string, unknown>;
  assert.equal(answer["type"], "FeatureCollection");
  const features = answer["features"] as { type: string; geometry: { type: string }; properties: { event: string } }[];
  assert.equal(features.length, 2);
  assert.equal(features[0]?.properties.event, "ORKANARTIGE BÖEN");
  assert.equal(features[0]?.geometry.type, "Polygon");
  assert.equal(answer["total"], 6, "two nowcast areas, four Gemeinde areas (the frost has expired)");
  assert.equal(answer["nextOffset"], 2);
  await connection.close();
});

test("getStationForecast: from the current hour in German local time; an unknown station is missing; its source the web service", async () => {
  const connection = await connect({ transport: dwdApi() });
  const answer = (await connection.call("getStationForecast", { stationIds: ["10865", "99999"], hours: 2 })).structuredContent as Record<string, unknown>;
  assert.equal(answer["status"], "ok");
  assert.deepEqual(answer["missing"], ["99999"]);
  assert.equal(answer["source"], "https://app-prod-ws.warnwetter.de/v30/stationOverviewExtended?stationIds=10865,99999");
  const none = (await connection.call("getStationForecast", { stationIds: ["99999"] })).structuredContent as Record<string, unknown>;
  assert.equal(none["status"], "empty");
  assert.match(String(none["reason"]), /no data for station id 99999/);
  await connection.close();
});

test("checkCrowdReports: counts per category, no exact positions or photo links; an ambiguous place is reported", async () => {
  const connection = await connect({ transport: dwdApi({ crowd: at(crowd(REPORTS)) }) });
  const result = await connection.call("checkCrowdReports", { place: "Mainz" });
  const answer = result.structuredContent as Record<string, unknown>;
  assert.equal(answer["status"], "ok", result.content[0]?.text);
  assert.equal(answer["matched"], 3);
  assert.doesNotMatch(result.content[0]?.text ?? "", /example\.test|49\.992|imageUrl/);
  assert.match(String(answer["source"]), /app-prod-static\.warnwetter\.de\/v16\/crowd_meldungen_overview_v2\.json$/);
  const ambiguous = (await connection.call("checkCrowdReports", { place: "Neustadt" })).structuredContent as Record<string, unknown>;
  assert.equal(ambiguous["status"], "ambiguous");
  assert.equal((ambiguous["candidates"] as unknown[]).length, 2);
  await connection.close();
});

test("getWarningFeed: the feed as sent without the areas, coast warnings with their zone, the lakes apart", async () => {
  const connection = await connect({ transport: dwdApi({ gemeinde: at(gemeinde()), coast: at(coast()) }) });
  const feed = (await connection.call("getWarningFeed", { feed: "gemeinde", limit: 2 })).structuredContent as Record<string, unknown>;
  const warnings = feed["warnings"] as Record<string, unknown>[];
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0]?.["regions"], undefined);
  assert.equal(warnings[0]?.["regionCount"], 1);
  assert.equal(feed["total"], 5);
  assert.equal(feed["nextOffset"], 2);
  assert.deepEqual((feed["lakes"] as { lake: string }[]).map((l) => l.lake), ["208438000", "208439000"]);
  const zones = (await connection.call("getWarningFeed", { feed: "coast" })).structuredContent as Record<string, unknown>;
  assert.deepEqual((zones["warnings"] as { zone: string }[]).map((w) => w.zone), ["501000001", "501000002"]);
  await connection.close();
});

test("getStationOverview: decoded to real units; an unknown id is empty with the reason", async () => {
  const connection = await connect({ transport: dwdApi() });
  const answer = (await connection.call("getStationOverview", { stationId: "10865" })).structuredContent as Record<string, unknown>;
  const station = answer["station"] as { forecast1: { temperature: (number | null)[] } };
  assert.deepEqual(station.forecast1.temperature.slice(14, 17), [6.4, null, 6.6]);
  const none = (await connection.call("getStationOverview", { stationId: "99999" })).structuredContent as Record<string, unknown>;
  assert.equal(none["status"], "empty");
  await connection.close();
});

test("--base-url names a mirror of both hosts: the bucket's files are read from it too, and the sources say so", async () => {
  const api = dwdApi();
  const mirrored = new Client({ baseUrl: "http://mirror.test:8080/", transport: api.transport });
  await mirrored.crowd();
  await mirrored.weather.stationOverview(["10865"]);
  assert.deepEqual(api.calls.map((r) => r.url), ["http://mirror.test:8080/v16/crowd_meldungen_overview_v2.json", "http://mirror.test:8080/v30/stationOverviewExtended?stationIds=10865"]);
  assert.equal(staticBase("http://mirror.test:8080/"), "http://mirror.test:8080");
  assert.equal(staticBase("https://app-prod-ws.warnwetter.de"), "https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de");
  const connection = await connect({ transport: dwdApi(), config: { baseUrl: "http://mirror.test:8080" } });
  const answer = (await connection.call("checkCrowdReports", {})).structuredContent as Record<string, unknown>;
  assert.equal(answer["source"], "http://mirror.test:8080/v16/crowd_meldungen_overview_v2.json");
  await connection.close();
});

test("--base-url naming the default web service in another spelling is the default: the bucket stays the default bucket", () => {
  const bucket = "https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de";
  for (const spelling of ["https://APP-PROD-WS.warnwetter.de", "https://app-prod-ws.warnwetter.de:443", "https://App-Prod-Ws.Warnwetter.De:443/", "https://app-prod-ws.warnwetter.de/"]) {
    assert.equal(staticBase(spelling), bucket, spelling);
  }
  assert.equal(staticBase("https://app-prod-ws.warnwetter.de:8443"), "https://app-prod-ws.warnwetter.de:8443", "another port is another server: a mirror");
  assert.equal(staticBase("https://app-prod-ws.warnwetter.de/mirror"), "https://app-prod-ws.warnwetter.de/mirror");
});

test("a --base-url ending in /v16 is refused under the option the user gave, --base-url, never the client's staticBaseUrl", () => {
  const parsed = parseConfig(["--base-url", "http://mirror.test:8080/v16"]);
  assert.equal(parsed.kind, "error");
  assert.match(parsed.kind === "error" ? parsed.message : "", /^--base-url: Invalid baseUrl: Leave out \/v16: the client adds \/v16 itself \(try http:\/\/mirror\.test:8080\)\.$/);
  assert.throws(() => new Client({ baseUrl: "http://mirror.test:8080/v16/" }), /Invalid baseUrl: Leave out \/v16/);
});

test("the station tools' source is the request made, each id URL-encoded: never another request than the one answered", async () => {
  const api = dwdApi();
  const connection = await connect({ transport: api });
  const cases: [string, Record<string, unknown>, string][] = [
    ["getStationForecast", { stationIds: ["10865&x=1"] }, "stationIds=10865%26x%3D1"],
    ["getStationForecast", { stationIds: ["10865#"] }, "stationIds=10865%23"],
    ["getStationForecast", { stationIds: [" München ", "10865"] }, "stationIds=M%C3%BCnchen,10865"],
    ["getStationOverview", { stationId: "../x" }, "stationIds=..%2Fx"],
  ];
  for (const [tool, args, query] of cases) {
    const before = api.calls.length;
    const answer = (await connection.call(tool, args)).structuredContent as Record<string, unknown>;
    assert.equal(answer["source"], `https://app-prod-ws.warnwetter.de/v30/stationOverviewExtended?${query}`, JSON.stringify(args));
    const sent = new URL(api.calls[before]?.url ?? "");
    assert.equal(new URL(String(answer["source"])).searchParams.get("stationIds"), sent.searchParams.get("stationIds"), "the same ids as the request");
  }
  await connection.close();
});

test("checkCrowdReports withWarnings cites the warning feeds it read too", async () => {
  const connection = await connect({ transport: dwdApi({ crowd: at(crowd(REPORTS)), gemeinde: at(gemeinde()), nowcast: at(nowcast()) }) });
  const bucket = "https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16";
  const plain = (await connection.call("checkCrowdReports", { place: "Mainz" })).structuredContent as Record<string, unknown>;
  assert.equal(plain["source"], `${bucket}/crowd_meldungen_overview_v2.json`);
  const checked = (await connection.call("checkCrowdReports", { place: "Mainz", withWarnings: true })).structuredContent as Record<string, unknown>;
  assert.equal(checked["source"], `${bucket}/crowd_meldungen_overview_v2.json, ${bucket}/warnings_nowcast.json, ${bucket}/gemeinde_warnings_v2.json`);
  const english = (await connection.call("getWarningAreas", { lang: "en", feeds: ["gemeinde", "nowcast"] })).structuredContent as Record<string, unknown>;
  assert.equal(english["source"], `${bucket}/warnings_nowcast_en.json, ${bucket}/gemeinde_warnings_v2_en.json`);
  await connection.close();
});

test("a page past the end is empty and says where the entries are, never an ok with nothing in it", async () => {
  const connection = await connect({ transport: dwdApi({ gemeinde: at(gemeinde()), nowcast: at(nowcast()) }) });
  const areas = (await connection.call("getWarningAreas", { offset: 10000 })).structuredContent as Record<string, unknown>;
  assert.equal(areas["status"], "empty");
  assert.equal(areas["total"], 6);
  assert.equal(areas["reason"], "offset 10000 is past the end: the 6 features are at offsets 0 to 5.");
  const feed = (await connection.call("getWarningFeed", { feed: "gemeinde", offset: 100 })).structuredContent as Record<string, unknown>;
  assert.equal(feed["status"], "empty");
  assert.equal(feed["reason"], "offset 100 is past the end: the 5 warnings are at offsets 0 to 4.");
  const last = (await connection.call("getWarningFeed", { feed: "gemeinde", offset: 4 })).structuredContent as Record<string, unknown>;
  assert.equal(last["status"], "ok");
  await connection.close();
});

test("getStationForecast over the size cap keeps the stations in the order asked and pages on: the ones left out can be had", async () => {
  const ids = ["10865", "10147", "10384", "10637", "10513"];
  const stations = Object.assign({}, ...ids.map((id) => station(id)));
  const whole = await connect({ transport: dwdApi({ stations }) });
  const full = (await whole.call("getStationForecast", { stationIds: ids, hours: 72, days: 10 })).structuredContent as Record<string, unknown>;
  await whole.close();
  const listed = full["stations"] as { stationId: string }[];
  assert.deepEqual(listed.map((s) => s.stationId), ids, "the order asked, not the ids' order");
  const one = JSON.stringify(listed[0]).length;
  const cap = JSON.stringify(full).length - 2.5 * one;
  const connection = await connect({ transport: dwdApi({ stations }), config: { maxResultChars: Math.round(cap) } });
  const seen: string[] = [];
  let offset = 0;
  for (let call = 0; call < 5 && offset < ids.length; call++) {
    const page = (await connection.call("getStationForecast", { stationIds: ids, hours: 72, days: 10, offset })).structuredContent as Record<string, unknown>;
    assert.equal(page["status"], "ok");
    seen.push(...(page["stations"] as { stationId: string }[]).map((s) => s.stationId));
    if (page["nextOffset"] === undefined) break;
    assert.equal(page["truncated"], true);
    offset = page["nextOffset"] as number;
  }
  assert.deepEqual(seen, ids, "every station asked for, over the pages, in order");
  const past = (await connection.call("getStationForecast", { stationIds: ids, offset: 4 })).structuredContent as Record<string, unknown>;
  assert.deepEqual((past["stations"] as { stationId: string }[]).map((s) => s.stationId), ["10513"]);
  await connection.close();
});
