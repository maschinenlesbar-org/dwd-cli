// The use cases of the skills as library functions, built on the resources: each composes the
// client's calls and carries the traps the skills document, so no caller (the CLI, the MCP
// server's use-case tools, a library user) has to know them.
// - getWarningBriefing: the official warnings of the three feeds, merged and ranked, with DWD's own
//   level (the feeds' `level` is DWD's level + 1), optionally at one point (the briefing skill);
// - getWarningAreas: the warning areas as GeoJSON features (the map skill);
// - getStationForecast: a station's forecast hour by hour and day by day, the short series
//   end-aligned, missing values as null, the day's sunshine summed from the series (the forecast
//   skill);
// - checkCrowdReports: the crowd reports near a place or point, by category, without what points
//   to one person (the crowd-check skill).
// No bare "not found": an empty answer says what was searched and why it is empty.

import { decodeStationOverview, missingStationIds, staleFeedProblem, type DwdClient } from "./client.js";
import { DwdError, DwdParseError, DwdValidationError } from "./errors.js";
import type { Lang } from "./enums.js";
import type { CoastWarningsFeed, CrowdOverview, JsonObject, JsonValue, StationOverview, WarningsFeed } from "./types.js";
import { assertLang, assertValid, normalizeStationIds, type Problem } from "./validate.js";

// ---- shared ---------------------------------------------------------------------------------

/** The warning feeds a briefing or a map reads. */
export const WARNING_FEEDS = ["nowcast", "gemeinde", "coast"] as const;
export type WarningFeedName = (typeof WARNING_FEEDS)[number];

/** DWD's four warning levels, by number (the feeds' `level` minus 1). */
export const DWD_LEVELS: Readonly<Record<number, string>> = Object.freeze({
  1: "Wetterwarnung (yellow)",
  2: "markante Wetterwarnung (orange)",
  3: "Unwetterwarnung (red)",
  4: "extreme Unwetterwarnung (purple)",
});

const BERLIN = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "longOffset",
});

/** `ms` (epoch milliseconds) as German local time with its offset: `2026-11-19T15:00+01:00`. */
export function berlinTime(ms: number): string {
  const parts: Record<string, string> = {};
  for (const part of BERLIN.formatToParts(new Date(ms))) parts[part.type] = part.value;
  const offset = (parts["timeZoneName"] ?? "GMT").replace("GMT", "") || "+00:00";
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}${offset}`;
}

/** The German local date of `ms`: `2026-11-19`. */
function berlinDate(ms: number): string {
  return berlinTime(ms).slice(0, 10);
}

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/** A problem for a number that must lie in [min, max]. */
const within = (min: number, max: number, whole = false): Problem<number> => (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!whole || Number.isInteger(value))
    ? undefined
    : `expected ${whole ? "a whole number" : "a number"} from ${min} to ${max}.`;

/** A point given as latitude and longitude, both or neither. */
function pointOf(input: { lat?: number | undefined; lon?: number | undefined }): [number, number] | undefined {
  if (input.lat === undefined && input.lon === undefined) return undefined;
  assertValid("lat", input.lat as number, within(-90, 90));
  assertValid("lon", input.lon as number, within(-180, 180));
  return [input.lat as number, input.lon as number];
}

/** The great-circle distance in km. */
export function distanceKm(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---- warning areas: geometry ---------------------------------------------------------------

/** A GeoJSON polygon or multipolygon. */
export interface AreaGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: JsonValue[];
}

/**
 * A region's geometry: its `polygonGeometry` as delivered (already GeoJSON, `[lon, lat]`), else one
 * ring built from the flat `polygon` array, which is `[lat, lon, lat, lon, …]` (the other order):
 * each pair swapped. `triangles` is a rendering index, never geometry. Undefined when neither is usable.
 */
export function regionGeometry(region: unknown): AreaGeometry | undefined {
  if (!isObject(region)) return undefined;
  const given = region["polygonGeometry"];
  if (isObject(given) && (given["type"] === "Polygon" || given["type"] === "MultiPolygon") && Array.isArray(given["coordinates"]) && given["coordinates"].length > 0) {
    return { type: given["type"], coordinates: given["coordinates"] };
  }
  const flat = region["polygon"];
  if (!Array.isArray(flat) || flat.length < 6 || flat.length % 2 !== 0 || !flat.every((v) => num(v) !== undefined)) return undefined;
  const ring: [number, number][] = [];
  for (let i = 0; i < flat.length; i += 2) ring.push([flat[i + 1] as number, flat[i] as number]);
  const first = ring[0] as [number, number];
  const last = ring[ring.length - 1] as [number, number];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return { type: "Polygon", coordinates: [ring] };
}

/** The rings of a geometry: a polygon's, or every polygon's of a multipolygon. */
const ringsOf = (geometry: AreaGeometry): JsonValue[][] =>
  (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates).flatMap((polygon) => (Array.isArray(polygon) ? polygon.filter((ring): ring is JsonValue[] => Array.isArray(ring)) : []));

/** How many positions a geometry has, over all its rings. */
export function positionCount(geometry: AreaGeometry): number {
  return ringsOf(geometry).reduce((sum, ring) => sum + ring.length, 0);
}

/**
 * `geometry` with at most about `maxPoints` positions: each ring keeps its share of them (at least
 * 4, a closed triangle), evenly spaced along it, its first position and the closing one kept. A
 * geometry within `maxPoints` comes back as it is. For a map of warning areas (an outline of
 * thousands of positions is over a result's size), not for exact borders.
 */
export function simplifyGeometry(geometry: AreaGeometry, maxPoints: number): AreaGeometry {
  const total = positionCount(geometry);
  if (total <= maxPoints) return geometry;
  const thin = (ring: JsonValue): JsonValue => {
    if (!Array.isArray(ring)) return ring;
    const keep = Math.max(4, Math.floor((maxPoints * ring.length) / total));
    if (ring.length <= keep) return ring;
    const step = (ring.length - 1) / (keep - 1);
    const out = Array.from({ length: keep - 1 }, (_, i) => ring[Math.round(i * step)] as JsonValue);
    out.push(ring[0] as JsonValue);
    return out;
  };
  const polygon = (rings: JsonValue): JsonValue => (Array.isArray(rings) ? rings.map(thin) : rings);
  return { type: geometry.type, coordinates: geometry.type === "Polygon" ? geometry.coordinates.map(thin) : geometry.coordinates.map(polygon) };
}

/** True when `[lat, lon]` lies inside the ring of `[lon, lat]` positions (ray casting). */
function inRing(point: [number, number], ring: JsonValue): boolean {
  if (!Array.isArray(ring)) return false;
  const [y, x] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!Array.isArray(a) || !Array.isArray(b)) continue;
    const [xi, yi] = [num(a[0]), num(a[1])];
    const [xj, yj] = [num(b[0]), num(b[1])];
    if (xi === undefined || yi === undefined || xj === undefined || yj === undefined) continue;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when `[lat, lon]` lies in the polygon (in its outer ring, not in a hole) or in one of the multipolygon's. */
export function containsPoint(geometry: AreaGeometry, point: [number, number]): boolean {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((polygon) => {
    if (!Array.isArray(polygon) || polygon.length === 0) return false;
    const [outer, ...holes] = polygon;
    return inRing(point, outer as JsonValue) && !holes.some((hole) => inRing(point, hole));
  });
}

// ---- the warning briefing ------------------------------------------------------------------

/**
 * DWD's own warning level (1–4) of a warning: the stage the English texts state ("(level 2 of 4)"),
 * else the feed's `level` minus 1 (checked live: `level` 2 is DWD level 1 of 4, Wetterwarnung).
 * Undefined for a `level` of 1 or lower: none of the four stages, a notice.
 */
export function dwdLevelOf(warning: JsonObject): number | undefined {
  for (const key of ["descriptionText", "description"]) {
    const stated = typeof warning[key] === "string" ? /\(level ([1-4]) of 4\)/i.exec(warning[key])?.[1] : undefined;
    if (stated !== undefined) return Number(stated);
  }
  const level = num(warning["level"]);
  if (level === undefined || level < 2) return undefined;
  return Math.min(4, Math.round(level) - 1);
}

/** The input of {@link getWarningBriefing}. */
export interface WarningBriefingInput {
  /** The feeds to read (default all three). */
  feeds?: readonly WarningFeedName[] | undefined;
  /** de (default) or en: in en the feeds translate event and texts, and state DWD's level. */
  lang?: Lang | undefined;
  /** Only the warnings whose area contains this point (nowcast and Gemeinde); coast and lake warnings have no area and come apart, in `unlocated`. */
  lat?: number | undefined;
  lon?: number | undefined;
  /** At most this many warnings listed, most severe first (1–100, default 25); the rest are counted. */
  limit?: number | undefined;
  /** The clock, epoch ms (default now). */
  now?: number | undefined;
}

/** One warning of a briefing; identical ones (same event, level, time and text) are one entry with a count. */
export interface BriefedWarning {
  feed: WarningFeedName | "lakes";
  event: string;
  /** DWD's level, 1 to 4; absent for a notice below the four levels. */
  dwdLevel?: number;
  /** The level's name (Wetterwarnung … extreme Unwetterwarnung), or "notice". */
  stage: string;
  /** The feed's own number (DWD's level + 1): for ranking, never to show as "level N". */
  feedLevel?: number;
  headline?: string;
  start?: string;
  end?: string;
  description?: string;
  /** The safety advice, for DWD level 2 and up. */
  instruction?: string;
  /** How many identical warnings this entry stands for (several areas, or a nowcast repeated). */
  count: number;
  /** Coastal zone or lake ids (coast and lake warnings have no area and no end). */
  zones?: string[];
  /** True when the warning begins after now: issued, not yet in force. */
  startsLater?: true;
}

/** A feed's age and whether it is stale, or that it could not be read (`unavailable`, `problem` says why). */
export interface FeedState {
  feed: WarningFeedName;
  /** When the feed was published; absent for a feed that could not be read. */
  published?: string;
  stale: boolean;
  /** True when the feed could not be read: its warnings are missing from the answer. */
  unavailable?: true;
  problem?: string;
}

/** The answer of {@link getWarningBriefing}. */
export interface WarningBriefing {
  status: "ok" | "empty";
  searched: { feeds: WarningFeedName[]; lang: Lang; lat?: number; lon?: number };
  /** One line: the count and the worst level, or why there is nothing. */
  verdict: string;
  /** Active warnings (identical ones counted once): in force now, or issued for later. */
  active: number;
  /** How many of them begin later (not yet in force); absent when none does. */
  startingLater?: number;
  /** The worst DWD level among them. */
  worstDwdLevel?: number;
  /** Active warnings per event. */
  byEvent: Record<string, number>;
  warnings: BriefedWarning[];
  /** Advance information (Vorabinformation): not yet a warning. */
  advance: BriefedWarning[];
  /** Entries left out past `limit`. */
  more?: number;
  /**
   * With a point: the active coast and inland-lake warnings, which have no area to test the point
   * against (their zone ids name the sea area or lake); they apply when the point is at sea or on a lake.
   */
  unlocated?: BriefedWarning[];
  feeds: FeedState[];
  reason?: string;
  notes: string[];
}

/** One warning item read from a feed. */
interface FeedItem {
  feed: WarningFeedName | "lakes";
  item: JsonObject;
  zone?: string;
}

/** The feed items of `feed`: a list (nowcast, Gemeinde), keyed by zone (coast), and the Gemeinde feed's inland lakes (`binnenSee`). */
function itemsOf(feed: WarningFeedName, body: WarningsFeed | CoastWarningsFeed): FeedItem[] {
  const out: FeedItem[] = [];
  const keyed = (value: unknown, name: WarningFeedName | "lakes"): void => {
    if (!isObject(value)) return;
    for (const [zone, list] of Object.entries(value)) {
      if (Array.isArray(list)) for (const item of list) if (isObject(item)) out.push({ feed: name, item, zone });
    }
  };
  if (Array.isArray(body.warnings)) {
    for (const item of body.warnings) if (isObject(item)) out.push({ feed, item });
  } else keyed(body.warnings, feed);
  if ("binnenSee" in body) keyed(body.binnenSee, "lakes");
  return out;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * How the items of a feed fit the shape the briefing and the map read: a numeric `level`, and for
 * nowcast and Gemeinde `regions`. The client checks the envelope; a field renamed or retyped inside
 * the items would otherwise read as calm. None of the items fitting is a DwdParseError (the feed
 * can't be read); some not fitting is a note.
 */
function itemShapeNote(feed: WarningFeedName, items: readonly FeedItem[]): string | undefined {
  const noLevel = items.filter(({ item }) => num(item["level"]) === undefined).length;
  const areal = items.filter(({ feed: from }) => from === "nowcast" || from === "gemeinde");
  const noRegions = areal.filter(({ item }) => !Array.isArray(item["regions"])).length;
  const unexpected = (count: number, what: string): DwdParseError =>
    new DwdParseError(`The ${feed} feed's warnings have an unexpected shape: none of its ${plural(count, "warning", "warnings")} has ${what}. The feed may have changed; its warnings can't be read.`);
  if (items.length > 0 && noLevel === items.length) throw unexpected(items.length, "a numeric level");
  if (areal.length > 0 && noRegions === areal.length) throw unexpected(areal.length, "regions (areas)");
  const parts = [
    ...(noLevel > 0 ? [`${noLevel} of the ${feed} feed's ${items.length} warnings ${noLevel === 1 ? "has" : "have"} no numeric level (listed as a notice)`] : []),
    ...(noRegions > 0 ? [`${noLevel > 0 ? `${noRegions}` : `${noRegions} of the ${feed} feed's ${areal.length} warnings`} ${noRegions === 1 ? "has" : "have"} no regions`] : []),
  ];
  return parts.length === 0 ? undefined : `${parts.join(" and ")}: the feed may have changed shape.`;
}

/** A feed read: its body and what its items didn't fit, or the error that kept it from being read. */
type FeedRead = { feed: WarningFeedName; body: WarningsFeed | CoastWarningsFeed; shape: string | undefined } | { feed: WarningFeedName; error: DwdError };

/**
 * Read the feeds in turn (the client checks `lang`), each with its items checked (itemShapeNote).
 * A feed that fails (HTTP, network, shape) doesn't take the others with it: it is returned as its
 * error, for the answer to name. When every feed fails, the first one's error is thrown.
 */
async function readFeeds(client: DwdClient, feeds: readonly WarningFeedName[], lang: Lang): Promise<FeedRead[]> {
  const out: FeedRead[] = [];
  for (const feed of feeds) {
    try {
      const body = await client.warnings[feed](lang);
      out.push({ feed, body, shape: itemShapeNote(feed, itemsOf(feed, body)) });
    } catch (err) {
      if (!(err instanceof DwdError) || err instanceof DwdValidationError) throw err;
      out.push({ feed, error: err });
    }
  }
  const failed = out.filter((read) => "error" in read);
  if (failed.length === out.length && failed[0] !== undefined && "error" in failed[0]) throw failed[0].error;
  return out;
}

/** The state of a feed read, and a note for a feed that could not be read. */
function stateOf(read: FeedRead, now: number, notes: string[]): FeedState {
  if ("error" in read) {
    notes.push(`The ${read.feed} feed could not be read (${read.error.message}): its warnings are missing from this answer.`);
    return { feed: read.feed, stale: false, unavailable: true, problem: read.error.message };
  }
  const problem = staleFeedProblem(read.body.time, now);
  if (read.shape !== undefined) notes.push(read.shape);
  return { feed: read.feed, published: berlinTime(read.body.time), stale: problem !== undefined, ...(problem === undefined ? {} : { problem }) };
}

/** The feeds asked for, in the canonical order, without repeats; one not `allowed` is a DwdValidationError. */
function feedList(feeds: readonly WarningFeedName[] | undefined, allowed: readonly WarningFeedName[] = WARNING_FEEDS): WarningFeedName[] {
  const problem: Problem<readonly WarningFeedName[]> = (value) =>
    Array.isArray(value) && value.length > 0 && value.every((f) => allowed.includes(f)) ? undefined : `expected one or more of ${allowed.join(", ")}.`;
  const given = assertValid("feeds", feeds ?? allowed, problem);
  return allowed.filter((f) => given.includes(f));
}

/** True when the item's end lies before `now` (an item without an end never expires here). */
const expired = (item: JsonObject, now: number): boolean => {
  const end = num(item["end"]);
  return end !== undefined && end < now;
};

/** True when one of the item's regions contains the point. */
const covers = (item: JsonObject, point: [number, number]): boolean =>
  Array.isArray(item["regions"]) && item["regions"].some((region) => {
    const geometry = regionGeometry(region);
    return geometry !== undefined && containsPoint(geometry, point);
  });

const FEED_RANK: Record<string, number> = { coast: 0, nowcast: 0, gemeinde: 1, lakes: 2 };

/**
 * The area DWD warns for, as a box: Germany (47.2–55.1° N, 5.8–15.1° E) and its coastal waters
 * (the German Bight and the western Baltic). A point outside it has no DWD warning, whatever the feeds say.
 */
export const DWD_WARNING_AREA = Object.freeze({ south: 47, north: 56, west: 3, east: 15.5 });

/**
 * The official warnings of the nowcast, Gemeinde and coast feeds in one ranked list: expired items
 * dropped, advance information (`isVorabinfo`) apart, identical warnings (same feed, event, level,
 * time and text: one warning over several areas, a nowcast repeated) one entry with a count and,
 * for coast and lake warnings, their zone ids. Ranked by DWD's level, then the soonest start,
 * coast and nowcast (short-fuse) before Gemeinde. Each states DWD's level (1–4) and its name, never
 * the feed's number as "level N". A stale feed (published more than an hour ago) is named, and an
 * empty answer with a stale feed says so instead of "calm". With a point, only the nowcast and
 * Gemeinde warnings whose area contains it; the coast and lake warnings, which have no area, come
 * apart in `unlocated` (they apply at sea or on the lake), so a point at sea never reads as calm
 * while a coast warning is out. A point outside {@link DWD_WARNING_AREA} is said to be outside,
 * without a request.
 */
export async function getWarningBriefing(client: DwdClient, input: WarningBriefingInput = {}): Promise<WarningBriefing> {
  const point = pointOf(input);
  const feeds = feedList(input.feeds);
  const lang = assertLang(input.lang ?? "de");
  const limit = assertValid("limit", input.limit ?? 25, within(1, 100, true));
  const now = input.now ?? Date.now();
  const searched = { feeds, lang, ...(point === undefined ? {} : { lat: point[0], lon: point[1] }) };
  const notes: string[] = [];
  const states: FeedState[] = [];
  const groups = new Map<string, { entry: BriefedWarning; advance: boolean; unlocated: boolean; rank: [number, number, number] }>();
  if (point !== undefined) {
    const box = DWD_WARNING_AREA;
    if (point[0] < box.south || point[0] > box.north || point[1] < box.west || point[1] > box.east) {
      const reason = `${point[0]}, ${point[1]} lies outside the area DWD warns for (Germany and its coastal waters, about ${box.south}–${box.north}° N, ${box.west}–${box.east}° E): DWD issues no warnings there; the national weather service of that place does.`;
      return { status: "empty", verdict: reason, reason, searched, active: 0, byEvent: {}, warnings: [], advance: [], feeds: [], notes };
    }
  }
  for (const read of await readFeeds(client, feeds, lang)) {
    states.push(stateOf(read, now, notes));
    if ("error" in read) continue;
    const { feed, body } = read;
    for (const { feed: from, item, zone } of itemsOf(feed, body)) {
      if (expired(item, now)) continue;
      // At a point, a warning without an area (coast, lakes, or one whose regions are missing) can't be tested against it: it goes apart.
      const unlocated = point !== undefined && (from === "coast" || from === "lakes" || !Array.isArray(item["regions"]));
      if (point !== undefined && !unlocated && !covers(item, point)) continue;
      const dwdLevel = dwdLevelOf(item);
      const event = text(item["event"]) ?? "(no event)";
      const start = num(item["start"]);
      const end = num(item["end"]);
      const description = text(item["descriptionText"]) ?? text(item["description"]);
      const advance = item["isVorabinfo"] === true;
      // Coast and lake warnings carry the same warnId under several zones.
      const key = zone !== undefined && text(item["warnId"]) !== undefined
        ? `${from}|${String(item["warnId"])}`
        : [from, event, item["level"], start, end, advance, description].join("|");
      const known = groups.get(key);
      if (known !== undefined) {
        if (zone !== undefined) known.entry.zones = [...(known.entry.zones ?? []), zone];
        else known.entry.count++;
        continue;
      }
      // Nowcast's headLine is only the product name (NowCastMIX); coast spells it headline.
      const headline = from === "nowcast" ? undefined : text(item["headLine"]) ?? text(item["headline"]);
      const instruction = dwdLevel !== undefined && dwdLevel >= 2 ? text(item["instruction"]) : undefined;
      const feedLevel = num(item["level"]);
      const entry: BriefedWarning = {
        feed: from,
        event,
        ...(dwdLevel === undefined ? {} : { dwdLevel }),
        stage: dwdLevel === undefined ? "notice" : (DWD_LEVELS[dwdLevel] as string),
        ...(feedLevel === undefined ? {} : { feedLevel }),
        ...(headline === undefined ? {} : { headline }),
        ...(start === undefined ? {} : { start: berlinTime(start) }),
        ...(end === undefined ? {} : { end: berlinTime(end) }),
        ...(description === undefined ? {} : { description }),
        ...(instruction === undefined ? {} : { instruction }),
        count: 1,
        ...(zone === undefined ? {} : { zones: [zone] }),
        ...(start !== undefined && start > now ? { startsLater: true as const } : {}),
      };
      groups.set(key, { entry, advance, unlocated, rank: [-(feedLevel ?? 0), start ?? now, FEED_RANK[from] ?? 3] });
    }
  }
  const ranked = [...groups.values()].sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]);
  const located = ranked.filter((g) => !g.unlocated);
  const unlocated = ranked.filter((g) => g.unlocated && !g.advance).map((g) => g.entry);
  const active = located.filter((g) => !g.advance).map((g) => g.entry);
  const advance = located.filter((g) => g.advance).map((g) => g.entry);
  const byEvent: Record<string, number> = {};
  for (const w of active) byEvent[w.event] = (byEvent[w.event] ?? 0) + 1;
  const levels = active.map((w) => w.dwdLevel ?? 0);
  const worst = levels.length === 0 ? 0 : Math.max(...levels);
  const stale = states.filter((s) => s.stale || s.unavailable === true);
  if (unlocated.length > 0) notes.push(`${unlocated.length} coast or inland-lake warning(s) (or warnings without regions) have no area to test the point against: they are in unlocated, with the zone ids of their sea area or lake, and apply if the point is at sea or on that lake.`);
  if (lang === "de") notes.push("DWD's level is the feed's level minus 1; the English feeds (lang en) state it in the text.");
  const where = point === undefined ? "in Germany" : `at ${point[0]}, ${point[1]}`;
  const staleText = stale
    .map((s) => (s.unavailable === true ? `the ${s.feed} feed could not be read, so its warnings are missing` : `the ${s.feed} feed was published at ${s.published}, over an hour ago, so newer warnings may be missing`))
    .join("; ");
  const shown = active.slice(0, limit);
  const shownAdvance = advance.slice(0, Math.max(0, limit - shown.length));
  const more = active.length + advance.length - shown.length - shownAdvance.length;
  const later = active.filter((w) => w.startsLater === true).length;
  const common = {
    searched,
    active: active.length,
    ...(later > 0 ? { startingLater: later } : {}),
    ...(worst > 0 ? { worstDwdLevel: worst } : {}),
    byEvent,
    warnings: shown,
    advance: shownAdvance,
    ...(more > 0 ? { more } : {}),
    ...(point === undefined ? {} : { unlocated }),
    feeds: states,
    notes,
  };
  if (active.length === 0 && advance.length === 0 && unlocated.length > 0) {
    const verdict = `No DWD warning area contains ${point?.[0]}, ${point?.[1]}, but ${unlocated.length} coast or inland-lake warning(s) are active, which have no area: if the point is at sea or on a lake, they may apply (unlocated, with their zone ids).${stale.length > 0 ? ` Note: ${staleText}.` : ""}`;
    return { status: "ok", verdict, ...common };
  }
  if (active.length === 0 && advance.length === 0) {
    const reason = stale.length > 0 ? `No active DWD warnings ${where} in the feeds read, but ${staleText}.` : `No active DWD warnings ${where} right now.`;
    return { status: "empty", verdict: reason, reason, ...common };
  }
  const verdict =
    (active.length === 0
      ? `No active DWD warnings ${where}; ${advance.length} advance information.`
      : `${active.length} active DWD warning(s) ${where}${later > 0 ? ` (${later} of them ${later === 1 ? "begins" : "begin"} later, not yet in force)` : ""}${worst > 0 ? `, the worst DWD level ${worst} of 4, ${DWD_LEVELS[worst]}` : ""}${advance.length > 0 ? `; ${advance.length} advance information` : ""}.`) +
    (stale.length > 0 ? ` Note: ${staleText}.` : "");
  return { status: "ok", verdict, ...common };
}

// ---- warning areas as GeoJSON --------------------------------------------------------------

/** The input of {@link getWarningAreas}. */
export interface WarningAreasInput {
  /** nowcast and/or gemeinde (default both); the coast feed has no areas. */
  feeds?: readonly ("nowcast" | "gemeinde")[] | undefined;
  lang?: Lang | undefined;
  /** Only warnings of at least this DWD level (1–4). */
  minDwdLevel?: number | undefined;
  /** An area outline with more positions than this (20–100000) is simplified to about this many (simplifyGeometry); default as delivered. */
  maxPoints?: number | undefined;
  /** The clock, epoch ms (default now). */
  now?: number | undefined;
}

/** One warning area as a GeoJSON feature. */
export interface WarningArea {
  type: "Feature";
  geometry: AreaGeometry;
  properties: {
    feed: "nowcast" | "gemeinde";
    warnId?: string;
    event: string;
    dwdLevel?: number;
    stage: string;
    headline?: string;
    description?: string;
    start?: string;
    end?: string;
    isVorabinfo: boolean;
    /** True when the outline was simplified (maxPoints): fine for a map, not for exact borders. */
    simplified?: true;
  };
}

/** The answer of {@link getWarningAreas}: a FeatureCollection, most severe first. */
export interface WarningAreas {
  status: "ok" | "empty";
  type: "FeatureCollection";
  searched: { feeds: ("nowcast" | "gemeinde")[]; lang: Lang; minDwdLevel?: number };
  features: WarningArea[];
  /** Regions without a usable geometry, and warnings without regions, left out. */
  skipped: number;
  feeds: FeedState[];
  reason?: string;
  /** What the feeds' items didn't fit (a field missing): only when there is something to say. */
  notes?: string[];
}

/**
 * The active warnings of the nowcast and Gemeinde feeds as GeoJSON features, one per region (a
 * warning over several areas is several features, never one merged shape), most severe first. The
 * geometry is the region's `polygonGeometry` as delivered (`[lon, lat]`), else built from the flat
 * `polygon` array with each `[lat, lon]` pair swapped; `triangles` is never used. A region with
 * neither is counted in `skipped`. Nowcast features are labelled with their event (its headLine is
 * only the product name). The coast feed has no areas and is not offered.
 */
export async function getWarningAreas(client: DwdClient, input: WarningAreasInput = {}): Promise<WarningAreas> {
  const feeds = feedList(input.feeds, ["nowcast", "gemeinde"]) as ("nowcast" | "gemeinde")[];
  const lang = assertLang(input.lang ?? "de");
  const minDwdLevel = input.minDwdLevel === undefined ? undefined : assertValid("minDwdLevel", input.minDwdLevel, within(1, 4, true));
  const maxPoints = input.maxPoints === undefined ? undefined : assertValid("maxPoints", input.maxPoints, within(20, 100_000, true));
  let simplified = 0;
  let largest = 0;
  const now = input.now ?? Date.now();
  const searched = { feeds, lang, ...(minDwdLevel === undefined ? {} : { minDwdLevel }) };
  const features: (WarningArea & { rank: number })[] = [];
  const states: FeedState[] = [];
  let skipped = 0;
  const notes: string[] = [];
  for (const read of await readFeeds(client, feeds, lang)) {
    states.push(stateOf(read, now, notes));
    if ("error" in read) continue;
    const { feed, body } = read;
    for (const { feed: from, item } of itemsOf(feed, body)) {
      if (from === "lakes" || expired(item, now)) continue;
      const dwdLevel = dwdLevelOf(item);
      if (minDwdLevel !== undefined && (dwdLevel ?? 0) < minDwdLevel) continue;
      if (!Array.isArray(item["regions"])) {
        skipped++;
        continue;
      }
      const event = text(item["event"]) ?? "(no event)";
      const headline = feed === "nowcast" ? event : text(item["headLine"]) ?? text(item["headline"]);
      const description = text(item["descriptionText"]) ?? text(item["description"]);
      const start = num(item["start"]);
      const end = num(item["end"]);
      const warnId = text(item["warnId"]);
      for (const region of Array.isArray(item["regions"]) ? item["regions"] : []) {
        const delivered = regionGeometry(region);
        if (delivered === undefined) {
          skipped++;
          continue;
        }
        const count = maxPoints === undefined ? 0 : positionCount(delivered);
        const thin = maxPoints !== undefined && count > maxPoints;
        if (thin) {
          simplified++;
          largest = Math.max(largest, count);
        }
        const geometry = thin ? simplifyGeometry(delivered, maxPoints) : delivered;
        features.push({
          type: "Feature",
          geometry,
          properties: {
            feed: feed as "nowcast" | "gemeinde",
            ...(warnId === undefined ? {} : { warnId }),
            event,
            ...(dwdLevel === undefined ? {} : { dwdLevel }),
            stage: dwdLevel === undefined ? "notice" : (DWD_LEVELS[dwdLevel] as string),
            ...(headline === undefined ? {} : { headline }),
            ...(description === undefined ? {} : { description }),
            ...(start === undefined ? {} : { start: berlinTime(start) }),
            ...(end === undefined ? {} : { end: berlinTime(end) }),
            isVorabinfo: item["isVorabinfo"] === true,
            ...(thin ? { simplified: true as const } : {}),
          },
          rank: dwdLevel ?? 0,
        });
      }
    }
  }
  const sorted = features.sort((a, b) => b.rank - a.rank).map(({ rank: _rank, ...feature }) => feature);
  if (simplified > 0) notes.push(`${plural(simplified, "area outline", "area outlines")} simplified to at most ${maxPoints} positions (from up to ${largest}): fine for a map, not for exact borders.`);
  const common = { type: "FeatureCollection" as const, searched, features: sorted, skipped, feeds: states, ...(notes.length === 0 ? {} : { notes }) };
  if (sorted.length === 0) {
    const stale = states.filter((s) => s.stale).map((s) => s.feed);
    const unread = states.filter((s) => s.unavailable === true).map((s) => s.feed);
    const reason = `No active warning areas to map${minDwdLevel === undefined ? "" : ` at DWD level ${minDwdLevel} or higher`}${stale.length > 0 ? `; the ${stale.join(" and ")} feed is over an hour old, so newer warnings may be missing` : ""}${unread.length > 0 ? `; the ${unread.join(" and ")} feed could not be read, so its warnings are missing` : ""}.`;
    return { status: "empty", reason, ...common };
  }
  return { status: "ok", ...common };
}

// ---- the station forecast ------------------------------------------------------------------

/** The hourly values a forecast lists, with their key in the API's `forecast1`. */
const HOURLY = {
  temperature: "temperature",
  precipitation: "precipitationTotal",
  sunshine: "sunshine",
  humidity: "humidity",
  dewPoint: "dewPoint2m",
  pressure: "surfacePressure",
  windSpeed: "windSpeed",
  windGust: "windGust",
  windDirection: "windDirection",
  precipitationProbability: "precipitationProbablity",
} as const;
type HourlyName = keyof typeof HOURLY;

/** Totals over the hour that starts at the listed time (the API stamps them at the hour's end). */
const HOUR_TOTALS: readonly HourlyName[] = ["precipitation", "sunshine"];

/** The units of the decoded values. */
export const FORECAST_UNITS = {
  temperature: "°C",
  precipitation: "mm in the hour",
  sunshine: "minutes of sun in the hour",
  humidity: "%",
  dewPoint: "°C",
  pressure: "hPa",
  windSpeed: "km/h",
  windGust: "km/h",
  windDirection: "degrees",
  precipitationProbability: "% (scale not confirmed)",
} as const;

/** The input of {@link getStationForecast}. */
export interface StationForecastInput {
  /** DWD station ids (5 characters, e.g. 10865 München-Stadt), 1 to 5. */
  stationIds: readonly string[];
  /** Hours listed from the current hour (1–72, default 24). */
  hours?: number | undefined;
  /** Days listed from today (1–10, default 4). */
  days?: number | undefined;
  /** The clock, epoch ms (default now). */
  now?: number | undefined;
}

/** One hour of a forecast: the values at that time, totals for the hour from it; null is no value. */
export type ForecastHour = { time: string } & Partial<Record<HourlyName, number | null>>;

/** One day of a forecast. */
export interface ForecastDay {
  date: string;
  temperatureMin?: number | null;
  temperatureMax?: number | null;
  /** mm over the day. */
  precipitation?: number | null;
  windSpeed?: number | null;
  windGust?: number | null;
  windDirection?: number | null;
  sunrise?: string;
  sunset?: string;
  /** Minutes of sun, summed from the hourly and 3-hourly series (never the API's daily value, often 0 on sunny days). */
  sunshineMinutes?: number;
  /** True when the series cover only part of the day (today: the sun still to come; the last days). */
  sunshinePartial?: boolean;
}

/** One station's forecast. */
export interface StationForecast {
  stationId: string;
  hours: ForecastHour[];
  days: ForecastDay[];
  /** Hourly values the station's forecast doesn't provide (the series is null or empty). */
  notProvided: string[];
  /** The warnings for the station's location, with DWD's level. */
  warnings: { event: string; dwdLevel?: number; stage: string; headline?: string; start?: string; end?: string; description?: string }[];
}

/** The answer of {@link getStationForecast}. */
export interface StationForecasts {
  status: "ok" | "empty";
  searched: { stationIds: string[] };
  units: typeof FORECAST_UNITS;
  stations: StationForecast[];
  /** Ids the API has no data for (it answers an unknown id with nothing, not an error). */
  missing: string[];
  reason?: string;
  /** What the answer leaves out and why (fewer hours than asked for). */
  notes: string[];
}

const series = (block: JsonValue | undefined, key: string): (number | null)[] | undefined => {
  if (!isObject(block)) return undefined;
  const value = block[key];
  return Array.isArray(value) && value.length > 0 ? value.map((v) => (typeof v === "number" ? v : null)) : undefined;
};

/** A value rounded to one decimal (decoding divides by 10: 9.700000000000001). */
const round1 = (value: number | null | undefined): number | null => (typeof value === "number" ? Math.round(value * 10) / 10 : null);

/**
 * One station's forecast from its decoded overview. In `forecast1` only `temperature` (and
 * `temperatureStd`) starts at `start`; every shorter array is end-aligned: its last element belongs
 * to `start` + 72 h, so in an array of length n element j belongs to `start + (73 − n + j)` h —
 * values at that time, totals (precipitation, sunshine) for the hour ending then. `forecast2`
 * continues 3-hourly from `start` + 72 h, element j for the 3 h ending at `start + (j+1)·timeStep`.
 */
function forecastOf(stationId: string, station: JsonObject, now: number, hours: number, days: number, notes: string[]): StationForecast {
  const f1 = station["forecast1"];
  const f2 = station["forecast2"];
  const start = isObject(f1) ? num(f1["start"]) : undefined;
  const step = (isObject(f1) ? num(f1["timeStep"]) : undefined) ?? 3_600_000;
  const notProvided = (Object.keys(HOURLY) as HourlyName[]).filter((name) => series(f1, HOURLY[name]) === undefined);
  const out: ForecastHour[] = [];
  if (start !== undefined) {
    /** The element of `name` stamped `start + h` hours, or null. */
    const at = (name: HourlyName, h: number): number | null => {
      const values = series(f1, HOURLY[name]);
      if (values === undefined) return null;
      const j = name === "temperature" ? h : h - 73 + values.length;
      return j >= 0 && j < values.length ? round1(values[j]) : null;
    };
    const first = Math.max(0, Math.floor((now - start) / step));
    for (let h = first; h < Math.min(first + hours, 72); h++) {
      const hour: ForecastHour = { time: berlinTime(start + h * step) };
      for (const name of Object.keys(HOURLY) as HourlyName[]) {
        if (notProvided.includes(name)) continue;
        hour[name] = at(name, HOUR_TOTALS.includes(name) ? h + 1 : h);
      }
      out.push(hour);
    }
    // The hourly series ends at +72 h; later in the day fewer hours are left than were asked for.
    if (out.length > 0 && out.length < hours) {
      notes.push(`Station ${stationId}: ${out.length} of the ${hours} hours asked for; its hourly series ends at ${berlinTime(start + 71 * step)} (days covers the days after).`);
    } else if (out.length === 0) {
      notes.push(`Station ${stationId}: no hours left: its hourly series ended at ${berlinTime(start + 71 * step)}, before now; the forecast run (from ${berlinTime(start)}) looks stale.`);
    }
  } else {
    notes.push(`Station ${stationId}: no hourly forecast: its forecast1.start is missing or not a time.`);
  }
  // Sunshine per local day, from the hourly and the 3-hourly series (each value at its period's end).
  const sun = new Map<string, { minutes: number; hours: number }>();
  const addSun = (block: JsonValue | undefined, endOf: (j: number, n: number) => number | undefined, spanHours: number): void => {
    const values = series(block, "sunshine");
    if (values === undefined) return;
    values.forEach((value, j) => {
      const end = endOf(j, values.length);
      if (value === null || end === undefined) return;
      const day = berlinDate(end - 1);
      const sum = sun.get(day) ?? { minutes: 0, hours: 0 };
      sum.minutes += value;
      sum.hours += spanHours;
      sun.set(day, sum);
    });
  };
  if (start !== undefined) addSun(f1, (j, n) => start + (73 - n + j) * step, step / 3_600_000);
  const start2 = isObject(f2) ? num(f2["start"]) : undefined;
  const step2 = (isObject(f2) ? num(f2["timeStep"]) : undefined) ?? 10_800_000;
  if (start2 !== undefined) addSun(f2, (j) => start2 + (j + 1) * step2, step2 / 3_600_000);
  const today = berlinDate(now);
  const dayList: ForecastDay[] = [];
  for (const day of Array.isArray(station["days"]) ? station["days"] : []) {
    if (!isObject(day)) continue;
    const date = text(day["dayDate"]);
    if (date === undefined || date < today) continue;
    if (dayList.length >= days) break;
    const value = (key: string): number | null => round1(num(day[key]) ?? null);
    const sunrise = num(day["sunrise"]);
    const sunset = num(day["sunset"]);
    const sum = sun.get(date);
    dayList.push({
      date,
      temperatureMin: value("temperatureMin"),
      temperatureMax: value("temperatureMax"),
      precipitation: value("precipitation"),
      windSpeed: value("windSpeed"),
      windGust: value("windGust"),
      windDirection: value("windDirection"),
      ...(sunrise === undefined ? {} : { sunrise: berlinTime(sunrise) }),
      ...(sunset === undefined ? {} : { sunset: berlinTime(sunset) }),
      ...(sum === undefined ? {} : { sunshineMinutes: Math.round(sum.minutes), sunshinePartial: sum.hours < 24 }),
    });
  }
  const warnings = (Array.isArray(station["warnings"]) ? station["warnings"] : []).filter(isObject).filter((w) => !expired(w, now)).map((w) => {
    const dwdLevel = dwdLevelOf(w);
    const ws = num(w["start"]);
    const we = num(w["end"]);
    const headline = text(w["headline"]) ?? text(w["headLine"]);
    const description = text(w["descriptionText"]) ?? text(w["description"]);
    return {
      event: text(w["event"]) ?? "(no event)",
      ...(dwdLevel === undefined ? {} : { dwdLevel }),
      stage: dwdLevel === undefined ? "notice" : (DWD_LEVELS[dwdLevel] as string),
      ...(headline === undefined ? {} : { headline }),
      ...(ws === undefined ? {} : { start: berlinTime(ws) }),
      ...(we === undefined ? {} : { end: berlinTime(we) }),
      ...(description === undefined ? {} : { description }),
    };
  });
  return { stationId, hours: out, days: dayList, notProvided, warnings };
}

/**
 * The forecast of one or more DWD stations in real units (°C, mm, %, hPa, km/h, minutes of sun):
 * the next `hours` from the current hour, not from midnight (where the API's series start), each
 * value at its own hour (the short series are end-aligned), totals for the hour from the listed
 * time; then `days` from today with min/max, rain, wind, sunrise/sunset and the day's sunshine
 * summed from the series, since the API's daily `sunshine` is often 0 on sunny days. A value the
 * API marks missing (32767) is null, never 0 or 3276.7; a series the station lacks is named in
 * `notProvided`. An unknown id is in `missing` (the API answers it with nothing, not an error).
 * The stations come in the order asked, each once.
 */
export async function getStationForecast(client: DwdClient, input: StationForecastInput): Promise<StationForecasts> {
  const ids = assertValid("stationIds", input.stationIds, (value) => (Array.isArray(value) && value.length >= 1 && value.length <= 5 ? undefined : "expected 1 to 5 station ids."));
  const hours = assertValid("hours", input.hours ?? 24, within(1, 72, true));
  const days = assertValid("days", input.days ?? 4, within(1, 10, true));
  const now = input.now ?? Date.now();
  const overview: StationOverview = await client.weather.stationOverview([...ids]);
  const missing = missingStationIds(ids, overview);
  const decoded = decodeStationOverview(overview);
  const notes: string[] = [];
  // In the order asked (the answer's keys come in the ids' numeric order), each id once.
  const asked = [...new Set(normalizeStationIds(ids).map(String))];
  const stations = asked
    .filter((id) => isObject(decoded[id]) && !missing.includes(id))
    .map((id) => forecastOf(id, decoded[id] as JsonObject, now, hours, days, notes));
  const searched = { stationIds: ids.map((id) => id.trim()) };
  if (stations.length === 0) {
    return {
      status: "empty",
      searched,
      units: FORECAST_UNITS,
      stations,
      missing,
      notes,
      reason: `The API has no data for station id ${missing.join(", ")}: it answers an unknown id with nothing. Station ids are DWD's 5-character ids (10865 München-Stadt, 10147 Hamburg); ask the user for the id or the nearest known station.`,
    };
  }
  return { status: "ok", searched, units: FORECAST_UNITS, stations, missing, notes };
}

// ---- crowd reports -------------------------------------------------------------------------

/** Crowd report categories seen in the feed (others may come: a category the feed has is one too); BEWOELKUNG, cloud cover, is the feed's noise. */
export const CROWD_CATEGORIES = ["REGEN", "GEWITTER", "BLITZE", "HAGEL", "WIND", "NEBEL", "GLAETTE", "SCHNEEFALL", "SCHNEEDECKE", "BEWOELKUNG"] as const;

/** A category as the feed spells it: trimmed, upper case, ß and the umlauts spelled out (GLÄTTE is GLAETTE). */
const categoryOf = (value: string): string => value.trim().normalize("NFC").toLocaleUpperCase("de").replace(/[ẞÄÖÜ]/g, (c) => ({ ẞ: "SS", Ä: "AE", Ö: "OE", Ü: "UE" })[c] ?? c);

/** `items` as "A", "A or B", "A, B or C". */
const orList = (items: readonly string[]): string => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`);

/** The categories near `name` (one contains the other): SCHNEE is near SCHNEEFALL and SCHNEEDECKE. */
const nearCategories = (name: string, known: readonly string[]): string[] => (name.length < 3 ? [] : known.filter((k) => k.includes(name) || name.includes(k)));

/** The input of {@link checkCrowdReports}. */
export interface CrowdCheckInput {
  /** A place name, or part of it (`Mainz`, `Lauingen`): an exact name wins over partial matches; case, ß/ss and the umlauts spelled out (Muenchen) don't matter. */
  place?: string | undefined;
  /** A point, with radiusKm: the reports within that distance. */
  lat?: number | undefined;
  lon?: number | undefined;
  /** 1–200 km, default 25. */
  radiusKm?: number | undefined;
  /** Only these categories, e.g. HAGEL, BLITZE (default every category but BEWOELKUNG, cloud cover, the feed's noise); case and umlauts don't matter (Glätte is GLAETTE). One that is neither in CROWD_CATEGORIES nor in the feed is named in the reason or a note, never answered as "nobody reported it". */
  categories?: readonly string[] | undefined;
  /** Reports from the last this many minutes before the feed's end (5–1440, default 60). */
  sinceMinutes?: number | undefined;
  /** Also the official warnings at the point (given, or the matching reports' mean position, rounded to 0.1°). */
  withWarnings?: boolean | undefined;
  /** The clock, epoch ms (default now), for the warnings' expiry and the feeds' age. */
  now?: number | undefined;
}

/** One crowd report, without what points to one person. */
export interface CrowdReport {
  place: string;
  category: string;
  variant: string;
  /** The hour it falls in, local time (`15:00–16:00`), never the exact time. */
  hour: string;
  likes: number;
  photo: boolean;
  extras?: string[];
  /** The position rounded to 0.1° (about 10 km), never the exact one. */
  area?: [number, number];
}

/** The answer of {@link checkCrowdReports}. */
export interface CrowdCheck {
  status: "ok" | "empty" | "ambiguous";
  searched: { place?: string; lat?: number; lon?: number; radiusKm?: number; categories: string[] | "all but BEWOELKUNG"; sinceMinutes: number };
  /** The span the feed covers (its start and end; `windowsSizeHours` is not its length). */
  window?: { start: string; end: string; hours: number };
  /** The span the reports were filtered to. */
  since?: string;
  matched: number;
  byCategory: { category: string; count: number; variants: Record<string, number>; withPhoto: number; maxLikes: number }[];
  /** Places with matching reports, the most first (at most 10). */
  places: { place: string; count: number }[];
  /** The matching reports, the most liked first (at most 30). */
  reports: CrowdReport[];
  /** The worst variant per category over the whole window, as the feed states it. */
  highestSeverities?: JsonValue;
  /** With withWarnings: the official warnings at the point, for the cross-check. */
  officialWarnings?: WarningBriefing;
  /** With an ambiguous place: the places it matches, far apart. */
  candidates?: { place: string; count: number; area: [number, number] }[];
  reason?: string;
  notes: string[];
}

/** German transliterations: a name typed without ß or umlauts (Messstetten, Muenchen) is the same name. */
const SPELLED_OUT: Readonly<Record<string, string>> = { ß: "ss", ä: "ae", ö: "oe", ü: "ue" };
/** A place name as compared: NFC, trimmed, lower case, ß and the umlauts spelled out. */
const fold = (value: string): string => value.normalize("NFC").trim().toLocaleLowerCase("de").replace(/[ßäöü]/g, (c) => SPELLED_OUT[c] ?? c);
const positionOf = (report: JsonObject): [number, number] | undefined => {
  const lat = Number(report["lat"]);
  const lon = Number(report["lon"]);
  return typeof report["lat"] === "string" || typeof report["lat"] === "number" ? (Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : undefined) : undefined;
};
const round01 = (value: number): number => Math.round(value * 10) / 10;
const hasPhoto = (report: JsonObject): boolean => ["imageUrl", "imageMediumUrl", "imageThumbUrl"].some((key) => text(report[key]) !== undefined);

/** Places matching `place` that lie this far apart are different places of one name. */
const SAME_PLACE_KM = 50;

/**
 * What crowd reports (unverified user submissions of the DWD WarnWetter app) say near a place or a
 * point: the reports of the last `sinceMinutes` before the feed's end (its `windowsSizeHours` is not
 * the window: the feed spans about 12 hours), counted per category with their variants, photos and
 * likes. Cloud cover (BEWOELKUNG) is left out unless asked for. An exact place name wins over
 * partial matches; partial matches far apart (two towns of one name) are `ambiguous`, with the
 * candidates. Exact positions, exact times and photo links are left out: positions rounded to 0.1°,
 * times to the hour. With `withWarnings`, the official warnings at the point (given, or the
 * reports' mean position) for the cross-check.
 */
export async function checkCrowdReports(client: DwdClient, input: CrowdCheckInput = {}): Promise<CrowdCheck> {
  const point = pointOf(input);
  const place = input.place === undefined ? undefined : assertValid("place", input.place, (v) => (typeof v === "string" && v.trim() !== "" && v.length <= 100 ? undefined : "expected a place name of 1 to 100 characters."));
  const radiusKm = assertValid("radiusKm", input.radiusKm ?? 25, within(1, 200));
  const categories = input.categories === undefined
    ? undefined
    : assertValid("categories", input.categories, (v) => (Array.isArray(v) && v.length > 0 && v.every((c) => typeof c === "string" && c.trim() !== "") ? undefined : "expected one or more categories."))
        .map(categoryOf);
  const sinceMinutes = assertValid("sinceMinutes", input.sinceMinutes ?? 60, within(5, 1440, true));
  const now = input.now ?? Date.now();
  const searched = {
    ...(place === undefined ? {} : { place: place.trim() }),
    ...(point === undefined ? {} : { lat: point[0], lon: point[1], radiusKm }),
    categories: categories ?? ("all but BEWOELKUNG" as const),
    sinceMinutes,
  };
  const wanted = (category: unknown): boolean => (categories === undefined ? category !== "BEWOELKUNG" : categories.includes(String(category)));
  const notes = ["Crowd reports are unverified user submissions: corroboration, not authority; the official warnings are the authority."];
  const feed: CrowdOverview = await client.crowd();
  const reports = feed.meldungen.filter(isObject);
  const times = reports.map((r) => num(r["timestamp"])).filter((t): t is number => t !== undefined);
  // The client checks the envelope; a timestamp renamed or retyped would read as nobody reporting.
  if (reports.length > 0 && times.length === 0) {
    throw new DwdParseError(`The crowd feed's reports have an unexpected shape: none of its ${plural(reports.length, "report", "reports")} has a numeric timestamp. The feed may have changed; its reports can't be read.`);
  }
  if (times.length < reports.length) notes.push(`${reports.length - times.length} of the feed's ${reports.length} reports ${reports.length - times.length === 1 ? "has" : "have"} no numeric timestamp: left out; the feed may have changed shape.`);
  // Without the feed's end, the window ends at the hour after the newest report: never that report's minute.
  const end = num(feed.end) ?? (times.length > 0 ? Math.ceil(Math.max(...times) / 3_600_000) * 3_600_000 : now);
  const start = num(feed.start);
  const since = end - sinceMinutes * 60_000;
  const window = start === undefined ? undefined : { start: berlinTime(start), end: berlinTime(end), hours: Math.round(((end - start) / 3_600_000) * 10) / 10 };
  if (start !== undefined && since < start) notes.push(`The feed covers only ${window?.hours} hours; sinceMinutes reaches past its start.`);
  let selected = reports.filter((r) => (num(r["timestamp"]) ?? -Infinity) >= since && wanted(r["category"]));
  const base = {
    searched,
    ...(window === undefined ? {} : { window }),
    since: berlinTime(since),
    ...(feed.highestSeverities === undefined ? {} : { highestSeverities: feed.highestSeverities }),
    notes,
  };
  const empty = { matched: 0, byCategory: [], places: [], reports: [] };
  // A category is one DWD's app knows or one the feed has; any other matches nothing, which is not
  // "nobody reported it": say so, with the near ones.
  const known = [...new Set([...CROWD_CATEGORIES, ...reports.map((r) => r["category"]).filter((c): c is string => typeof c === "string")])];
  const unknown = (categories ?? []).filter((c) => !known.includes(c));
  const unknownText = unknown.map((c) => {
    const near = nearCategories(c, known);
    return `${c} is not a crowd report category${near.length === 0 ? "" : ` (did you mean ${orList(near)}?)`}`;
  });
  if (categories !== undefined && unknown.length === categories.length) {
    return { status: "empty", ...base, ...empty, reason: `${unknownText.join("; ")}. The categories are ${known.join(", ")}: ask again with one of them.` };
  }
  for (const line of unknownText) notes.push(`${line}; left out.`);
  if (place !== undefined) {
    const name = fold(place);
    const exact = selected.filter((r) => typeof r["place"] === "string" && fold(r["place"]) === name);
    // An exact name anywhere in the window (any category) settles which place is meant.
    const exactAnywhere = reports.some((r) => typeof r["place"] === "string" && fold(r["place"]) === name);
    selected = exactAnywhere ? exact : selected.filter((r) => typeof r["place"] === "string" && fold(r["place"]).includes(name));
    if (!exactAnywhere) {
      const names = new Map<string, { count: number; positions: [number, number][] }>();
      for (const r of selected) {
        const entry = names.get(String(r["place"])) ?? { count: 0, positions: [] };
        entry.count++;
        const p = positionOf(r);
        if (p !== undefined) entry.positions.push(p);
        names.set(String(r["place"]), entry);
      }
      const centres = [...names].map(([name, e]) => ({ place: name, count: e.count, area: mean(e.positions) }));
      const spread = centres.some((a) => centres.some((b) => a.area !== undefined && b.area !== undefined && distanceKm(a.area, b.area) > SAME_PLACE_KM));
      if (spread) {
        return {
          status: "ambiguous",
          ...base,
          ...empty,
          candidates: centres.filter((c) => c.area !== undefined).map((c) => ({ place: c.place, count: c.count, area: [round01((c.area as [number, number])[0]), round01((c.area as [number, number])[1])] as [number, number] })),
          reason: `"${place.trim()}" matches places more than ${SAME_PLACE_KM} km apart; ask which one, then give its full name or lat/lon.`,
        };
      }
    }
  }
  if (point !== undefined) selected = selected.filter((r) => {
    const p = positionOf(r);
    return p !== undefined && distanceKm(point, p) <= radiusKm;
  });
  let officialWarnings: WarningBriefing | undefined;
  if (input.withWarnings === true) {
    // The reports' mean, rounded to 0.1° like every report's position: with one report it is that person's.
    const centre = mean(selected.map(positionOf).filter((p): p is [number, number] => p !== undefined));
    const at = point ?? (centre === undefined ? undefined : ([round01(centre[0]), round01(centre[1])] as [number, number]));
    if (at === undefined) notes.push("No point for the official warnings: give lat/lon, or a place with reports.");
    else {
      if (point === undefined) notes.push(`Official warnings at the matching reports' mean position (${at[0]}, ${at[1]}), rounded to 0.1 degrees.`);
      officialWarnings = await getWarningBriefing(client, { feeds: ["nowcast", "gemeinde"], lat: at[0], lon: at[1], now });
    }
  }
  const what = `${categories === undefined ? "weather" : categories.join("/")} reports`;
  const whereText = place !== undefined ? ` matching "${place.trim()}"` : point !== undefined ? ` within ${radiusKm} km of ${point[0]}, ${point[1]}` : " in Germany";
  if (selected.length === 0) {
    return {
      status: "empty",
      ...base,
      ...empty,
      ...(officialWarnings === undefined ? {} : { officialWarnings }),
      reason: `No crowd ${what}${whereText} in the last ${sinceMinutes} minutes of the feed (to ${berlinTime(end)}). That is a valid answer: nobody reported it there, which doesn't prove it isn't happening.`,
    };
  }
  const byCategory = new Map<string, { category: string; count: number; variants: Record<string, number>; withPhoto: number; maxLikes: number }>();
  const placeCounts = new Map<string, number>();
  for (const r of selected) {
    const category = String(r["category"]);
    const entry = byCategory.get(category) ?? { category, count: 0, variants: {}, withPhoto: 0, maxLikes: 0 };
    entry.count++;
    const variant = text(r["auspraegung"]) ?? "(none)";
    entry.variants[variant] = (entry.variants[variant] ?? 0) + 1;
    if (hasPhoto(r)) entry.withPhoto++;
    entry.maxLikes = Math.max(entry.maxLikes, num(r["likeCount"]) ?? 0);
    byCategory.set(category, entry);
    const name = text(r["place"]) ?? "(no place)";
    placeCounts.set(name, (placeCounts.get(name) ?? 0) + 1);
  }
  const listed: CrowdReport[] = selected
    .map((r) => ({ r, likes: num(r["likeCount"]) ?? 0 }))
    .sort((a, b) => b.likes - a.likes)
    .slice(0, 30)
    .map(({ r, likes }) => {
      const p = positionOf(r);
      const t = num(r["timestamp"]) ?? end;
      const hourStart = Math.floor(t / 3_600_000) * 3_600_000;
      const extras = Array.isArray(r["zusatzAttribute"]) ? r["zusatzAttribute"].filter((x): x is string => typeof x === "string") : [];
      return {
        place: text(r["place"]) ?? "(no place)",
        category: String(r["category"]),
        variant: text(r["auspraegung"]) ?? "(none)",
        hour: `${berlinTime(hourStart).slice(11, 16)}–${berlinTime(hourStart + 3_600_000).slice(11, 16)}`,
        likes,
        photo: hasPhoto(r),
        ...(extras.length === 0 ? {} : { extras }),
        ...(p === undefined ? {} : { area: [round01(p[0]), round01(p[1])] as [number, number] }),
      } satisfies CrowdReport;
    });
  return {
    status: "ok",
    ...base,
    matched: selected.length,
    byCategory: [...byCategory.values()].sort((a, b) => b.count - a.count),
    places: [...placeCounts].map(([name, count]) => ({ place: name, count })).sort((a, b) => b.count - a.count).slice(0, 10),
    reports: listed,
    ...(officialWarnings === undefined ? {} : { officialWarnings }),
  };
}

/** The mean of positions, or undefined for none. */
function mean(positions: [number, number][]): [number, number] | undefined {
  if (positions.length === 0) return undefined;
  return [positions.reduce((s, p) => s + p[0], 0) / positions.length, positions.reduce((s, p) => s + p[1], 0) / positions.length];
}
