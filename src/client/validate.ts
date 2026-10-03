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

import { DwdValidationError } from "./errors.js";

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
 * the transport sends it as Basic auth, for a proxy or mirror behind a login.
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
  return undefined;
};

/**
 * Station ids in canonical form: each id trimmed (`" 10865 "` -> `"10865"`), so a
 * padded id is not sent as `stationIds=%2010865%20`, which the API may drop like an
 * unknown station. Idempotent; a non-string entry is left for the validator.
 */
export function normalizeStationIds(stationIds: readonly unknown[]): unknown[] {
  return stationIds.map((id) => (typeof id === "string" ? id.trim() : id));
}

/**
 * A station id (after {@link normalizeStationIds}) must be a non-blank string
 * without commas: a blank id or a comma would send an empty slot in `stationIds`
 * (`stationIds=` or `1,,2`), which the API answers with `{}` — indistinguishable
 * from "no such station".
 */
export const stationIdProblem: Problem<unknown> = (id) =>
  typeof id !== "string" || id.trim() === "" || id.includes(",")
    ? `expected a non-blank id without commas, got ${JSON.stringify(id)}.`
    : undefined;

/**
 * A rule for a base URL whose client adds a fixed version segment itself (`/v30`
 * for the live web service, `/v16` for the static bucket). The hosts are documented
 * with that segment, so passing the documented address would request `/v30/v30/...`
 * (a 404) or `/v16/v16/...` (S3 answers a missing key with 403, which reads like an
 * outage). The reason names the value to use instead. A value that does not parse
 * is left to {@link baseUrlProblem}.
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
    // (url.origin carries no userinfo, so nothing secret is echoed.)
    const suggestion = `${url.origin}${path.slice(0, -segment.length)}`;
    return `Leave out ${segment}: the client adds ${segment} itself (try ${suggestion}).`;
  };
}
