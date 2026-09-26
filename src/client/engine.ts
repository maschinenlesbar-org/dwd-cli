// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { MAX_TIMEOUT_MS, nodeHttpTransport, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import { DwdApiError, DwdError, DwdNetworkError, DwdParseError, redactUrl } from "./errors.js";

export const DEFAULT_BASE_URL = "https://app-prod-ws.warnwetter.de";
const DEFAULT_USER_AGENT = "dwd-cli";

// Headers dropped when a redirect crosses to a different origin, so credentials
// issued for the original host are never leaked to a redirect target.
const SENSITIVE_HEADERS = new Set(["authorization", "x-api-key", "cookie"]);

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

/**
 * Options for {@link RequestEngine} and the client. The numeric options must be
 * integers within their documented range; anything else (negative, fractional,
 * NaN, Infinity, too large) makes the constructor throw a DwdError.
 */
export interface EngineOptions {
  /** Base URL of the API. Defaults to https://app-prod-ws.warnwetter.de */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header. */
  userAgent?: string;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps (0 = no timeout; at most `MAX_TIMEOUT_MS`, 2^31 - 1 ms).
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses, 0..`MAX_RETRIES`
   * (10). Each waits the
   * response's `Retry-After` (up to `MAX_RETRY_AFTER_MS`; a longer one is not
   * retried), or else `retryDelayMs * attempt`.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly); used without a
   * Retry-After. At most `MAX_RETRY_AFTER_MS`.
   */
  retryDelayMs?: number;
  /**
   * Number of HTTP redirects (301/302/303/307/308) to follow, 0..20. Defaults to 5. Any
   * other 3xx (300, 304, 305, ...) is not followed and surfaces as a DwdApiError
   * naming the target.
   */
  maxRedirects?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint). Defaults to 100 MiB; set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * The redirect statuses the engine follows. 300 (a choice for the user), 304 (a
 * cache answer to a conditional request this client never sends) and 305/306
 * (deprecated) are not redirects to follow; they surface as a DwdApiError.
 */
const FOLLOWED_REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Most automatic retries a caller may ask for (the CLI's --max-retries shares it). */
export const MAX_RETRIES = 10;

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/**
 * Strip control characters (all C0/C1 except tab and newline, plus DEL) out of a
 * string that originates in an attacker-controlled response — the error `detail`,
 * a redirect `Location` and the echoed Content-Type. `JSON.parse` decodes a backslash-u001b escape in an error
 * body into a real ESC byte, so without this a hostile or MITM'd endpoint (or a
 * redirect target — redirects are followed here) could drive ANSI/OSC escape
 * sequences into the user's terminal when the message is printed to stderr.
 * The CLI's JSON output is escaped separately (`escapeControlChars` in
 * cli/shared.ts): `JSON.stringify` alone leaves DEL and the C1 range raw.
 * `DwdApiError.body` still
 * carries the raw, unsanitised body for library consumers.
 */
function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    // strip C0/C1 except tab (0x09) and newline (0x0a), plus DEL (0x7f)
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a Content-Type denotes JSON: the canonical `application/json`,
 * structured-suffix types (`application/vnd.foo+json`), and the lenient
 * `text/json`. Parameters (`; charset=...`) and case are ignored.
 */
function isJsonContentType(contentType: string): boolean {
  const type = mediaType(contentType).toLowerCase();
  return type === "application/json" || type === "text/json" || type.endsWith("+json");
}

/** The media type without parameters or surrounding whitespace. */
function mediaType(contentType: string): string {
  const semi = contentType.indexOf(";");
  return (semi === -1 ? contentType : contentType.slice(0, semi)).trim();
}

/** Most redirects a caller may let the engine follow (the Fetch standard's limit). */
const MAX_REDIRECTS = 20;

/**
 * Read a numeric engine option: `undefined` gives the default; anything but an
 * integer in [0, max] throws. Without this a negative or NaN `timeoutMs` silently
 * disabled the timeout, and `maxResponseBytes: -1` the size cap.
 */
function intOption(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new DwdError(
      `Invalid option ${name}: expected an integer from 0 to ${max}, got ${String(value)}.`,
    );
  }
  return value;
}

export class RequestEngine {
  private readonly baseUrl: string;
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = options.transport ?? nodeHttpTransport;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = intOption("timeoutMs", options.timeoutMs, 30_000, MAX_TIMEOUT_MS);
    this.maxRetries = intOption("maxRetries", options.maxRetries, 2, MAX_RETRIES);
    this.retryDelayMs = intOption("retryDelayMs", options.retryDelayMs, 200, MAX_RETRY_AFTER_MS);
    this.maxRedirects = intOption("maxRedirects", options.maxRedirects, 5, MAX_REDIRECTS);
    this.maxResponseBytes = intOption(
      "maxResponseBytes",
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      Number.MAX_SAFE_INTEGER,
    );
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * Build a fully-qualified URL from a path and optional query parameters.
   *
   * The base URL is validated and decomposed via the WHATWG URL parser rather
   * than blindly concatenated, so a scheme-only base (`https:`) or one carrying
   * a query string (`https://host/?x=1`) is rejected with a clear,
   * base-url-specific error instead of silently producing a malformed URL — e.g.
   * promoting an internal path segment to the hostname, or emitting a double-`?`.
   * The base's own path prefix (such as the static bucket's
   * `/app-prod-static.warnwetter.de`) is preserved.
   */
  buildUrl(path: string, query?: QueryParams): string {
    let base: URL;
    try {
      base = new URL(this.baseUrl);
    } catch {
      throw new DwdNetworkError(`Invalid base URL: "${redactUrl(this.baseUrl)}"`);
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw new DwdNetworkError(
        `Unsupported protocol "${base.protocol}" in base URL: "${redactUrl(this.baseUrl)}"`,
      );
    }
    if (!base.host) {
      throw new DwdNetworkError(`Base URL "${redactUrl(this.baseUrl)}" has no host`);
    }
    if (base.search || base.hash) {
      throw new DwdNetworkError(
        `Base URL "${redactUrl(this.baseUrl)}" must not contain a query string or fragment`,
      );
    }
    const basePath = base.pathname.replace(/\/+$/, "");
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const qs = query ? buildQueryString(query) : "";
    // Keep any userinfo (`http://user:pw@proxy/`): the transport sends it as Basic
    // auth, for a proxy or mirror behind a login. Error messages show it redacted.
    const userinfo =
      base.username || base.password
        ? `${base.username}${base.password ? `:${base.password}` : ""}@`
        : "";
    return `${base.protocol}//${userinfo}${base.host}${basePath}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    let url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Accept: options.accept,
      // Advertise the encodings the transport can decode so an RFC-compliant
      // origin (which compresses only when asked) actually compresses; the
      // gzip/deflate/br decode paths would otherwise be dead code against
      // anything but DWD's S3 bucket (which sends gzip unsolicited).
      "Accept-Encoding": "gzip, deflate, br",
      "User-Agent": this.userAgent,
    };

    let attempt = 0;
    let redirects = 0;
    // attempts = initial try + maxRetries (redirects are counted separately)
    for (;;) {
      const response = await this.transport({
        method,
        url,
        headers,
        timeoutMs: this.timeoutMs,
        ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
      });

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        // Honour Retry-After; without a usable one, back off linearly. A Retry-After
        // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          await this.sleep(retryAfter ?? this.retryDelayMs * attempt);
          continue;
        }
      }

      // Follow redirects, resolving the Location relative to the current URL. Any
      // other 3xx falls through and surfaces as a DwdApiError naming the target.
      const locationHeader = response.headers["location"];
      if (FOLLOWED_REDIRECTS.has(status) && locationHeader) {
        if (redirects >= this.maxRedirects) {
          throw new DwdNetworkError(
            `Too many redirects (exceeded maxRedirects=${this.maxRedirects}) for ${method} ${redactUrl(url)}`,
          );
        }
        const location = locationHeader;
        if (typeof location === "string" && location.length > 0) {
          // A malformed Location would make `new URL` throw a raw TypeError; wrap
          // it so it surfaces as a typed DwdNetworkError rather than an untyped
          // "Unexpected error".
          let target: URL;
          try {
            target = new URL(location, url);
          } catch {
            throw new DwdNetworkError(
              `Invalid redirect Location "${sanitizeServerText(location)}" for ${method} ${redactUrl(url)}`,
            );
          }
          // Enforce the http(s) scheme allowlist on the redirect target here in
          // the engine. The default transport also rejects non-http(s), but
          // Transport is an injectable library seam: a consumer's custom
          // transport must not be steered to file:/other schemes by a hostile
          // redirect.
          if (target.protocol !== "http:" && target.protocol !== "https:") {
            throw new DwdNetworkError(
              `Refusing to follow redirect to unsupported protocol "${target.protocol}" for ${method} ${redactUrl(url)}`,
            );
          }
          // Cross-origin credential strip: never forward sensitive headers to a
          // different origin than the one they were issued for. Today's headers
          // are non-sensitive (Accept/User-Agent), but a redirect can point at
          // any host, so guard here before anyone adds an auth/cookie header.
          if (target.origin !== new URL(url).origin) {
            for (const name of Object.keys(headers)) {
              if (SENSITIVE_HEADERS.has(name.toLowerCase())) delete headers[name];
            }
          }
          url = target.toString();
          redirects += 1;
          continue;
        }
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body, locationHeader);
      }

      return { data: response.body, contentType, status };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    // Honour the Content-Type: a 200 with a clearly non-JSON type (e.g. a
    // captive-portal HTML error page) should report what was actually returned
    // rather than feeding HTML into JSON.parse and blaming a parse failure. A
    // missing/empty Content-Type is treated leniently and still parsed.
    if (res.contentType && !isJsonContentType(res.contentType)) {
      throw new DwdParseError(
        `Expected a JSON response from ${path} but got Content-Type "${sanitizeServerText(mediaType(res.contentType))}"`,
      );
    }
    const text = decodeBody(res.data, res.contentType, path);
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      // Name the parser's reason (position/token, "Unexpected end of JSON input"):
      // the CLI never prints `cause`, and an empty, truncated or garbled body
      // otherwise all read the same. It can quote the body, so it is sanitised.
      const reason = cause instanceof Error ? sanitizeServerText(cause.message) : "";
      throw new DwdParseError(
        `Failed to parse JSON response from ${path}${reason ? `: ${reason}` : ""}`,
        { cause },
      );
    }
  }

  private toApiError(
    method: string,
    url: string,
    status: number,
    body: Buffer,
    locationHeader?: string,
  ): DwdApiError {
    const text = body.toString("utf8");
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    // `detail` came from the response body; strip control characters so a hostile
    // endpoint cannot inject terminal escape sequences via the stderr error message.
    if (detail !== undefined) detail = sanitizeServerText(detail);
    // Name the target of a redirect that was not followed.
    const location =
      status >= 300 && status < 400 && locationHeader ? redirectTarget(url, locationHeader) : undefined;
    return new DwdApiError({ status, url, method, body: text, detail, location });
  }
}

/**
 * Decode a response body by the charset of its Content-Type (UTF-8 when none is
 * given, as JSON requires). A leading byte-order mark is dropped: TextDecoder does
 * that by default, where Buffer#toString kept it and JSON.parse then failed. DWD
 * sends UTF-8; this matters for proxies and mirrors that re-encode.
 */
function decodeBody(body: Buffer, contentType: string, path: string): string {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    throw new DwdParseError(
      `Unsupported response charset "${sanitizeServerText(charset)}" from ${path}.`,
    );
  }
  return decoder.decode(body);
}

/**
 * The absolute, printable form of a `Location` header: resolved against the request
 * URL, userinfo redacted, control characters stripped (it is server text bound for
 * stderr). An unparseable value is shown sanitised as it came.
 */
function redirectTarget(requestUrl: string, location: string): string | undefined {
  let resolved: URL | undefined;
  try {
    resolved = new URL(location, requestUrl);
  } catch {
    resolved = undefined;
  }
  const clean = sanitizeServerText(resolved ? redactUrl(resolved.href) : location).trim();
  return clean === "" ? undefined : clean;
}
