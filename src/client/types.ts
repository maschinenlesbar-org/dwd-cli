// Domain types for the DWD app/warning API (warnwetter.de).
//
// The station overview and warning payloads are large and DWD-specific, so they
// are exposed as faithful raw `JsonObject`s; the warning-feed envelopes are typed
// at the top level.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * Response of `stationOverviewExtended` — an object keyed by station id, each
 * value carrying `forecast1`/`forecast2`/`days`/`warnings`/`threeHourSummaries`.
 */
export type StationOverview = { [stationId: string]: JsonObject };

/** Common envelope of the warning feeds (nowcast / gemeinde). */
export interface WarningsFeed {
  time: number;
  warnings: JsonObject[];
  binnenSee?: JsonValue;
}

/** Coastal warnings feed — `warnings` is keyed by coastal zone. */
export interface CoastWarningsFeed {
  time: number;
  warnings: JsonObject;
}

/** Crowd-sourced reports overview. */
export interface CrowdOverview {
  start?: number;
  end?: number;
  highestSeverities?: JsonValue;
  meldungen: JsonObject[];
}
