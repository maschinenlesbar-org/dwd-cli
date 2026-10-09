// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { DwdClient, DEFAULT_STATIC_BASE_URL, STATIC_VERSION, WS_VERSION } from "../client/client.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { MAX_RETRIES } from "../client/engine.js";
import { addHelpCommand, parseServiceBaseUrl, parseBoundedInt, parseHeaderValue, parseIntArg, helpOrUnknownCommand } from "./shared.js";
import { registerWeatherCommands } from "./commands/weather.js";
import { DEFAULT_LOG_FORMAT, logFormatProblem } from "./log.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr/filesystem. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new DwdClient(options),
};

/** commander value-parser for `--log-format`. */
function parseLogFormat(value: string): string {
  const problem = logFormatProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("dwd")
    .description(
      "CLI for the open DWD Warnwetter app API — station forecasts " +
        "(app-prod-ws.warnwetter.de) and the published warning feeds (S3 static bucket).",
    )
    // The global options genuinely apply after a subcommand, so surface them in
    // every subcommand's --help (as a "Global Options:" section) rather than only
    // on the root, matching the README's promise that they apply to every command.
    .configureHelp({ showGlobalOptions: true })
    .version(VERSION)
    .option(
      "--base-url <url>",
      `live web-service base URL, without ${WS_VERSION} (the client adds it)`,
      parseServiceBaseUrl(WS_VERSION),
      "https://app-prod-ws.warnwetter.de",
    )
    .option(
      "--static-base-url <url>",
      `static (S3) bucket base URL, without ${STATIC_VERSION} (the client adds it)`,
      parseServiceBaseUrl(STATIC_VERSION),
      DEFAULT_STATIC_BASE_URL,
    )
    .option("--timeout <ms>", "time limit per request in milliseconds, whole response included (0 = no timeout)", parseBoundedInt(0, MAX_TIMEOUT_MS), 30_000)
    .option("--user-agent <ua>", "User-Agent header value", parseHeaderValue)
    .option(
      "--max-retries <n>",
      "retries for transient 429/503 responses (0..10; each waits the server's Retry-After, up to 30 s)",
      parseBoundedInt(0, MAX_RETRIES),
      2,
    )
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; 100 MiB)",
      parseIntArg,
      100 * 1024 * 1024,
    )
    .option(
      "--log-format <format>",
      `how errors, warnings and notes are written to stderr: text (log4j style: time, level, [topic], message) or jsonl (one JSON object per line: ts, level, topic, msg); default ${DEFAULT_LOG_FORMAT}`,
      parseLogFormat,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    // No whole help after an error: a single bad flag should print a focused error,
    // not dump the whole command listing. run.ts's configureTree adds a one-line
    // pointer instead (`(run "dwd crowd --help" for usage)`); `--help` exits 0.
    // The `help [command]` subcommand is added below by addHelpCommand (commander's
    // built-in one dumps the whole help to stderr for an unknown name).
    .helpCommand(false)
    // Bare `dwd` is a "what can I do" gesture: print top-level help to stdout and
    // exit 0. An unrecognized token (`dwd bogus`, a misplaced `dwd nowcast`) is
    // reported as an unknown command (exit 2).
    .action(function (this: Command) {
      helpOrUnknownCommand(this);
    });

  registerWeatherCommands(program, deps);
  addHelpCommand(program);
  // Let a stray token through the root's arity check so the action above can
  // report it as an unknown command rather than "too many arguments". Set after
  // the subcommands exist: commander copies this setting into every command
  // created later, and a leaf (`crowd extra`, `warnings nowcast en`) must keep
  // rejecting excess arguments instead of silently ignoring them.
  program.allowExcessArguments(true);

  return program;
}
