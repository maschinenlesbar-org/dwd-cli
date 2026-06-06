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
import type { Lang } from "./enums.js";
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

/** German feeds have no suffix; English feeds use the `_en` filename suffix. */
function langSuffix(lang: Lang): string {
  return lang === "en" ? "_en" : "";
}

/** Live web service: station overviews and forecasts. */
class WeatherResource {
  constructor(private readonly e: RequestEngine) {}

  /** Forecasts/observations for one or more DWD station ids. */
  stationOverview(stationIds: string[]): Promise<StationOverview> {
    return this.e.getJson(`${WS}/stationOverviewExtended`, { stationIds: stationIds.join(",") });
  }
}

/** Static bucket: the published warning feeds. */
class WarningsResource {
  constructor(private readonly e: RequestEngine) {}

  /** Short-term (nowcast) warnings. */
  nowcast(lang: Lang = "de"): Promise<WarningsFeed> {
    return this.e.getJson(`${STATIC}/warnings_nowcast${langSuffix(lang)}.json`);
  }

  /** Municipality-level warnings. */
  gemeinde(lang: Lang = "de"): Promise<WarningsFeed> {
    return this.e.getJson(`${STATIC}/gemeinde_warnings_v2${langSuffix(lang)}.json`);
  }

  /** Coastal warnings (keyed by coastal zone). */
  coast(lang: Lang = "de"): Promise<CoastWarningsFeed> {
    return this.e.getJson(`${STATIC}/warnings_coast${langSuffix(lang)}.json`);
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
  crowd(): Promise<CrowdOverview> {
    return this.static_.getJson(`${STATIC}/crowd_meldungen_overview_v2.json`);
  }
}
