// Public entry point for the API client library.

export { DwdClient, DEFAULT_STATIC_BASE_URL } from "./client.js";
export type { DwdClientOptions } from "./client.js";
export {
  RequestEngine,
  DEFAULT_BASE_URL,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
} from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export { DwdError, DwdApiError, DwdNetworkError, DwdParseError } from "./errors.js";

export * from "./enums.js";
export * from "./types.js";
