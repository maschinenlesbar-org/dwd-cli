// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import { DwdApiError, DwdError, DwdNetworkError, DwdParseError } from "../client/errors.js";

/**
 * Process exit codes. Distinct codes let scripts tell a usage mistake from a
 * server problem and a transport failure from a malformed body. Kept in sync
 * with the "Exit codes" table in the README.
 */
export const EXIT = {
  /** Success. */
  ok: 0,
  /** A generic / unclassified error. */
  generic: 1,
  /** A usage / argument-parse error (unknown command, bad flag, missing option). */
  usage: 2,
  /** The API returned 404. */
  notFound: 4,
  /** The API returned a non-404, non-success status. */
  api: 5,
  /** A transport-level failure (DNS, connection reset, timeout, too many redirects). */
  network: 6,
  /** The response body could not be parsed as the expected JSON. */
  parse: 7,
} as const;

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
  });
  for (const child of command.commands) configureTree(child, deps);
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  const program = buildProgram(deps);
  configureTree(program, deps);

  try {
    await program.parseAsync(argv, { from: "user" });
    return EXIT.ok;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version requests carry exitCode 0; every genuine parse/usage error
      // gets the dedicated usage code so scripts can tell it apart from a
      // runtime failure (which commander would otherwise also report as 1).
      return err.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }
    if (err instanceof DwdApiError) {
      deps.io.err(`Error: ${err.message}`);
      // Map notable statuses to distinct exit codes for scripting.
      if (err.status === 404) return EXIT.notFound;
      return EXIT.api;
    }
    if (err instanceof DwdNetworkError) {
      deps.io.err(`Error: ${err.message}`);
      return EXIT.network;
    }
    if (err instanceof DwdParseError) {
      deps.io.err(`Error: ${err.message}`);
      return EXIT.parse;
    }
    if (err instanceof DwdError) {
      deps.io.err(`Error: ${err.message}`);
      return EXIT.generic;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.generic;
  }
}
