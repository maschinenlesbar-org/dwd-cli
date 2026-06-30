// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { DwdClient, DEFAULT_STATIC_BASE_URL } from "../client/client.js";
import { parseIntArg, helpOrUnknownCommand } from "./shared.js";
import { registerWeatherCommands } from "./commands/weather.js";

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
    .option("--base-url <url>", "live web-service base URL", "https://app-prod-ws.warnwetter.de")
    .option("--static-base-url <url>", "static (S3) bucket base URL", DEFAULT_STATIC_BASE_URL)
    .option("--timeout <ms>", "per-request timeout in milliseconds", parseIntArg, 30_000)
    .option("--user-agent <ua>", "User-Agent header value")
    .option("--max-retries <n>", "retries for transient 429/503 responses", parseIntArg, 2)
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; 100 MiB)",
      parseIntArg,
      100 * 1024 * 1024,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    // No .showHelpAfterError(): a single bad flag should print a focused error,
    // not dump the whole top-level command listing. Users who want the listing
    // can run `--help` (which exits 0).
    .showHelpAfterError(false)
    // Keep the built-in `help` / `help <command>` command available even though
    // this command carries an action handler (commander otherwise disables it),
    // and let a stray token through the arity check so the action below can
    // report it as an unknown command rather than "too many arguments".
    .helpCommand(true)
    .allowExcessArguments()
    // Bare `dwd` is a "what can I do" gesture: print top-level help to stdout and
    // exit 0. An unrecognized token (`dwd bogus`, a misplaced `dwd nowcast`) is
    // reported as an unknown command (exit 2).
    .action(function (this: Command) {
      helpOrUnknownCommand(this);
    });

  registerWeatherCommands(program, deps);

  return program;
}
