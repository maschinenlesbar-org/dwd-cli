// How the MCP server reaches this repository's client. The server's generic files (server.ts,
// limiter.ts, config.ts, run.ts, result.ts: the kit, the same in every repository) import the
// client only through this file, under the names below; the names on the right are this
// client's. Per repository, like tools.ts: a client whose names or functions differ adapts here.
//
// The DWD data lives on two hosts: the live web service (station forecasts, under /v30) and a
// static bucket (the warning feeds and the crowd reports, under /v16). The server has one
// --base-url: a mirror of both (its /v30 and /v16 under one base), as the mock upstreams of the
// tests, the image smoke test and the interop check are. Without it, each host is its default.

import { DEFAULT_BASE_URL, DEFAULT_STATIC_BASE_URL, DwdClient, STATIC_VERSION, type DwdClientOptions } from "@maschinenlesbar.org/dwd-client";

export {
  DwdError as ClientError,
  DwdNetworkError as NetworkError,
  baseUrlProblem,
  DEFAULT_BASE_URL,
  MAX_TIMEOUT_MS,
  nodeHttpTransport,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from "@maschinenlesbar.org/dwd-client";
export { sizeLimitMessage } from "@maschinenlesbar.org/dwd-client/internal/http";
export { cutText, toWellFormed } from "@maschinenlesbar.org/dwd-client/internal/errors";

const strip = (url: string): string => url.replace(/\/+$/, "");

/** The API's base URL as a result's `source` starts with it (`--base-url`, else the live service's default). */
export function apiBase(baseUrl: string | undefined): string {
  return strip(baseUrl ?? DEFAULT_BASE_URL);
}

/** `url` as WHATWG reads it (host lower-cased, a default port dropped), without trailing slashes; the text itself when it doesn't parse. */
const canonical = (url: string): string => {
  try {
    return strip(new URL(url).href);
  } catch {
    return strip(url);
  }
};

/**
 * The bucket's base for an API base: the mirror itself, or the default bucket for the default
 * service, however it is spelled (`https://APP-PROD-WS.warnwetter.de:443/` is the default too).
 */
export function staticBase(base: string): string {
  return canonical(base) === canonical(DEFAULT_BASE_URL) ? strip(DEFAULT_STATIC_BASE_URL) : strip(base);
}

/** The URL of a file in the bucket (`warnings_nowcast.json`), for a result's `source`. */
export function staticSource(base: string, file: string): string {
  return `${staticBase(base)}${STATIC_VERSION}/${file}`;
}

/** The DWD client with one base for both hosts: `baseUrl` (a mirror) serves the bucket too. */
export class Client extends DwdClient {
  constructor(options: DwdClientOptions = {}) {
    super({ ...options, staticBaseUrl: options.baseUrl === undefined ? DEFAULT_STATIC_BASE_URL : staticBase(options.baseUrl) });
  }
}
