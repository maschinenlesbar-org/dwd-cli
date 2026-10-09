// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import { logOf, type CliDeps } from "./io.js";
import { createLogger, logFormatFromArgv } from "./log.js";
import {
  DwdApiError,
  DwdError,
  DwdNetworkError,
  DwdParseError,
  DwdValidationError,
  credentialsIn,
  echoedCredentialForms,
  redactCredentials,
  redactSecrets,
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
function configureTree(command: Command, deps: CliDeps, state: { errorLogged: boolean } = { errorLogged: false }): void {
  command.exitOverride();
  // After a usage error commander points at the command's help in one line, rather than
  // printing the whole help: the error stays the one thing to read. Set on every
  // command, each with its own path.
  command.showHelpAfterError(`(run "${commandPath(command)} --help" for usage)`);
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => writeCommanderErr(command, deps, state, str),
  });
  for (const child of command.commands) configureTree(child, deps, state);
}

/**
 * commander's stderr output as log records, one per line. Its `error: …` is an ERROR of
 * `cli`, with a following `(Did you mean …?)` line appended to that same record; what it
 * shows after an error (here the one-line pointer to the help) is one INFO record per
 * non-blank line. Should commander show the help as an error with no `error:` line (a
 * command group run without its subcommand, which dwd answers with its help on stdout
 * instead), an ERROR record "missing command: `dwd warnings <subcommand>`" comes first,
 * so every failed run has one.
 */
function writeCommanderErr(command: Command, deps: CliDeps, state: { errorLogged: boolean }, str: string): void {
  const log = logOf(deps);
  const text = str.replace(/\n$/, "");
  // The blank line commander writes between an error and the help it shows after.
  if (text.trim() === "") return;
  if (text.startsWith("error: ")) {
    state.errorLogged = true;
    log.error("cli", text.slice("error: ".length).replace(/\n(\(Did you mean .*\?\))$/, " $1"));
    return;
  }
  if (!state.errorLogged) {
    state.errorLogged = true;
    log.error("cli", `missing command: \`${commandPath(command)} <subcommand>\``);
  }
  for (const line of text.split("\n")) if (line.trim() !== "") log.info("cli", line.trimEnd());
}

/** `dwd warnings nowcast`: the command's name with its parents'. */
function commandPath(command: Command): string {
  const names: string[] = [];
  for (let c: Command | null = command; c !== null; c = c.parent) names.unshift(c.name());
  return names.join(" ");
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
 * The options whose value is a base URL: a `user:password@host` given there without its
 * scheme is still a credential (anywhere else a bare `a:b@c` is not).
 */
const BASE_URL_FLAGS = ["--base-url", "--static-base-url"];

/** The values of the `flags` in `argv`, in both forms (`--flag value`, `--flag=value`). */
function flagValues(argv: readonly string[], flags: readonly string[]): string[] {
  const found: string[] = [];
  argv.forEach((token, i) => {
    const next = argv[i + 1];
    if (flags.includes(token) && next !== undefined) found.push(next);
    const eq = token.indexOf("=");
    if (eq > 0 && flags.includes(token.slice(0, eq))) found.push(token.slice(eq + 1));
  });
  return found;
}

/** The secrets of a run, and the two ways they are replaced. */
export interface Redaction {
  /** stdout text: the userinfo of every URL-like argument replaced (`***@`). */
  out(text: string): string;
  /** stderr text, a record's message: the same. */
  err(text: string): string;
}

/**
 * The secrets of the run in `argv`. Commander echoes rejected values in its errors
 * (`--base-url`, `--static-base-url`, an option given a URL), and the CLI's own messages
 * name unknown commands: whatever path a credential takes to stdout or stderr, the exact
 * userinfo (as `credentialsIn` finds it, plus its JSON-escaped form) is replaced by
 * `***`. A pattern alone can't delimit a password with spaces, quotes, `#`, `?` or `/`;
 * the exact strings can. Without credentials the text passes through unchanged.
 */
export function redactionFor(argv: readonly string[]): Redaction {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const secrets = new Set<string>();
  const echoed = new Set<string>();
  const passwords = new Set<string>();
  // A base URL typed without its scheme is read as if it had one.
  const baseUrls = flagValues(argv, BASE_URL_FLAGS).map((value) => (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`));
  for (const source of [...values, ...baseUrls]) {
    for (const secret of credentialsIn(source)) {
      secrets.add(secret);
      secrets.add(JSON.stringify(secret).slice(1, -1));
      // What a server echoes back: the Basic value and the decoded user:password on
      // stdout and stderr, the password alone (it may well occur in the data) on stderr.
      const [basic, pair, password] = echoedCredentialForms(secret);
      if (basic !== undefined) echoed.add(basic);
      if (pair !== undefined) echoed.add(pair);
      if (password !== undefined) passwords.add(password);
    }
  }
  if (secrets.size === 0) return { out: (text) => text, err: (text) => text };
  const list = [...secrets];
  // Longest first, so a password never leaves half of the user:password around it.
  const echoedList = [...echoed].sort((a, b) => b.length - a.length);
  const passwordList = [...passwords].sort((a, b) => b.length - a.length);
  const out = (text: string): string => redactSecrets(redactUserinfo(redactCredentials(text, list)), echoedList);
  return { out, err: (text) => redactSecrets(out(text), passwordList) };
}

/**
 * `deps` that keep the secrets of this run (`redactionFor`) out of everything they
 * print: `io.out` is redacted, and the log (`deps.log`) replaces them in each record's
 * message before formatting it, then writes to the raw `io.err`, so the frame is never
 * touched. `io.err` itself is redacted too, for anything that writes to stderr without
 * the log.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  const redaction = redactionFor(argv);
  const { out, err } = deps.io;
  return {
    ...deps,
    io: { ...deps.io, out: (text) => out(redaction.out(text)), err: (text) => err(redaction.err(text)) },
    log: createLogger({
      format: logFormatFromArgv(argv),
      write: err,
      redact: redaction.err,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  };
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  // The log replaces the secrets of the run in every message, in either format.
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
    const log = logOf(deps);
    if (err instanceof DwdValidationError) {
      // The library rejected an input before any request: a usage error, like a
      // value commander's parsers reject.
      log.error("cli", err.message);
      return EXIT.usage;
    }
    if (err instanceof DwdApiError) {
      log.error("api", err.message);
      // Map notable statuses to distinct exit codes for scripting.
      if (err.status === 404) return EXIT.notFound;
      return EXIT.api;
    }
    if (err instanceof DwdNetworkError) {
      log.error("http", err.message);
      return EXIT.network;
    }
    if (err instanceof DwdParseError) {
      log.error("cli", err.message);
      return EXIT.parse;
    }
    if (err instanceof DwdError) {
      log.error("cli", err.message);
      return EXIT.generic;
    }
    log.error("cli", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.generic;
  }
}
