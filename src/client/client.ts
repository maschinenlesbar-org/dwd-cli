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

import { RequestEngine, type EngineOptions } from "./engine.js";
import { LangValues, type Lang } from "./enums.js";
import { DwdError, DwdParseError } from "./errors.js";
import type {
  StationOverview,
  WarningsFeed,
  CoastWarningsFeed,
  CrowdOverview,
} from "./types.js";

const WS = "/v30";
const STATIC = "/v16";

export const DEFAULT_STATIC_BASE_URL =
  "https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de";

/** Options for the DWD client. `baseUrl` is the live web service host. */
export interface DwdClientOptions extends EngineOptions {
  /** Base URL of the static S3 bucket. Defaults to the production bucket. */
  staticBaseUrl?: string;
}

/**
 * German feeds have no suffix; English feeds use the `_en` filename suffix. Any
 * other value (a JS caller, untyped input) throws instead of silently serving the
 * German feed.
 */
function langSuffix(lang: Lang): string {
  if (!(LangValues as readonly unknown[]).includes(lang)) {
    throw new DwdError(`Invalid lang: expected one of ${LangValues.join(", ")}, got ${JSON.stringify(lang)}.`);
  }
  return lang === "en" ? "_en" : "";
}

/**
 * The ids joined for the `stationIds` parameter. An empty list, a blank id or one
 * containing a comma would send an empty slot (`stationIds=` or `1,,2`), which the
 * API answers with `{}` — indistinguishable from "no such station" — so they throw.
 */
function joinStationIds(stationIds: readonly string[]): string {
  if (!Array.isArray(stationIds) || stationIds.length === 0) {
    throw new DwdError("Invalid stationIds: expected at least one station id.");
  }
  for (const id of stationIds) {
    if (typeof id !== "string" || id.trim() === "" || id.includes(",")) {
      throw new DwdError(
        `Invalid station id: expected a non-blank id without commas, got ${JSON.stringify(id)}.`,
      );
    }
  }
  return stationIds.join(",");
}

/** A non-null, non-array JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shapeError(path: string, expected: string): DwdParseError {
  return new DwdParseError(`Unexpected response shape from ${path}: expected ${expected}.`);
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
): Promise<T> {
  const body = await e.getJson<unknown>(path, query);
  if (key === undefined) {
    if (!isObject(body)) throw shapeError(path, "a JSON object");
    return body as T;
  }
  const value = isObject(body) ? body[key] : undefined;
  const ok = kind === "array" ? Array.isArray(value) : isObject(value);
  if (!ok) throw shapeError(path, `a JSON object with a ${key} ${kind}`);
  return body as T;
}

/** Live web service: station overviews and forecasts. */
class WeatherResource {
  constructor(private readonly e: RequestEngine) {}

  /**
   * Forecasts/observations for one or more DWD station ids. An empty list, a blank
   * id or one with a comma rejects with a DwdError before any request.
   */
  async stationOverview(stationIds: string[]): Promise<StationOverview> {
    const query = { stationIds: joinStationIds(stationIds) };
    return getChecked(this.e, `${WS}/stationOverviewExtended`, query, undefined, "object");
  }
}

/**
 * Static bucket: the published warning feeds. A `lang` other than "de" / "en"
 * rejects with a DwdError before any request.
 */
class WarningsResource {
  constructor(private readonly e: RequestEngine) {}

  /** Short-term (nowcast) warnings. */
  async nowcast(lang: Lang = "de"): Promise<WarningsFeed> {
    return getChecked(this.e, `${STATIC}/warnings_nowcast${langSuffix(lang)}.json`, undefined, "warnings", "array");
  }

  /** Municipality-level warnings. */
  async gemeinde(lang: Lang = "de"): Promise<WarningsFeed> {
    return getChecked(this.e, `${STATIC}/gemeinde_warnings_v2${langSuffix(lang)}.json`, undefined, "warnings", "array");
  }

  /** Coastal warnings (keyed by coastal zone). */
  async coast(lang: Lang = "de"): Promise<CoastWarningsFeed> {
    return getChecked(this.e, `${STATIC}/warnings_coast${langSuffix(lang)}.json`, undefined, "warnings", "object");
  }
}

export class DwdClient {
  private readonly ws: RequestEngine;
  private readonly static_: RequestEngine;

  readonly weather: WeatherResource;
  readonly warnings: WarningsResource;

  constructor(options: DwdClientOptions = {}) {
    const { staticBaseUrl, ...engineOptions } = options;
    this.ws = new RequestEngine(engineOptions);
    this.static_ = new RequestEngine({
      ...engineOptions,
      baseUrl: staticBaseUrl ?? DEFAULT_STATIC_BASE_URL,
    });

    this.weather = new WeatherResource(this.ws);
    this.warnings = new WarningsResource(this.static_);
  }

  /** Crowd-sourced weather reports overview (static bucket). */
  async crowd(): Promise<CrowdOverview> {
    return getChecked(this.static_, `${STATIC}/crowd_meldungen_overview_v2.json`, undefined, "meldungen", "array");
  }
}
