// Answers of the DWD API in the shapes recorded on 2026-11-19 (station overview 10865, the three
// warning feeds, the crowd feed), cut down and with known values, and a mock of the API over them:
// the operations' tests and the MCP server's tests use both. The warning texts are DWD's; the
// areas are small squares around known points; the crowd reports are made up (real ones point to
// people).

import type { HttpRequest, HttpResponse } from "../src/http.js";
import type { JsonObject } from "../src/types.js";
import { jsonResponse, makeMockTransport, type MockTransport } from "./helpers.js";

/** Midnight of 2026-11-19 in Germany (CET), where the station's series start. */
export const MIDNIGHT = Date.UTC(2026, 10, 18, 23, 0);
const HOUR = 3_600_000;
/** The clock of the tests: 2026-11-19 15:30 CET. */
export const NOW = MIDNIGHT + 15.5 * HOUR;

/** A square area around [lat, lon] as the feeds send it: polygonGeometry ([lon, lat]), the flat polygon ([lat, lon]) and triangles. */
export function square(lat: number, lon: number, half = 0.2): JsonObject {
  const ring = [
    [lon - half, lat - half],
    [lon + half, lat - half],
    [lon + half, lat + half],
    [lon - half, lat + half],
    [lon - half, lat - half],
  ];
  return {
    polygonGeometry: { type: "Polygon", coordinates: [ring] },
    triangles: [0, 1, 2, 2, 3, 0],
    polygon: ring.flatMap(([x, y]) => [y as number, x as number]),
  };
}

/** Points inside the squares below. */
export const MUNICH: [number, number] = [48.14, 11.58];
export const BROCKEN: [number, number] = [51.8, 10.62];
export const BERLIN: [number, number] = [52.52, 13.4];

const gemeindeItem = (extra: JsonObject): JsonObject => ({
  warnId: "2.49.0.0.276.0.DWD.PVW.1795097940000.a47028d2.MUL",
  type: 1,
  start: NOW - 2 * HOUR,
  end: NOW + 3 * HOUR,
  urls: [],
  isVorabinfo: false,
  bn: false,
  instruction: "",
  ...extra,
});

/** The Gemeinde feed: an Unwetter, a Sturmböen warning over two areas, an expired frost, an advance information, a lake warning under two lake ids. */
export function gemeinde(time = NOW - 10 * 60_000): JsonObject {
  return {
    time,
    warnings: [
      gemeindeItem({ warnId: "gw-sturm-1", level: 3, event: "STURMBÖEN", headLine: "Amtliche WARNUNG vor STURMBÖEN", descriptionText: "Es treten Sturmböen mit Geschwindigkeiten bis 70 km/h auf.", instruction: "frei stehende Objekte sichern", regions: [square(...MUNICH)] }),
      gemeindeItem({ warnId: "gw-orkan", level: 4, event: "ORKANARTIGE BÖEN", headLine: "Amtliche UNWETTERWARNUNG vor ORKANARTIGEN BÖEN", descriptionText: "Es treten oberhalb 1000 m orkanartige Böen bis 110 km/h auf.", instruction: "Aufenthalt im Freien vermeiden", regions: [square(...BROCKEN)] }),
      gemeindeItem({ warnId: "gw-sturm-2", level: 3, event: "STURMBÖEN", headLine: "Amtliche WARNUNG vor STURMBÖEN", descriptionText: "Es treten Sturmböen mit Geschwindigkeiten bis 70 km/h auf.", instruction: "frei stehende Objekte sichern", regions: [square(...BERLIN)] }),
      gemeindeItem({ warnId: "gw-frost", level: 2, event: "FROST", headLine: "Amtliche WARNUNG vor FROST", descriptionText: "Es tritt leichter Frost auf.", start: NOW - 12 * HOUR, end: NOW - HOUR, regions: [square(...BERLIN)] }),
      gemeindeItem({ warnId: "gw-vorab", level: 3, event: "DAUERREGEN", headLine: "Vorabinformation DAUERREGEN", descriptionText: "Ab morgen Dauerregen möglich.", isVorabinfo: true, start: NOW + 20 * HOUR, end: NOW + 40 * HOUR, regions: [square(...BERLIN)] }),
    ],
    binnenSee: {
      "208438000": [{ warnId: "lake-sturm", type: 1, level: 3, start: NOW - HOUR, event: "STURM", headline: "Amtliche WARNUNG vor STURM", descriptionText: "Sturmböen über 65 km/h.", instruction: "Ufer aufsuchen" }],
      "208439000": [{ warnId: "lake-sturm", type: 1, level: 3, start: NOW - HOUR, event: "STURM", headline: "Amtliche WARNUNG vor STURM", descriptionText: "Sturmböen über 65 km/h.", instruction: "Ufer aufsuchen" }],
    },
  };
}

/** The nowcast feed: one Starkregen warning sent twice (as NowCastMIX does), its headLine the product name. */
export function nowcast(time = NOW - 4 * 60_000): JsonObject {
  const item = { warnId: "2.49.0.1.276.DWD.AUTOWARN.1795099207001.1", type: 2, level: 3, start: NOW - 30 * 60_000, end: NOW + 2 * HOUR, states: [], urls: [], isVorabinfo: false, bn: false, event: "Starkregen", headLine: "NowCastMIX", descriptionText: "Automatisiert erstellter Hinweis auf Starkregen", regions: [square(...MUNICH, 0.1)] };
  return { time, warnings: [item, { ...item, warnId: "2.49.0.1.276.DWD.AUTOWARN.1795099207001.2" }], binnenSee: null };
}

/** The coast feed: one warning under two zones, no areas, no start or end. */
export function coast(time = NOW - 10 * 60_000): JsonObject {
  const item = { warnId: "coast-boeen", type: 1, level: 2, bn: false, event: "BÖEN", description: "Böen von 7 Beaufort aus Nordost bis Ost.", headline: "Amtliche Warnung des Seewetterdienstes Hamburg vor BÖEN", instruction: "", descriptionText: "Böen von 7 Beaufort aus Nordost bis Ost." };
  return { time, warnings: { "501000001": [item], "501000002": [item] }, vorabInformation: {} };
}

/** The English Gemeinde feed: the level stated in the text. */
export function gemeindeEn(time = NOW - 10 * 60_000): JsonObject {
  return {
    time,
    warnings: [gemeindeItem({ warnId: "gw-en", level: 3, event: "GALE-FORCE GUSTS", headLine: "Official WARNING of GALE-FORCE GUSTS", descriptionText: "There is a risk of gale-force gusts (level 2 of 4).", instruction: "Secure loose objects.", regions: [square(...MUNICH)] })],
    binnenSee: {},
  };
}

/**
 * Station 10865 as the overview sends it (scaled integers, tenths): `temperature` 241 values from
 * midnight (h → 50 + h, so 5.0 + h/10 °C), the missing-value marker at 15:00; the shorter arrays
 * end-aligned at +72 h: `precipitationTotal` 72 values (the hour ending at h+1 → h), `sunshine` 57
 * values (from the hour 15:00–16:00 on, which has 30 minutes, the others 10), `humidity` 57 values
 * (900); wind null, cloud cover empty. `forecast2` 3-hourly from +72 h with 60 minutes of sun per
 * period. `days` with the API's daily sunshine 0 (the trap).
 */
export function station(id = "10865"): JsonObject {
  const temperature = Array.from({ length: 241 }, (_, h) => (h === 15 ? 32767 : 50 + h));
  const sunshine = Array.from({ length: 57 }, (_, j) => (j === 0 ? 300 : 100));
  return {
    [id]: {
      forecast1: {
        stationId: id,
        start: MIDNIGHT,
        timeStep: HOUR,
        temperature,
        temperatureStd: Array.from({ length: 241 }, () => 0),
        windSpeed: null,
        windDirection: null,
        windGust: null,
        precipitationTotal: Array.from({ length: 72 }, (_, j) => j),
        sunshine,
        dewPoint2m: Array.from({ length: 57 }, () => 40),
        surfacePressure: Array.from({ length: 57 }, () => 10_150),
        humidity: Array.from({ length: 57 }, () => 900),
        isDay: Array.from({ length: 72 }, () => false),
        cloudCoverTotal: [],
        icon: Array.from({ length: 72 }, () => 4),
        precipitationProbablity: null,
        precipitationProbablityIndex: null,
      },
      forecast2: {
        stationId: id,
        start: MIDNIGHT + 72 * HOUR,
        timeStep: 3 * HOUR,
        temperature: [],
        precipitationTotal: Array.from({ length: 56 }, () => 0),
        sunshine: Array.from({ length: 56 }, () => 600),
        humidity: Array.from({ length: 56 }, () => 900),
      },
      forecastStart: null,
      days: Array.from({ length: 10 }, (_, d) => ({
        stationId: null,
        dayDate: new Date(Date.UTC(2026, 10, 19 + d)).toISOString().slice(0, 10),
        temperatureMin: 73 + d,
        temperatureMax: 90 + d,
        precipitation: 18,
        windSpeed: 167,
        windGust: 555,
        windDirection: 2340,
        sunshine: 0,
        sunrise: MIDNIGHT + d * 24 * HOUR + 7.5 * HOUR,
        sunset: MIDNIGHT + d * 24 * HOUR + 16.5 * HOUR,
        icon: 7,
      })),
      threeHourSummaries: null,
      warnings: [
        { warnId: "st-1", type: 1, level: 3, start: NOW - HOUR, end: NOW + 5 * HOUR, event: "STURMBÖEN", headline: "Amtliche WARNUNG vor STURMBÖEN", descriptionText: "Sturmböen bis 70 km/h." },
        { warnId: "st-old", type: 1, level: 2, start: NOW - 10 * HOUR, end: NOW - 2 * HOUR, event: "FROST", headline: "Amtliche WARNUNG vor FROST" },
      ],
    },
  };
}

/** A made-up crowd report in the feed's shape (lat/lon as strings). */
export function report(spec: { place: string; category: string; variant: string; lat: number; lon: number; minutesAgo: number; likes?: number; photo?: boolean }): JsonObject {
  return {
    meldungId: Math.round(spec.lat * 1000 + spec.lon),
    timestamp: CROWD_END - spec.minutesAgo * 60_000,
    lat: spec.lat.toFixed(3),
    lon: spec.lon.toFixed(3),
    place: spec.place,
    category: spec.category,
    auspraegung: spec.variant,
    zusatzAttribute: spec.category === "HAGEL" ? ["HAGEL_GESCHLOSSENE_HAGELDECKE"] : [],
    likeCount: spec.likes ?? 0,
    ...(spec.photo === true ? { imageUrl: "https://example.test/images/a.jpg", imageThumbUrl: "https://example.test/images/a_thumb.jpg", blurHash: "U9Awo1Dh8_xu" } : { blurHash: "LKO2?U%2Tw=w" }),
  };
}

/** The crowd feed's end: 15:00 CET. */
export const CROWD_END = MIDNIGHT + 15 * HOUR;

/** The crowd feed: 12 hours, `windowsSizeHours` 1 (it is not the window). */
export function crowd(reports: JsonObject[]): JsonObject {
  return {
    start: CROWD_END - 12 * HOUR,
    end: CROWD_END,
    windowsSizeHours: 1,
    highestSeverities: [{ category: "HAGEL", auspraegung: "HAGEL_2CM" }, { category: "REGEN", auspraegung: "REGEN_EXTREM" }],
    meldungen: reports,
  };
}

/** Reports around Mainz, a Neustadt in the Palatinate and one in Holstein, cloud cover in Mainz. */
export const REPORTS = [
  report({ place: "Mainz", category: "HAGEL", variant: "HAGEL_2CM", lat: 49.992, lon: 8.247, minutesAgo: 20, likes: 4, photo: true }),
  report({ place: "Mainz", category: "BLITZE", variant: "BLITZE_EXTREM", lat: 49.998, lon: 8.271, minutesAgo: 35, likes: 1 }),
  report({ place: "Mainz", category: "REGEN", variant: "REGEN_STARK", lat: 50.001, lon: 8.26, minutesAgo: 50 }),
  report({ place: "Mainz", category: "BEWOELKUNG", variant: "BEWOELKUNG_BEDECKT", lat: 49.99, lon: 8.25, minutesAgo: 10 }),
  report({ place: "Mainz", category: "REGEN", variant: "REGEN_LEICHT", lat: 49.99, lon: 8.25, minutesAgo: 300 }),
  report({ place: "Mainz-Kastel", category: "HAGEL", variant: "HAGEL_1CM", lat: 50.009, lon: 8.282, minutesAgo: 15 }),
  report({ place: "Wiesbaden", category: "REGEN", variant: "REGEN_STARK", lat: 50.082, lon: 8.24, minutesAgo: 25 }),
  report({ place: "Neustadt an der Weinstraße", category: "WIND", variant: "WIND_STARK", lat: 49.35, lon: 8.14, minutesAgo: 30 }),
  report({ place: "Neustadt in Holstein", category: "WIND", variant: "WIND_STURM", lat: 54.107, lon: 10.815, minutesAgo: 40 }),
];

/** A mock of the API: the station overview (keyed subset of `stations`), the three feeds in de and en, the crowd feed. Anything else is a 404. */
export function dwdApi(spec: { stations?: JsonObject; nowcast?: JsonObject; gemeinde?: JsonObject; gemeindeEn?: JsonObject; coast?: JsonObject; crowd?: JsonObject } = {}): MockTransport {
  return makeMockTransport((request: HttpRequest): HttpResponse => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.endsWith("/v30/stationOverviewExtended")) {
      const all = spec.stations ?? station();
      const ids = (url.searchParams.get("stationIds") ?? "").split(",");
      return jsonResponse(Object.fromEntries(ids.filter((id) => id in all).map((id) => [id, all[id]])));
    }
    const feed = path.match(/\/v16\/([a-z_0-9]+?)(_en)?\.json$/);
    const english = feed?.[2] !== undefined;
    switch (feed?.[1]) {
      case "warnings_nowcast":
        return jsonResponse(spec.nowcast ?? nowcast());
      case "gemeinde_warnings_v2":
        return jsonResponse(english ? (spec.gemeindeEn ?? gemeindeEn()) : (spec.gemeinde ?? gemeinde()));
      case "warnings_coast":
        return jsonResponse(spec.coast ?? coast());
      case "crowd_meldungen_overview_v2":
        return jsonResponse(spec.crowd ?? crowd(REPORTS));
      default:
        return jsonResponse({ message: "NoSuchKey" }, 404);
    }
  });
}
