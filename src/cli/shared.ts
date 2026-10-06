// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON/raw result renderers.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { DEFAULT_STATIC_BASE_URL, type DwdClientOptions } from "../client/client.js";
import { DEFAULT_BASE_URL, cleartextProblem } from "../client/engine.js";
import { DwdError } from "../client/errors.js";
import { baseUrlProblem, headerValueProblem, nonBlankProblem, serviceBaseUrlProblem } from "../client/validate.js";

/** commander value-parser: a non-negative integer. */
export function parseIntArg(value: string): number {
  // Require a plain decimal integer literal: no sign, no whitespace, no hex
  // (`0x10`), no scientific notation (`1e3`), no decimal point. `Number()` would
  // silently accept all of those, violating the "non-negative integer" contract.
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  // Reject values that lose precision (above Number.MAX_SAFE_INTEGER the parsed
  // number no longer round-trips to the digits the user typed).
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError(
      `Expected a non-negative integer no greater than ${Number.MAX_SAFE_INTEGER}.`,
    );
  }
  return n;
}

/** commander value-parser: a value that is not blank (`""` or whitespace only). */
export function parseNonEmpty(value: string): string {
  const problem = nonBlankProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * commander value-parser for a value that ends up in an HTTP header (`--user-agent`).
 * The rule is the library's {@link headerValueProblem} — blank, control characters
 * other than tab, DEL and characters above U+00FF are rejected — so a bad value is a
 * usage error (exit 2) here, as it is a DwdValidationError in the client.
 */
export function parseHeaderValue(value: string): string {
  const problem = headerValueProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * commander value-parser for a URL-valued global option (`--base-url`,
 * `--static-base-url`). The rule is the library's {@link baseUrlProblem}: an
 * absolute `http:`/`https:` URL without a query, fragment, whitespace or control
 * characters. A bad value is a usage error (exit 2) here, as it is a
 * DwdValidationError in the client; the CLI keeps no rules of its own.
 */
export function parseBaseUrl(value: string): string {
  const problem = baseUrlProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

/**
 * Build a commander value-parser for a base URL whose client adds a fixed version
 * segment itself (`/v30` for `--base-url`, `/v16` for `--static-base-url`). The rules
 * are the library's {@link baseUrlProblem} and {@link serviceBaseUrlProblem}, so a
 * value ending in the segment is a usage error with the library's hint.
 */
export function parseServiceBaseUrl(segment: string): (value: string) => string {
  const segmentProblem = serviceBaseUrlProblem(segment);
  return (value: string) => {
    parseBaseUrl(value);
    const problem = segmentProblem(value);
    if (problem !== undefined) throw new InvalidArgumentError(problem);
    return value;
  };
}

/** Build a commander value-parser for a non-negative integer within [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    if (n > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
    return n;
  };
}

/**
 * Default action for a command that only groups subcommands (the root program
 * and the `warnings` group). A bare invocation prints that command's help to
 * stdout and exits 0 — the "what can I do here" gesture. An unrecognized token,
 * however, is reported as an unknown command (exit 2) rather than commander's
 * misleading "too many arguments. Expected 0 arguments" wording.
 *
 * This relies on the command calling `.allowExcessArguments(true)` — after its
 * subcommands are created, so they don't inherit it — so a stray token
 * reaches this handler (as `command.args[0]`) instead of tripping the arity
 * check first, and on `addHelpCommand` so `help` / `help <cmd>` still dispatch to
 * a help subcommand before this action ever runs.
 */
export function helpOrUnknownCommand(command: Command): void {
  const [unknown] = command.args;
  if (unknown !== undefined) {
    command.error(`error: unknown command '${unknown}'`, { code: "commander.unknownCommand" });
  }
  command.outputHelp();
}

/**
 * Add a `help [command]` subcommand to a command group (the root and `warnings`),
 * in place of commander's built-in one: that one prints the group's whole help to
 * stderr with no error line for an unknown name (`dwd help bogus`). This one prints
 * the group's help (bare `help`) or the named command's help to stdout, exit 0, and
 * reports an unknown name as `error: unknown command '<name>'` (usage error), like
 * `dwd bogus`. Call it after the group's other subcommands exist (it is listed
 * last) and with `.helpCommand(false)` on the group.
 */
export function addHelpCommand(parent: Command): void {
  parent
    .command("help [command]")
    .description("display help for command")
    .action((name: string | undefined) => {
      if (name === undefined) parent.help();
      const target = parent.commands.find((c) => c.name() === name || c.aliases().includes(name as string));
      if (target === undefined) {
        parent.error(`error: unknown command '${name}'`, { code: "commander.unknownCommand" });
      }
      (target as Command).help();
    });
}

export interface GlobalOptions {
  baseUrl?: string;
  staticBaseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/** Translate resolved global CLI options into client options. */
export function toClientOptions(global: GlobalOptions): DwdClientOptions {
  const options: DwdClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.staticBaseUrl !== undefined) options.staticBaseUrl = global.staticBaseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/**
 * JSON.stringify, pretty or compact. A deeply nested value (a hostile or broken
 * response) overflows the stack — the pretty form far sooner than the compact one,
 * which is why the message suggests --compact. The RangeError becomes a DwdError so
 * the CLI prints a clear message instead of "Unexpected error: Maximum call stack
 * size exceeded".
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    return compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch (err) {
    if (err instanceof RangeError) {
      throw new DwdError(
        compact
          ? "The response is nested too deeply to print."
          : "The response is nested too deeply to pretty-print; try --compact.",
        { cause: err },
      );
    }
    throw err;
  }
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(stringifyJson(value, global.compact === true));
  deps.io.out(text);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Which of the two hosts a command talks to: the live web service (`--base-url`) or
 * the static bucket (`--static-base-url`).
 */
export type Service = "ws" | "static";

/** The effective base URL of `service`: the flag's value, else the library default. */
export function serviceBaseUrl(global: GlobalOptions, service: Service): string {
  return service === "ws" ? global.baseUrl ?? DEFAULT_BASE_URL : global.staticBaseUrl ?? DEFAULT_STATIC_BASE_URL;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Before the client is built (so before any request), the base URL of the host the
 * command talks to (`service`) is checked: plain `http:` to a remote host gets one
 * `warning: <cleartextProblem sentence>` line on stderr. The other base URL is not
 * contacted and not checked. An action runs once per run, so the warning does too;
 * help, version and usage errors never reach an action and never warn.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  service: Service,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    const cleartext = cleartextProblem(serviceBaseUrl(global, service));
    if (cleartext !== undefined) deps.io.err(`warning: ${cleartext}`);
    const client = deps.createClient(toClientOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
