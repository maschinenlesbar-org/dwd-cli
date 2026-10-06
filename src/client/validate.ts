// Input validation shared by the library and the CLI. Every rule about what a
// request may contain lives here (or next to the option it guards) as a pure,
// exported function, so the CLI calls the very same rule instead of keeping a copy.
//
// - A `Problem` returns the reason a value is invalid ("Expected a non-empty
//   value."), or `undefined` when it is valid. The CLI's commander parsers turn
//   that reason into an `InvalidArgumentError` (exit 2).
// - `assertValid` runs a `Problem` in the library and throws a
//   `DwdValidationError` ("Invalid <name>: <reason>") before any request is made.
//   Methods that return a promise call it inside the async body, so they reject
//   rather than throw synchronously; constructors throw.

import { DwdValidationError, redactUrl } from "./errors.js";

/** A validation rule: the reason `value` is invalid, or `undefined` when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Check `value` against `problem` and return it unchanged when it is valid.
 * Otherwise throw a {@link DwdValidationError} with the message
 * `Invalid <name>: <reason>`.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new DwdValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/** A value must be a string that is not blank (`""` or whitespace only). */
export const nonBlankProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (value.trim() === "") return "Expected a non-empty value.";
  return undefined;
};

/**
 * A value that ends up in an HTTP header (the User-Agent) must be a non-blank
 * string of Latin-1 characters without control characters (tab is allowed, as in
 * HTTP). Node's HTTP layer would otherwise throw an opaque "Invalid character in
 * header content" at request time, and a custom transport would get a CR/LF
 * through (header injection). Checked by char code so the source stays free of
 * control bytes.
 */
export const headerValueProblem: Problem<unknown> = (value) => {
  const blank = nonBlankProblem(value);
  if (blank !== undefined) return blank;
  const text = value as string;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/**
 * A base URL (`baseUrl`, `staticBaseUrl`) must be an absolute `http:`/`https:` URL
 * without a query or fragment, and without whitespace or control characters.
 * `new URL()` trims surrounding whitespace and drops tab/CR/LF silently, so the raw
 * string is checked rather than the parsed one; request paths are appended to the
 * base's path, so a `?` or `#` would swallow them. Userinfo (`user:pw@`) is allowed:
 * the engine sends it as Basic auth, for a proxy or mirror behind a login; a `%` in it
 * must start a valid escape (`%25` for a literal one).
 */
export const baseUrlProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string") return "Expected a string.";
  if (value.trim() === "") return "Expected an absolute http(s) URL.";
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return "A base URL cannot contain whitespace or control characters.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected an absolute http(s) URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported scheme "${url.protocol}". Expected an http(s) URL.`;
  }
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  // The userinfo is percent-decoded for the Authorization header; a "%" that isn't an
  // escape fails there ("URI malformed") at request time, as a network error. Reject it here.
  for (const part of [url.username, url.password]) {
    try {
      decodeURIComponent(part);
    } catch {
      return 'The user name or password has a "%" that is not followed by two hex digits; write a literal "%" as %25.';
    }
  }
  return undefined;
};

/**
 * Station ids in canonical form: each id trimmed (`" 10865 "` -> `"10865"`) and in
 * Unicode NFC, so a padded id is not sent as `stationIds=%2010865%20`, which the API
 * may drop like an unknown station. Idempotent; a non-string entry is left for the
 * validator.
 */
export function normalizeStationIds(stationIds: readonly unknown[]): unknown[] {
  return stationIds.map((id) => (typeof id === "string" ? id.trim().normalize("NFC") : id));
}

/**
 * A station id (after {@link normalizeStationIds}) must be a non-blank string
 * without commas, whitespace, semicolons or control characters. A blank id or a
 * comma would send an empty slot in `stationIds` (`stationIds=` or `1,,2`); a list
 * joined with spaces, newlines or `;` (`"10865 10147"`, what `--id "$IDS"` gives for
 * a shell list) is sent as one id. The API answers all of them with `{}` —
 * indistinguishable from "no such station". Several ids are separate list entries.
 */
export const stationIdProblem: Problem<unknown> = (id) => {
  if (typeof id !== "string" || id.trim() === "" || id.includes(",")) {
    return `expected a non-blank id without commas, got ${quoteId(id)}.`;
  }
  if (/[\s;\u0000-\u001f\u007f-\u009f]/.test(id)) {
    return `expected one id, got ${quoteId(id)}: a station id has no spaces, line breaks, ";" or control characters (give several ids as separate entries).`;
  }
  return undefined;
};

/** An id as an error message shows it: JSON-quoted (control characters escaped), at most 50 characters. */
function quoteId(id: unknown): string {
  if (id === null || id === undefined || typeof id === "number" || typeof id === "boolean") return String(id);
  if (typeof id !== "string") return `a ${typeof id}`;
  // JSON.stringify escapes C0 controls but not DEL or C1 (U+0080–U+009F, which terminals may act on).
  return JSON.stringify(id.length > 50 ? `${id.slice(0, 50)}…` : id).replace(
    /[\u007f-\u009f]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * A rule for a base URL whose client adds a fixed version segment itself (`/v30`
 * for the live web service, `/v16` for the static bucket). The hosts are documented
 * with that segment, so passing the documented address would request `/v30/v30/...`
 * (a 404) or `/v16/v16/...` (S3 answers a missing key with 403, which reads like an
 * outage). The reason names the value to use instead, with the user name and password
 * of a URL that has them shown as `***` ({@link redactUrl}: `https://***@proxy/api`),
 * so the hint keeps the login in place without printing it. A value that does not
 * parse is left to {@link baseUrlProblem}.
 */
export function serviceBaseUrlProblem(segment: string): Problem<unknown> {
  return (value) => {
    if (typeof value !== "string") return undefined;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return undefined;
    }
    const path = url.pathname.replace(/\/+$/, "");
    if (!path.endsWith(segment)) return undefined;
    const prefix = path.slice(0, -segment.length);
    url.pathname = prefix === "" ? "/" : prefix;
    url.search = "";
    url.hash = "";
    // The shared redaction turns any userinfo into `***@`; no trailing slash for a bare host.
    const shown = redactUrl(url.href);
    const suggestion = prefix === "" ? shown.replace(/\/$/, "") : shown;
    return `Leave out ${segment}: the client adds ${segment} itself (try ${suggestion}).`;
  };
}
