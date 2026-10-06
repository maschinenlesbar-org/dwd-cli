import type { Command } from "commander";
import { InvalidArgumentError, Option } from "commander";
import type { CliDeps } from "../io.js";
import { action, addHelpCommand, renderJson, helpOrUnknownCommand } from "../shared.js";
import { LangValues, type Lang } from "../../client/enums.js";
import { missingStationIds } from "../../client/client.js";

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
 * itself be a list — comma-separated (the exact form the API expects) or
 * whitespace-separated (what `--id "$IDS"` gives for a shell list or a file of ids) —
 * so split on commas and whitespace — the one argv-specific step — and reject an empty
 * comma segment up front, so a stray `--id ""` *or* `--id ","` is a usage error
 * instead of the empty `stationIds=` slots the library rejects. The id rules
 * themselves (trimmed, no `;` or control characters) belong to the library
 * (`client.weather.stationOverview`).
 */
function collectStationId(value: string, previous: string[] = []): string[] {
  const ids = value.split(",");
  if (ids.some((id) => id.trim() === "")) {
    throw new InvalidArgumentError("A station id must not be empty.");
  }
  return previous.concat(ids.flatMap((id) => id.trim().split(/\s+/)));
}

export function registerWeatherCommands(program: Command, deps: CliDeps): void {
  program
    .command("station-overview")
    .description("Forecasts/observations for one or more DWD station ids")
    .requiredOption("--id <stationId>", "DWD station id (repeatable; a comma- or space-separated list works too) (required)", collectStationId)
    .action(
      action(deps, "ws", async ({ client, global, opts }) => {
        const ids = opts["id"] as string[];
        const overview = await client.weather.stationOverview(ids);
        renderJson(deps, global, overview);
        // The API leaves an unknown id out of its answer (200, `{}` for one id): say so.
        const missing = missingStationIds(ids, overview);
        if (missing.length > 0) {
          const which = missing.length === 1 ? `station id ${missing[0]}` : `station ids ${missing.join(", ")}`;
          deps.io.err(`note: no data for ${which} — the API answers an unknown id with nothing, not an error`);
        }
      }),
    );

  program
    .command("crowd")
    .description("Crowd-sourced weather reports overview")
    .action(
      action(deps, "static", async ({ client, global }) => {
        renderJson(deps, global, await client.crowd());
      }),
    );

  const warnings = program
    .command("warnings")
    .description(`Published warning feeds (pass --lang ${LangValues.join("|")} to a subcommand, default de)`)
    .helpCommand(false)
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
      action(deps, "static", async ({ client, global, opts }) => {
        renderJson(deps, global, await client.warnings.nowcast(opts["lang"] as Lang));
      }),
    );

  warnings
    .command("gemeinde")
    .description("Municipality-level warnings")
    .addOption(langOption())
    .action(
      action(deps, "static", async ({ client, global, opts }) => {
        renderJson(deps, global, await client.warnings.gemeinde(opts["lang"] as Lang));
      }),
    );

  warnings
    .command("coast")
    .description("Coastal warnings (keyed by coastal zone)")
    .addOption(langOption())
    .action(
      action(deps, "static", async ({ client, global, opts }) => {
        renderJson(deps, global, await client.warnings.coast(opts["lang"] as Lang));
      }),
    );

  addHelpCommand(warnings);
  // Let a stray token reach the group's action above (reported as an unknown
  // command). Set only after the leaves exist, which would otherwise inherit it
  // and silently ignore extra arguments (`warnings nowcast en`).
  warnings.allowExcessArguments(true);
}
