// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { Command } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { DwdClient, DEFAULT_STATIC_BASE_URL } from "../client/client.js";
import { parseIntArg } from "./shared.js";
import { registerWeatherCommands } from "./commands/weather.js";

export const VERSION = "1.0.0";

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
    .version(VERSION)
    .option("--base-url <url>", "live web-service base URL", "https://app-prod-ws.warnwetter.de")
    .option("--static-base-url <url>", "static (S3) bucket base URL", DEFAULT_STATIC_BASE_URL)
    .option("--timeout <ms>", "per-request timeout in milliseconds", parseIntArg)
    .option("--user-agent <ua>", "User-Agent header value")
    .option("--max-retries <n>", "retries for transient 429/503 responses", parseIntArg)
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      parseIntArg,
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  registerWeatherCommands(program, deps);

  return program;
}
