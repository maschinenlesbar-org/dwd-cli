import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "../io.js";
import { action, assertEnum, renderJson } from "../shared.js";
import { LangValues } from "../../client/enums.js";

/**
 * commander accumulator for a repeatable station-id option. Validates each id up
 * front so an empty or blank `--id ""` is rejected as a usage error rather than
 * being sent as an empty `stationIds=` query parameter.
 */
function collectStationId(value: string, previous: string[] = []): string[] {
  if (value.trim() === "") {
    throw new InvalidArgumentError("A station id must not be empty.");
  }
  return previous.concat([value]);
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
    .description(`Published warning feeds (lang: ${LangValues.join(" | ")}, default de)`)
    // Running the group with no subcommand is a "what can I do here" gesture, not
    // an error: print this group's help to stdout and exit 0 (like --help), rather
    // than commander's default of help-on-stderr with a non-zero exit.
    .action(function (this: Command) {
      this.outputHelp();
    });

  const lang = (opts: Record<string, unknown>) =>
    assertEnum(String(opts["lang"] ?? "de"), LangValues, "lang");

  warnings
    .command("nowcast")
    .description("Short-term (nowcast) warnings")
    .option("--lang <lang>", "de | en", "de")
    .action(
      action(deps, async ({ client, global, opts }) => {
        renderJson(deps, global, await client.warnings.nowcast(lang(opts)));
      }),
    );

  warnings
    .command("gemeinde")
    .description("Municipality-level warnings")
    .option("--lang <lang>", "de | en", "de")
    .action(
      action(deps, async ({ client, global, opts }) => {
        renderJson(deps, global, await client.warnings.gemeinde(lang(opts)));
      }),
    );

  warnings
    .command("coast")
    .description("Coastal warnings (keyed by coastal zone)")
    .option("--lang <lang>", "de | en", "de")
    .action(
      action(deps, async ({ client, global, opts }) => {
        renderJson(deps, global, await client.warnings.coast(lang(opts)));
      }),
    );
}
