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

import { LangValues, type Lang } from "./enums.js";
import { DwdValidationError, cutForMessage, quoteValue, redactUrl } from "./errors.js";

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
    return `Unsupported scheme "${cutForMessage(url.protocol)}". Expected an http(s) URL.`;
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

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which URLSearchParams would send as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks. Such a value reads
 * as "no filter" upstream, or matches nothing, so it is refused as blank.
 */
function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is an id, a code, an
 * enum value: a value the API compares exactly. The rules apply to the value with surrounding
 * whitespace trimmed, as it is sent ({@link normalizeToken}): not blank (and not only invisible
 * characters or combining marks), no lone surrogate, and no control or format character at all
 * (a zero-width space, a word joiner, a soft hyphen, a byte order mark, a bidi control), since an
 * invisible character in an id only ever makes it match nothing — for a station id, the API's
 * `{}`, which reads as "no such station". The reason quotes the value visibly ({@link quoteValue}).
 */
export function tokenProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/** A token as it is sent: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * The items of a comma-separated list option (`--id 10865,10147`), as typed: each item is checked
 * (`listProblem`) and canonicalised (`normalizeToken`) on its own, so `"a1, a2"` sends `a2`, and
 * `"a1,,a2"`, `"a1,"` and `","` are refused rather than sent as an empty item.
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be sent as a list, or undefined when it can: not an array of strings, no
 * item at all, or an item that `itemProblem` refuses (by default {@link tokenProblem}: a blank
 * item is refused, never dropped). The reason names the item (`item 2 of 3: …`).
 */
export function listProblem(items: readonly string[], itemProblem: Problem<string> = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i] as string);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
}

/**
 * The feed language must be one of {@link LangValues} (`de`, `en`), exactly: the client picks
 * the feed file by it, and any other value would silently serve the German feed. The reason
 * quotes a refused value visibly.
 */
export const langProblem: Problem<unknown> = (value) =>
  (LangValues as readonly unknown[]).includes(value)
    ? undefined
    : `expected one of ${LangValues.join(", ")}, got ${quoteId(value)}.`;

/** `lang` checked with {@link langProblem}: the value, or a DwdValidationError ("Invalid lang: …"). */
export function assertLang(lang: unknown): Lang {
  return assertValid("lang", lang, langProblem) as Lang;
}

/**
 * Station ids in canonical form: each id trimmed (`" 10865 "` -> `"10865"`) and in
 * Unicode NFC ({@link normalizeToken}), so a padded id is not sent as `stationIds=%2010865%20`,
 * which the API may drop like an unknown station. Idempotent; a non-string entry is left for the
 * validator.
 */
export function normalizeStationIds(stationIds: readonly unknown[]): unknown[] {
  return stationIds.map((id) => (typeof id === "string" ? normalizeToken(id) : id));
}

/**
 * A station id (after {@link normalizeStationIds}) must be a non-blank string
 * without commas, whitespace, semicolons, control or invisible characters ({@link tokenProblem}).
 * A blank id or a comma would send an empty slot in `stationIds` (`stationIds=` or `1,,2`); a
 * list joined with spaces, newlines or `;` (`"10865 10147"`, what `--id "$IDS"` gives for
 * a shell list) is sent as one id; a zero-width space or a word joiner copied along from a web
 * page makes a real id unknown. The API answers all of them with `{}` — indistinguishable from
 * "no such station". Several ids are separate list entries. A refused id is quoted visibly.
 */
export const stationIdProblem: Problem<unknown> = (id) => {
  if (typeof id !== "string" || isBlank(id) || id.includes(",")) {
    return `expected a non-blank id without commas, got ${quoteId(id)}.`;
  }
  if (/[\s;]/.test(id.trim())) {
    return `expected one id, got ${quoteId(id)}: a station id has no spaces, line breaks, ";" or control characters (give several ids as separate entries).`;
  }
  return tokenProblem(id);
};

/** A value as an error message shows it: a string quoted visibly ({@link quoteValue}), anything else by its value or type. */
function quoteId(value: unknown): string {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return `a ${typeof value}`;
  return quoteValue(value);
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
    return `Leave out ${segment}: the client adds ${segment} itself (try ${cutForMessage(suggestion)}).`;
  };
}
