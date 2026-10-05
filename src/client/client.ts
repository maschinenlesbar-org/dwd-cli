// DwdClient — a typed client over the open (no-auth) endpoints of the DWD
// Warnwetter app backend. The data lives on two hosts:
//
//   - the live web service  (https://app-prod-ws.warnwetter.de/v30)  — station
//     overviews / forecasts, queried with parameters;
//   - a static S3 bucket    (https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16)
//     — the periodically-published warning feeds (gzip-encoded JSON).
//
// Both are driven by the same engine; only the base URL differs.
//
//   client.weather.stationOverview(["10865"])
//   client.warnings.nowcast("de")

import { RequestEngine, validateBaseUrl, type EngineOptions } from "./engine.js";
import { LangValues, type Lang } from "./enums.js";
import { DwdParseError, DwdValidationError } from "./errors.js";
import { assertValid, normalizeStationIds, serviceBaseUrlProblem, stationIdProblem } from "./validate.js";
import type {
  StationOverview,
  WarningsFeed,
  CoastWarningsFeed,
  CrowdOverview,
} from "./types.js";

/** The version segment the client adds to `baseUrl` (live web service). */
export const WS_VERSION = "/v30";
/** The version segment the client adds to `staticBaseUrl` (static bucket). */
export const STATIC_VERSION = "/v16";
const WS = WS_VERSION;
const STATIC = STATIC_VERSION;

export const DEFAULT_STATIC_BASE_URL =
  "https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de";

/**
 * Options for the DWD client. `baseUrl` is the live web service host and
 * `staticBaseUrl` the bucket root, both without the version segment the client adds
 * (`/v30`, `/v16`); a value ending in it throws a DwdValidationError.
 */
export interface DwdClientOptions extends EngineOptions {
  /**
   * Base URL of the static S3 bucket. Defaults to the production bucket. It must
   * pass the same rules as `baseUrl`; a bad value throws a DwdValidationError.
   */
  staticBaseUrl?: string;
}

/**
 * German feeds have no suffix; English feeds use the `_en` filename suffix. Any
 * other value (a JS caller, untyped input) throws a DwdValidationError instead of
 * silently serving the German feed.
 */
function langSuffix(lang: Lang): string {
  if (!(LangValues as readonly unknown[]).includes(lang)) {
    const shown = typeof lang === "string" ? JSON.stringify(lang.length > 50 ? `${lang.slice(0, 50)}…` : lang) : `a ${typeof lang}`;
    throw new DwdValidationError(`Invalid lang: expected one of ${LangValues.join(", ")}, got ${shown}.`);
  }
  return lang === "en" ? "_en" : "";
}

/**
 * The ids joined for the `stationIds` parameter: each id trimmed
 * ({@link normalizeStationIds}), then checked ({@link stationIdProblem}). An empty
 * list, a blank id or one containing a comma would send an empty slot, which the
 * API answers with `{}`, so they throw a DwdValidationError.
 */
function joinStationIds(stationIds: readonly string[]): string {
  assertValid("stationIds", stationIds, (v) =>
    Array.isArray(v) && v.length > 0 ? undefined : "expected at least one station id.",
  );
  const ids = normalizeStationIds(stationIds);
  for (const id of ids) assertValid("station id", id, stationIdProblem);
  return ids.join(",");
}

/** A non-null, non-array JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shapeError(path: string, expected: string): DwdParseError {
  return new DwdParseError(`Unexpected response shape from ${path}: expected ${expected}.`);
}

/**
 * Envelope fields that must be a finite number: `required` ones always, `optional` ones
 * when present. The warning feeds' `time` is what a briefing states as "feed time"; a
 * feed without it (or with a string) would make `new Date(feed.time)` an Invalid Date.
 */
interface NumberFields {
  required?: readonly string[];
  optional?: readonly string[];
}

/**
 * Check the top-level shape the types promise — never the records inside. A 200
 * body of `null`, `[]` or an S3/proxy error document would otherwise be returned
 * typed as a feed (and printed with exit 0).
 */
async function getChecked<T>(
  e: RequestEngine,
  path: string,
  query: Record<string, string> | undefined,
  key: string | undefined,
  kind: "array" | "object",
  numbers: NumberFields = {},
): Promise<T> {
  const body = await e.getJson<unknown>(path, query);
  if (key === undefined) {
    if (!isObject(body)) throw shapeError(path, "a JSON object");
    return body as T;
  }
  const value = isObject(body) ? body[key] : undefined;
  const ok = kind === "array" ? Array.isArray(value) : isObject(value);
  if (!ok) throw shapeError(path, `a JSON object with a ${key} ${kind}`);
  const envelope = body as Record<string, unknown>;
  const isNumber = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
  for (const field of numbers.required ?? []) {
    if (!isNumber(envelope[field])) throw shapeError(path, `a numeric ${field} (epoch milliseconds)`);
  }
  for (const field of numbers.optional ?? []) {
    if (field in envelope && !isNumber(envelope[field])) {
      throw shapeError(path, `a numeric ${field} (epoch milliseconds) when it is present`);
    }
  }
  return body as T;
}

/** The warning feeds' `time`: when DWD published the feed, epoch ms. */
const FEED_TIME: NumberFields = { required: ["time"] };

/** Live web service: station overviews and forecasts. */
class WeatherResource {
  constructor(private readonly e: RequestEngine) {}

  /**
   * Forecasts/observations for one or more DWD station ids. Each id is trimmed; an
   * empty list, a blank id or one with a comma rejects with a DwdValidationError
   * before any request.
   */
  async stationOverview(stationIds: string[]): Promise<StationOverview> {
    const query = { stationIds: joinStationIds(stationIds) };
    return getChecked(this.e, `${WS}/stationOverviewExtended`, query, undefined, "object");
  }
}

/**
 * Static bucket: the published warning feeds. A `lang` other than "de" / "en"
 * rejects with a DwdValidationError before any request.
 */
class WarningsResource {
  constructor(private readonly e: RequestEngine) {}

  /** Short-term (nowcast) warnings. */
  async nowcast(lang: Lang = "de"): Promise<WarningsFeed> {
    return getChecked(this.e, `${STATIC}/warnings_nowcast${langSuffix(lang)}.json`, undefined, "warnings", "array", FEED_TIME);
  }

  /** Municipality-level warnings. */
  async gemeinde(lang: Lang = "de"): Promise<WarningsFeed> {
    return getChecked(this.e, `${STATIC}/gemeinde_warnings_v2${langSuffix(lang)}.json`, undefined, "warnings", "array", FEED_TIME);
  }

  /** Coastal warnings (keyed by coastal zone). */
  async coast(lang: Lang = "de"): Promise<CoastWarningsFeed> {
    return getChecked(this.e, `${STATIC}/warnings_coast${langSuffix(lang)}.json`, undefined, "warnings", "object", FEED_TIME);
  }
}

export class DwdClient {
  private readonly ws: RequestEngine;
  private readonly static_: RequestEngine;

  readonly weather: WeatherResource;
  readonly warnings: WarningsResource;

  constructor(options: DwdClientOptions = {}) {
    // A JavaScript caller may pass null for "no options"; treat it like undefined.
    const { staticBaseUrl, ...engineOptions } = options ?? {};
    this.ws = new RequestEngine(engineOptions);
    this.static_ = new RequestEngine({
      ...engineOptions,
      // Checked here first so an error names the option the caller set.
      baseUrl:
        staticBaseUrl === undefined ? DEFAULT_STATIC_BASE_URL : validateBaseUrl(staticBaseUrl, "staticBaseUrl"),
    });

    // The engines have checked the URL shapes; a value ending in the version
    // segment the client adds would request /v30/v30/... or /v16/v16/...
    if (engineOptions.baseUrl !== undefined) assertValid("baseUrl", engineOptions.baseUrl, serviceBaseUrlProblem(WS));
    if (staticBaseUrl !== undefined) assertValid("staticBaseUrl", staticBaseUrl, serviceBaseUrlProblem(STATIC));

    this.weather = new WeatherResource(this.ws);
    this.warnings = new WarningsResource(this.static_);
  }

  /** Crowd-sourced weather reports overview (static bucket). */
  async crowd(): Promise<CrowdOverview> {
    return getChecked(this.static_, `${STATIC}/crowd_meldungen_overview_v2.json`, undefined, "meldungen", "array", {
      optional: ["start", "end"],
    });
  }
}
