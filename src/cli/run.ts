// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import {
  DwdApiError,
  DwdError,
  DwdNetworkError,
  DwdParseError,
  DwdValidationError,
  credentialsIn,
  redactCredentials,
} from "../client/errors.js";

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
  /**
   * A usage / argument-parse error (unknown command, bad flag, missing option), or
   * an input the library rejects with a DwdValidationError.
   */
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

/**
 * Replace the userinfo of every URL in `text` with `***`, the form `redactUrl` gives
 * (`https://user:secret@host` becomes `https://***@host`). Text-based, so it also covers
 * a URL that does not parse; a backstop behind the exact-string redaction below.
 */
export function redactUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#']*@/gi, "$1***@");
}

/**
 * `deps` with an `io` that redacts the credentials of every argument from everything it
 * prints. Commander echoes rejected values in its errors (`--base-url`,
 * `--static-base-url`, an option given a URL), and the CLI's own messages name unknown
 * commands: whatever path a credential takes to stdout or stderr, the exact userinfo (as
 * `credentialsIn` finds it, plus its JSON-escaped form) is replaced by `***`. A pattern
 * alone can't delimit a password with spaces, quotes, `#`, `?` or `/`; the exact strings
 * can. Without credentials the output passes through unchanged.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const secrets = new Set<string>();
  for (const source of [...argv, ...values]) {
    for (const secret of credentialsIn(source)) {
      secrets.add(secret);
      secrets.add(JSON.stringify(secret).slice(1, -1));
    }
  }
  if (secrets.size === 0) return deps;
  const list = [...secrets];
  const redact = (text: string): string => redactUserinfo(redactCredentials(text, list));
  return { ...deps, io: { out: (text) => deps.io.out(redact(text)), err: (text) => deps.io.err(redact(text)) } };
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  deps = withRedactedOutput(deps, argv);
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
    if (err instanceof DwdValidationError) {
      // The library rejected an input before any request: a usage error, like a
      // value commander's parsers reject.
      deps.io.err(`Error: ${err.message}`);
      return EXIT.usage;
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
