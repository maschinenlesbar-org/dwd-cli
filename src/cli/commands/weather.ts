import type { Command } from "commander";
import { InvalidArgumentError, Option } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson, helpOrUnknownCommand } from "../shared.js";
import { LangValues, type Lang } from "../../client/enums.js";

/**
 * The `--lang` option, validated by commander's own `.choices()` so a bad value
 * (e.g. `--lang fr`) is a usage error (exit 2) with a clear message — the same
 * class and exit code as a bad `--timeout` — rather than a generic exit-1 error.
 */
function langOption(): Option {
  return new Option("--lang <lang>", `feed language: ${LangValues.join(" | ")}`)
    .choices([...LangValues])
    .default("de");
}

/**
 * commander accumulator for a repeatable station-id option. A single value may
 * itself be a comma-separated list (the exact form the API expects, joined in
 * client.ts), so split on commas, trim each id, and reject any empty/blank one
 * up front. This keeps a stray `--id ""` *or* `--id ","` from re-injecting the
 * empty `stationIds=` slots the validator exists to prevent (e.g.
 * `--id 10865 --id ","` would otherwise send `stationIds=10865,,`), and
 * normalises padded ids like `--id " 10865 "` instead of sending the surrounding
 * whitespace verbatim.
 */
function collectStationId(value: string, previous: string[] = []): string[] {
  const ids = value.split(",").map((id) => id.trim());
  if (ids.some((id) => id === "")) {
    throw new InvalidArgumentError("A station id must not be empty.");
  }
  return previous.concat(ids);
}

export function registerWeatherCommands(program: Command, deps: CliDeps): void {
  program
    .command("station-overview")
    .description("Forecasts/observations for one or more DWD station ids")
    .requiredOption("--id <stationId>", "DWD station id (repeatable) (required)", collectStationId)
    .action(
      action(deps, async ({ client, global, opts }) => {
        renderJson(deps, global, await client.weather.stationOverview(opts["id"] as string[]));
      }),
    );

  program
    .command("crowd")
    .description("Crowd-sourced weather reports overview")
    .action(
      action(deps, async ({ client, global }) => {
        renderJson(deps, global, await client.crowd());
      }),
    );

  const warnings = program
    .command("warnings")
    .description(`Published warning feeds (pass --lang ${LangValues.join("|")} to a subcommand, default de)`)
    .helpCommand(true)
    .allowExcessArguments()
    // Bare `dwd warnings` is a "what can I do here" gesture: print this group's
    // help to stdout and exit 0 (like --help). An unrecognized subcommand
    // (`dwd warnings nowcst`) is reported as an unknown command (exit 2) rather
    // than commander's misleading "too many arguments for 'warnings'".
    .action(function (this: Command) {
      helpOrUnknownCommand(this);
    });

  warnings
    .command("nowcast")
    .description("Short-term (nowcast) warnings")
    .addOption(langOption())
    .action(
      action(deps, async ({ client, global, opts }) => {
        renderJson(deps, global, await client.warnings.nowcast(opts["lang"] as Lang));
      }),
    );

  warnings
    .command("gemeinde")
    .description("Municipality-level warnings")
    .addOption(langOption())
    .action(
      action(deps, async ({ client, global, opts }) => {
        renderJson(deps, global, await client.warnings.gemeinde(opts["lang"] as Lang));
      }),
    );

  warnings
    .command("coast")
    .description("Coastal warnings (keyed by coastal zone)")
    .addOption(langOption())
    .action(
      action(deps, async ({ client, global, opts }) => {
        renderJson(deps, global, await client.warnings.coast(opts["lang"] as Lang));
      }),
    );
}
