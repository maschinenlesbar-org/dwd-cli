// The use cases of the skills against a mock of the API, with the skills' traps as cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DwdClient } from "../src/client.js";
import { DwdValidationError } from "../src/errors.js";
import { berlinTime, checkCrowdReports, containsPoint, dwdLevelOf, getStationForecast, getWarningAreas, getWarningBriefing, regionGeometry } from "../src/operations.js";
import type { JsonObject } from "../src/types.js";
import { BROCKEN, crowd, dwdApi, gemeinde, MIDNIGHT, station, MUNICH, NOW, report, REPORTS, square } from "./fixtures.js";

const HOUR = 3_600_000;
const client = (spec: Parameters<typeof dwdApi>[0] = {}) => {
  const api = dwdApi(spec);
  return { api, client: new DwdClient({ transport: api.transport }) };
};

// ---- the warning briefing ----------------------------------------------------------------

test("briefing: DWD's level is the feed's level minus 1, named, never the feed's number; ranked most severe first", async () => {
  const answer = await getWarningBriefing(client().client, { now: NOW });
  assert.equal(answer.status, "ok");
  const first = answer.warnings[0];
  assert.equal(first?.event, "ORKANARTIGE BÖEN");
  assert.equal(first?.dwdLevel, 3, "feed level 4 is DWD's Unwetterwarnung, level 3 of 4");
  assert.equal(first?.stage, "Unwetterwarnung (red)");
  assert.equal(answer.worstDwdLevel, 3);
  assert.match(answer.verdict, /^5 active DWD warning\(s\) in Germany, the worst DWD level 3 of 4, Unwetterwarnung \(red\); 1 advance information\.$/);
  assert.doesNotMatch(answer.verdict, /level 4/);
  const levels = answer.warnings.map((w) => w.feedLevel ?? 0);
  assert.deepEqual(levels, [...levels].sort((a, b) => b - a));
});

test("briefing: expired warnings are dropped, advance information is apart, identical warnings over several areas are one entry with a count", async () => {
  const answer = await getWarningBriefing(client().client, { feeds: ["gemeinde"], now: NOW });
  assert.ok(!answer.warnings.some((w) => w.event === "FROST"), "the frost warning ended an hour ago");
  assert.deepEqual(answer.advance.map((w) => w.event), ["DAUERREGEN"]);
  assert.ok(!answer.warnings.some((w) => w.event === "DAUERREGEN"));
  const sturm = answer.warnings.filter((w) => w.event === "STURMBÖEN");
  assert.equal(sturm.length, 1);
  assert.equal(sturm[0]?.count, 2);
  assert.equal(answer.byEvent["STURMBÖEN"], 1);
});

test("briefing: the nowcast's headLine (the product name NowCastMIX) is never a headline; its repeats are counted", async () => {
  const answer = await getWarningBriefing(client().client, { feeds: ["nowcast"], now: NOW });
  const [rain] = answer.warnings;
  assert.equal(rain?.event, "Starkregen");
  assert.equal(rain?.headline, undefined);
  assert.equal(rain?.count, 2);
  assert.doesNotMatch(JSON.stringify(answer), /NowCastMIX/);
});

test("briefing: a coast warning under several zones is one entry with its zone ids, no end invented; the lake warnings of the Gemeinde feed too", async () => {
  const answer = await getWarningBriefing(client().client, { feeds: ["coast", "gemeinde"], now: NOW });
  const coastal = answer.warnings.find((w) => w.feed === "coast");
  assert.deepEqual(coastal?.zones, ["501000001", "501000002"]);
  assert.equal(coastal?.end, undefined);
  assert.equal(coastal?.dwdLevel, 1);
  assert.equal(coastal?.headline, "Amtliche Warnung des Seewetterdienstes Hamburg vor BÖEN", "coast spells it headline");
  const lake = answer.warnings.find((w) => w.feed === "lakes");
  assert.deepEqual(lake?.zones, ["208438000", "208439000"]);
});

test("briefing: a warning that begins later is told apart from those in force now, in the entry, a count and the verdict", async () => {
  const feed = gemeinde();
  const later = { ...(feed["warnings"] as JsonObject[])[0], warnId: "gw-later", event: "FROST", level: 2, headLine: "Amtliche WARNUNG vor FROST", descriptionText: "Leichter Frost.", start: NOW + 5 * HOUR, end: NOW + 15 * HOUR };
  const answer = await getWarningBriefing(client({ gemeinde: { ...feed, warnings: [...(feed["warnings"] as JsonObject[]), later] } }).client, { feeds: ["gemeinde"], now: NOW });
  assert.equal(answer.startingLater, 1);
  assert.equal(answer.warnings.find((w) => w.event === "FROST")?.startsLater, true);
  assert.equal(answer.warnings.find((w) => w.event === "STURMBÖEN")?.startsLater, undefined);
  assert.match(answer.verdict, /^4 active DWD warning\(s\) in Germany \(1 of them begins later, not yet in force\), the worst DWD level 3 of 4/);
  const now = await getWarningBriefing(client().client, { feeds: ["gemeinde"], now: NOW });
  assert.equal(now.startingLater, undefined, "none begins later: no count");
});

test("briefing: the instruction only from DWD level 2 up, and never an empty one", async () => {
  const answer = await getWarningBriefing(client().client, { now: NOW });
  assert.equal(answer.warnings.find((w) => w.event === "ORKANARTIGE BÖEN")?.instruction, "Aufenthalt im Freien vermeiden");
  assert.equal(answer.warnings.find((w) => w.feed === "coast")?.instruction, undefined);
});

test("briefing in English: the level stated in the text wins", async () => {
  const answer = await getWarningBriefing(client().client, { feeds: ["gemeinde"], lang: "en", now: NOW });
  assert.equal(answer.warnings[0]?.dwdLevel, 2);
  assert.equal(dwdLevelOf({ level: 4, descriptionText: "… (level 1 of 4)." }), 1);
  assert.equal(dwdLevelOf({ level: 1 }), undefined, "a feed level of 1 is none of the four levels");
});

test("briefing: calm is empty with a plain reason; a stale feed is named instead of calling it calm", async () => {
  const calm = await getWarningBriefing(client({ nowcast: { time: NOW - 60_000, warnings: [], binnenSee: null } }).client, { feeds: ["nowcast"], now: NOW });
  assert.equal(calm.status, "empty");
  assert.equal(calm.reason, "No active DWD warnings in Germany right now.");
  const stale = await getWarningBriefing(client({ nowcast: { time: NOW - 3 * HOUR, warnings: [], binnenSee: null } }).client, { feeds: ["nowcast"], now: NOW });
  assert.equal(stale.status, "empty");
  assert.match(stale.reason ?? "", /the nowcast feed was published at .*over an hour ago/);
  assert.equal(stale.feeds[0]?.stale, true);
});

test("briefing at a point: only the warnings whose area contains it; coast and lake warnings, which have no area, apart in unlocated", async () => {
  const { api, client: c } = client();
  const answer = await getWarningBriefing(c, { lat: MUNICH[0], lon: MUNICH[1], now: NOW });
  assert.deepEqual(answer.searched.feeds, ["nowcast", "gemeinde", "coast"]);
  assert.ok(api.calls.some((r) => r.url.includes("coast")), "the coast feed is read: the point may be at sea");
  assert.deepEqual(answer.warnings.map((w) => w.event).sort(), ["STURMBÖEN", "Starkregen"]);
  assert.equal(answer.warnings.find((w) => w.event === "STURMBÖEN")?.count, 1, "the Berlin area is not here");
  assert.deepEqual(answer.unlocated?.map((w) => [w.feed, w.event]), [["lakes", "STURM"], ["coast", "BÖEN"]], "most severe first");
  assert.ok(answer.notes.some((n) => /2 coast or inland-lake warning\(s\) have no area/.test(n)));
  const brocken = await getWarningBriefing(client().client, { feeds: ["gemeinde"], lat: BROCKEN[0], lon: BROCKEN[1], now: NOW });
  assert.deepEqual(brocken.warnings.map((w) => w.event), ["ORKANARTIGE BÖEN"]);
});

test("briefing at sea: no area contains the point, but the coast warnings are there: never a flat 'no warnings'", async () => {
  const answer = await getWarningBriefing(client().client, { lat: 54.3, lon: 7.5, now: NOW });
  assert.equal(answer.status, "ok");
  assert.deepEqual(answer.warnings, []);
  assert.equal(answer.verdict, "No DWD warning area contains 54.3, 7.5, but 2 coast or inland-lake warning(s) are active, which have no area: if the point is at sea or on a lake, they may apply (unlocated, with their zone ids).");
  const coastOnly = await getWarningBriefing(client().client, { feeds: ["coast"], lat: 54.3, lon: 7.5, now: NOW });
  assert.equal(coastOnly.status, "ok");
  assert.deepEqual(coastOnly.unlocated?.map((w) => w.zones), [["501000001", "501000002"]]);
  const calm = await getWarningBriefing(client({ coast: { time: NOW - 60_000, warnings: {}, vorabInformation: {} }, gemeinde: { time: NOW - 60_000, warnings: [], binnenSee: {} } }).client, { lat: 54.3, lon: 7.5, now: NOW });
  assert.equal(calm.status, "empty");
  assert.equal(calm.verdict, "No active DWD warnings at 54.3, 7.5 right now.");
});

test("briefing at a point outside Germany and its coastal waters: said to be outside, no request made", async () => {
  const { api, client: c } = client();
  for (const [lat, lon] of [[90, 180], [40.4, -3.7], [59.3, 18.1]] as const) {
    const answer = await getWarningBriefing(c, { lat, lon, now: NOW });
    assert.equal(answer.status, "empty");
    assert.match(answer.verdict, new RegExp(`^${lat}, ${lon} lies outside the area DWD warns for \\(Germany and its coastal waters`));
  }
  assert.equal(api.calls.length, 0);
});

test("briefing: a point needs both coordinates; a bad feed or limit is refused before any request", async () => {
  const { api, client: c } = client();
  await assert.rejects(getWarningBriefing(c, { lat: 48 }), DwdValidationError);
  await assert.rejects(getWarningBriefing(c, { feeds: ["weather" as never] }), DwdValidationError);
  await assert.rejects(getWarningBriefing(c, { limit: 0 }), DwdValidationError);
  assert.equal(api.calls.length, 0);
});

// ---- warning areas -----------------------------------------------------------------------

test("areas: polygonGeometry as delivered, one feature per region, most severe first, expired ones left out", async () => {
  const answer = await getWarningAreas(client().client, { feeds: ["gemeinde"], now: NOW });
  assert.equal(answer.type, "FeatureCollection");
  assert.equal(answer.features[0]?.properties.event, "ORKANARTIGE BÖEN");
  assert.deepEqual(answer.features[0]?.geometry, square(...BROCKEN)["polygonGeometry"]);
  assert.equal(answer.features.filter((f) => f.properties.event === "STURMBÖEN").length, 2);
  assert.ok(!answer.features.some((f) => f.properties.event === "FROST"));
  assert.ok(answer.features.some((f) => f.properties.isVorabinfo), "advance information is tagged, not dropped");
});

test("areas: without polygonGeometry the flat polygon is used with each [lat, lon] pair swapped; triangles never; nothing usable is skipped and counted", async () => {
  const flat = square(...MUNICH);
  const { polygonGeometry: _g, ...onlyFlat } = flat;
  const feed = { time: NOW, warnings: [{ warnId: "x", level: 2, event: "FROST", start: NOW, end: NOW + HOUR, regions: [onlyFlat, { triangles: [0, 1, 2] }] }], binnenSee: null };
  const answer = await getWarningAreas(client({ gemeinde: feed }).client, { feeds: ["gemeinde"], now: NOW });
  assert.deepEqual(answer.features[0]?.geometry, flat["polygonGeometry"]);
  assert.equal(answer.skipped, 1);
  const geometry = regionGeometry({ polygon: [50, 8, 50, 9, 51, 9] });
  assert.deepEqual(geometry?.coordinates, [[[8, 50], [9, 50], [9, 51], [8, 50]]], "the ring is closed");
});

test("areas: nowcast features are labelled with their event; the coast feed can't be mapped; minDwdLevel filters", async () => {
  const answer = await getWarningAreas(client().client, { now: NOW });
  assert.equal(answer.features.find((f) => f.properties.feed === "nowcast")?.properties.headline, "Starkregen");
  await assert.rejects(getWarningAreas(client().client, { feeds: ["coast" as never] }), DwdValidationError);
  const severe = await getWarningAreas(client().client, { minDwdLevel: 3, now: NOW });
  assert.deepEqual(severe.features.map((f) => f.properties.event), ["ORKANARTIGE BÖEN"]);
  const none = await getWarningAreas(client({ nowcast: { time: NOW, warnings: [], binnenSee: null } }).client, { feeds: ["nowcast"], now: NOW });
  assert.equal(none.status, "empty");
  assert.match(none.reason ?? "", /No active warning areas to map/);
});

test("containsPoint: inside the outer ring and not in a hole", () => {
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
  assert.equal(containsPoint({ type: "Polygon", coordinates: [ring] }, [5, 5]), true);
  assert.equal(containsPoint({ type: "Polygon", coordinates: [ring, hole] }, [5, 5]), false);
  assert.equal(containsPoint({ type: "Polygon", coordinates: [ring, hole] }, [2, 8]), true, "[lat, lon] against [lon, lat] positions");
  assert.equal(containsPoint({ type: "MultiPolygon", coordinates: [[hole], [ring]] }, [2, 8]), true);
  assert.equal(containsPoint({ type: "Polygon", coordinates: [ring] }, [11, 5]), false);
});

// ---- the station forecast ----------------------------------------------------------------

test("forecast: the hours start at the current hour, not at midnight where the series start; real units", async () => {
  const answer = await getStationForecast(client().client, { stationIds: ["10865"], hours: 3, now: NOW });
  assert.equal(answer.status, "ok");
  const [s] = answer.stations;
  assert.deepEqual(s?.hours.map((h) => h.time), ["2026-11-19T15:00+01:00", "2026-11-19T16:00+01:00", "2026-11-19T17:00+01:00"]);
  assert.equal(s?.hours[1]?.temperature, 6.6, "(50 + 16) tenths: 6.6 °C");
  assert.equal(s?.hours[1]?.pressure, 1015);
});

test("forecast: fewer hours than asked for, because the hourly series ends at +72 h, are named in a note with where it ends", async () => {
  const answer = await getStationForecast(client().client, { stationIds: ["10865"], hours: 72, now: NOW });
  assert.equal(answer.stations[0]?.hours.length, 57);
  assert.deepEqual(answer.notes, ["Station 10865: 57 of the 72 hours asked for; its hourly series ends at 2026-11-21T23:00+01:00 (days covers the days after)."]);
  const fits = await getStationForecast(client().client, { stationIds: ["10865"], hours: 24, now: NOW });
  assert.deepEqual(fits.notes, []);
});

test("forecast: a station with no hours left, or no usable hourly series, is named in a note, never a silent empty hours list", async () => {
  const stale = station();
  ((stale["10865"] as JsonObject)["forecast1"] as JsonObject)["start"] = MIDNIGHT - 4 * 24 * HOUR;
  const old = await getStationForecast(client({ stations: stale }).client, { stationIds: ["10865"], now: NOW });
  assert.deepEqual(old.stations[0]?.hours, []);
  assert.deepEqual(old.notes, ["Station 10865: no hours left: its hourly series ended at 2026-11-17T23:00+01:00, before now; the forecast run (from 2026-11-15T00:00+01:00) looks stale."]);
  const odd = station();
  ((odd["10865"] as JsonObject)["forecast1"] as JsonObject)["start"] = String(MIDNIGHT);
  const strings = await getStationForecast(client({ stations: odd }).client, { stationIds: ["10865"], now: NOW });
  assert.deepEqual(strings.notes, ["Station 10865: no hourly forecast: its forecast1.start is missing or not a time."]);
});

test("forecast: the shorter series are end-aligned at +72 h, totals for the hour from the listed time", async () => {
  const [s] = (await getStationForecast(client().client, { stationIds: ["10865"], hours: 2, now: NOW })).stations;
  // sunshine has 57 values: the first is the hour 15:00-16:00 (30 minutes), not midnight.
  assert.equal(s?.hours[0]?.sunshine, 30);
  assert.equal(s?.hours[1]?.sunshine, 10);
  // precipitationTotal has 72: the hour 15:00-16:00 is element 15.
  assert.equal(s?.hours[0]?.precipitation, 1.5);
  // humidity has 57 values at their time: the first is 16:00; 15:00 has none.
  assert.equal(s?.hours[0]?.humidity, null);
  assert.equal(s?.hours[1]?.humidity, 90);
});

test("forecast: the missing-value marker is null, never 3276.7; a series the station lacks is named, never 0", async () => {
  const [s] = (await getStationForecast(client().client, { stationIds: ["10865"], hours: 1, now: NOW })).stations;
  assert.equal(s?.hours[0]?.temperature, null);
  assert.deepEqual(s?.notProvided, ["windSpeed", "windGust", "windDirection", "precipitationProbability"]);
  assert.equal("windSpeed" in (s?.hours[0] ?? {}), false);
});

test("forecast: a day's sunshine is summed from the series, never the API's daily 0; today counts only what's still to come", async () => {
  const [s] = (await getStationForecast(client().client, { stationIds: ["10865"], days: 4, now: NOW })).stations;
  assert.deepEqual(s?.days.map((d) => [d.date, d.sunshineMinutes, d.sunshinePartial]), [
    ["2026-11-19", 110, true],
    ["2026-11-20", 240, false],
    ["2026-11-21", 240, false],
    ["2026-11-22", 480, false],
  ]);
  assert.equal(s?.days[0]?.temperatureMax, 9);
  assert.equal(s?.days[0]?.windDirection, 234);
  assert.equal(s?.days[0]?.sunrise, "2026-11-19T07:30+01:00");
});

test("forecast: the station's own warnings with DWD's level, expired ones left out", async () => {
  const [s] = (await getStationForecast(client().client, { stationIds: ["10865"], now: NOW })).stations;
  assert.deepEqual(s?.warnings.map((w) => [w.event, w.dwdLevel]), [["STURMBÖEN", 2]]);
});

test("forecast: an unknown id is missing, not 'no weather'; all unknown is empty with what to do", async () => {
  const some = await getStationForecast(client().client, { stationIds: ["10865", "99999"], now: NOW });
  assert.equal(some.status, "ok");
  assert.deepEqual(some.missing, ["99999"]);
  const none = await getStationForecast(client().client, { stationIds: [" 99999 "], now: NOW });
  assert.equal(none.status, "empty");
  assert.deepEqual(none.missing, ["99999"]);
  assert.match(none.reason ?? "", /no data for station id 99999.*ask the user/);
  await assert.rejects(getStationForecast(client().client, { stationIds: ["1", "2", "3", "4", "5", "6"] }), DwdValidationError);
  await assert.rejects(getStationForecast(client().client, { stationIds: ["10865;x"] }), DwdValidationError);
});

// ---- crowd reports -----------------------------------------------------------------------

test("crowd: the window is the feed's start to end (12 h), not windowsSizeHours; 'right now' is the last hour before end", async () => {
  const answer = await checkCrowdReports(client().client, { now: NOW });
  assert.deepEqual(answer.window, { start: "2026-11-19T03:00+01:00", end: "2026-11-19T15:00+01:00", hours: 12 });
  assert.equal(answer.since, "2026-11-19T14:00+01:00");
  assert.equal(answer.matched, 7, "nine reports, cloud cover and one five hours old left out");
});

test("crowd: cloud cover is left out unless asked for", async () => {
  const answer = await checkCrowdReports(client().client, { place: "Mainz", now: NOW });
  assert.ok(!answer.byCategory.some((c) => c.category === "BEWOELKUNG"));
  const clouds = await checkCrowdReports(client().client, { place: "Mainz", categories: ["bewoelkung"], now: NOW });
  assert.deepEqual(clouds.byCategory.map((c) => c.category), ["BEWOELKUNG"]);
});

test("crowd: an exact place name wins over partial matches (Mainz, not Mainz-Kastel); counts per category with variants, photos, likes", async () => {
  const answer = await checkCrowdReports(client().client, { place: "mainz", now: NOW });
  assert.equal(answer.status, "ok");
  assert.equal(answer.matched, 3);
  assert.deepEqual(answer.places, [{ place: "Mainz", count: 3 }]);
  const hail = answer.byCategory.find((c) => c.category === "HAGEL");
  assert.deepEqual(hail, { category: "HAGEL", count: 1, variants: { HAGEL_2CM: 1 }, withPhoto: 1, maxLikes: 4 });
  const partial = await checkCrowdReports(client().client, { place: "Kastel", now: NOW });
  assert.deepEqual(partial.places, [{ place: "Mainz-Kastel", count: 1 }]);
});

test("crowd: a place spelled with ss for ß or ae/oe/ue for the umlaut is the same place, both ways", async () => {
  const spelled = [
    report({ place: "Meßstetten", category: "REGEN", variant: "REGEN_STARK", lat: 48.18, lon: 8.96, minutesAgo: 10 }),
    report({ place: "München", category: "REGEN", variant: "REGEN_STARK", lat: 48.14, lon: 11.58, minutesAgo: 10 }),
    report({ place: "Goessnitz", category: "REGEN", variant: "REGEN_STARK", lat: 50.89, lon: 12.43, minutesAgo: 10 }),
  ];
  const c = client({ crowd: crowd([...REPORTS, ...spelled]) }).client;
  for (const [asked, found] of [["Messstetten", "Meßstetten"], ["MESSSTETTEN", "Meßstetten"], ["Muenchen", "München"], ["Gößnitz", "Goessnitz"]]) {
    const answer = await checkCrowdReports(c, { place: asked as string, now: NOW });
    assert.equal(answer.status, "ok", asked);
    assert.deepEqual(answer.places, [{ place: found, count: 1 }], asked);
  }
});

test("crowd: a name matching places far apart is ambiguous, with the candidates, never one picked", async () => {
  const answer = await checkCrowdReports(client().client, { place: "Neustadt", now: NOW });
  assert.equal(answer.status, "ambiguous");
  assert.deepEqual(answer.candidates?.map((c) => c.place).sort(), ["Neustadt an der Weinstraße", "Neustadt in Holstein"]);
  assert.equal(answer.reports.length, 0);
});

test("crowd: nothing that points to one person: no exact position, time or photo link", async () => {
  const answer = await checkCrowdReports(client().client, { place: "Mainz", now: NOW });
  const json = JSON.stringify(answer);
  assert.doesNotMatch(json, /example\.test|49\.992|8\.247|meldungId|timestamp|blurHash/);
  const hail = answer.reports.find((r) => r.category === "HAGEL");
  assert.deepEqual(hail, { place: "Mainz", category: "HAGEL", variant: "HAGEL_2CM", hour: "14:00–15:00", likes: 4, photo: true, extras: ["HAGEL_GESCHLOSSENE_HAGELDECKE"], area: [50, 8.2] });
});

test("crowd: a category that isn't one is named as such, with the near ones, never answered as 'nobody reported it'", async () => {
  const snow = [
    report({ place: "Oberstdorf", category: "SCHNEEFALL", variant: "SCHNEEFALL_STARK", lat: 47.4, lon: 10.28, minutesAgo: 10 }),
    report({ place: "Garmisch", category: "SCHNEEDECKE", variant: "SCHNEEDECKE_BIS_10CM", lat: 47.5, lon: 11.1, minutesAgo: 20 }),
    report({ place: "Kempten", category: "GLAETTE", variant: "GLAETTE_GLATTEIS", lat: 47.72, lon: 10.31, minutesAgo: 30 }),
  ];
  const c = client({ crowd: crowd([...REPORTS, ...snow]) }).client;
  const unknown = await checkCrowdReports(c, { categories: ["Schnee"], now: NOW });
  assert.equal(unknown.status, "empty");
  assert.match(unknown.reason ?? "", /^SCHNEE is not a crowd report category \(did you mean SCHNEEFALL or SCHNEEDECKE\?\)\. The categories are .*SCHNEEFALL.*: ask again with one of them\.$/);
  assert.doesNotMatch(unknown.reason ?? "", /nobody reported/);
  const umlaut = await checkCrowdReports(c, { categories: ["glätte"], now: NOW });
  assert.equal(umlaut.status, "ok", "GLÄTTE is GLAETTE");
  assert.deepEqual(umlaut.searched.categories, ["GLAETTE"]);
  assert.equal(umlaut.matched, 1);
  const mixed = await checkCrowdReports(c, { categories: ["SCHNEEFALL", "SNOW"], now: NOW });
  assert.equal(mixed.status, "ok");
  assert.equal(mixed.matched, 1);
  assert.ok(mixed.notes.some((n) => /^SNOW is not a crowd report category; left out\./.test(n)), mixed.notes.join(" | "));
  const fresh = await checkCrowdReports(client({ crowd: crowd([report({ place: "Kiel", category: "TORNADO", variant: "TORNADO_JA", lat: 54.3, lon: 10.1, minutesAgo: 5 })]) }).client, { categories: ["tornado"], now: NOW });
  assert.equal(fresh.matched, 1, "a category the feed has is one, even if not yet known here");
});

test("crowd: near a point within a radius", async () => {
  const answer = await checkCrowdReports(client().client, { lat: 50.0, lon: 8.27, radiusKm: 5, now: NOW });
  assert.equal(answer.matched, 4);
  assert.deepEqual(answer.places.map((p) => p.place), ["Mainz", "Mainz-Kastel"]);
});

test("crowd: no matching report is empty with what was searched, and says that proves nothing", async () => {
  const answer = await checkCrowdReports(client().client, { place: "Mainz", categories: ["NEBEL"], now: NOW });
  assert.equal(answer.status, "empty");
  assert.match(answer.reason ?? "", /No crowd NEBEL reports matching "Mainz" in the last 60 minutes/);
});

test("crowd with official warnings: at the reports' mean position, from the nowcast and Gemeinde feeds", async () => {
  const near = [report({ place: "München", category: "REGEN", variant: "REGEN_EXTREM", lat: MUNICH[0], lon: MUNICH[1], minutesAgo: 5 })];
  const { api, client: c } = client({ crowd: crowd([...REPORTS, ...near]) });
  const answer = await checkCrowdReports(c, { place: "München", withWarnings: true, now: NOW });
  assert.deepEqual(answer.officialWarnings?.warnings.map((w) => w.event).sort(), ["STURMBÖEN", "Starkregen"]);
  assert.ok(answer.notes.some((n) => /mean position \(48\.1, 11\.6\)/.test(n)));
  assert.ok(!api.calls.some((r) => r.url.includes("coast")), "the coast feed has no areas: not read");
});

test("crowd with official warnings: one report's position never leaves rounded to less than 0.1 degrees, in the lookup or its verdict", async () => {
  const lone = { ...report({ place: "Kleinkleckersdorf", category: "REGEN", variant: "REGEN_STARK", lat: 50, lon: 9, minutesAgo: 5 }), lat: "50.12345", lon: "8.98765" };
  const answer = await checkCrowdReports(client({ crowd: crowd([lone]) }).client, { place: "Kleinkleckersdorf", withWarnings: true, now: NOW });
  assert.deepEqual([answer.officialWarnings?.searched.lat, answer.officialWarnings?.searched.lon], [50.1, 9]);
  assert.match(answer.officialWarnings?.verdict ?? "", /^No DWD warning area contains 50\.1, 9,/);
  assert.doesNotMatch(JSON.stringify(answer), /50\.12|8\.98|8\.99/);
});

test("crowd: a feed without end ends its window at the hour after the newest report, never at that report's minute", async () => {
  const { end: _end, ...open } = crowd([report({ place: "Mainz", category: "REGEN", variant: "REGEN_STARK", lat: 50, lon: 8.2, minutesAgo: 17 })]);
  const answer = await checkCrowdReports(client({ crowd: open }).client, { place: "Mainz", now: NOW });
  assert.equal(answer.matched, 1);
  assert.equal(answer.since, "2026-11-19T14:00+01:00", "the report came at 14:43; the window ends at 15:00");
  const none = await checkCrowdReports(client({ crowd: open }).client, { place: "Mainz", categories: ["HAGEL"], now: NOW });
  assert.match(none.reason ?? "", /\(to 2026-11-19T15:00\+01:00\)/);
});

test("berlinTime: local time with the offset of the day (CET, CEST)", () => {
  assert.equal(berlinTime(MIDNIGHT), "2026-11-19T00:00+01:00");
  assert.equal(berlinTime(Date.UTC(2026, 6, 1, 10, 0)), "2026-07-01T12:00+02:00");
});
