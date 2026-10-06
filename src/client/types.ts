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
 * The numbers are scaled integers, tenths of their unit (`decodeStationOverview` converts
 * them; see GLOSSARY). `null` inside an array
 * means "no value": the client turns the API's missing-value marker 32767
 * (`STATION_MISSING_VALUE`) into `null`. `days[].sunshine` is not reliable: it is
 * either the day's sum of the hourly sunshine values or `0`, on sunny days too.
 */
export type StationOverview = { [stationId: string]: JsonObject };

/** Common envelope of the warning feeds (nowcast / gemeinde). */
export interface WarningsFeed {
  /** When DWD published the feed, epoch milliseconds (checked: a feed without it is a DwdParseError). */
  time: number;
  warnings: JsonObject[];
  binnenSee?: JsonValue;
}

/** Coastal warnings feed — `warnings` is keyed by coastal zone. */
export interface CoastWarningsFeed {
  /** When DWD published the feed, epoch milliseconds (checked, as for WarningsFeed). */
  time: number;
  warnings: JsonObject;
  /** Advance information ("Vorabinformation"), keyed like `warnings`. */
  vorabInformation?: JsonObject;
}

/** Crowd-sourced reports overview. */
export interface CrowdOverview {
  start?: number;
  end?: number;
  /** Not the length of the `start`–`end` window (see GLOSSARY). */
  windowsSizeHours?: number;
  highestSeverities?: JsonValue;
  meldungen: JsonObject[];
}
