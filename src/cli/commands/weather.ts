import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, assertEnum, renderJson } from "../shared.js";
import { LangValues } from "../../client/enums.js";

/** commander accumulator for a repeatable string option. */
function collect(value: string, previous: string[] = []): string[] {
  return previous.concat([value]);
}

export function registerWeatherCommands(program: Command, deps: CliDeps): void {
  program
    .command("station-overview")
    .description("Forecasts/observations for one or more DWD station ids")
    .requiredOption("--id <stationId>", "DWD station id (repeatable)", collect)
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
    .description(`Published warning feeds (lang: ${LangValues.join(" | ")}, default de)`);

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
