// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON/raw result renderers.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import type { DwdClientOptions } from "../client/client.js";

/** commander value-parser: a non-negative integer. */
export function parseIntArg(value: string): number {
  // Require a plain decimal integer literal: no sign, no whitespace, no hex
  // (`0x10`), no scientific notation (`1e3`), no decimal point. `Number()` would
  // silently accept all of those, violating the "non-negative integer" contract.
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  const n = Number(value);
  // Reject values that lose precision (above Number.MAX_SAFE_INTEGER the parsed
  // number no longer round-trips to the digits the user typed).
  if (!Number.isSafeInteger(n)) {
    throw new InvalidArgumentError(
      `Expected a non-negative integer no greater than ${Number.MAX_SAFE_INTEGER}.`,
    );
  }
  return n;
}

/**
 * Default action for a command that only groups subcommands (the root program
 * and the `warnings` group). A bare invocation prints that command's help to
 * stdout and exits 0 — the "what can I do here" gesture. An unrecognized token,
 * however, is reported as an unknown command (exit 2) rather than commander's
 * misleading "too many arguments. Expected 0 arguments" wording.
 *
 * This relies on the command calling `.allowExcessArguments()` so a stray token
 * reaches this handler (as `command.args[0]`) instead of tripping the arity
 * check first, and on `.helpCommand(true)` so `help` / `help <cmd>` still
 * dispatch to the built-in help command before this action ever runs.
 */
export function helpOrUnknownCommand(command: Command): void {
  const [unknown] = command.args;
  if (unknown !== undefined) {
    command.error(`error: unknown command '${unknown}'`, { code: "commander.unknownCommand" });
  }
  command.outputHelp();
}

export interface GlobalOptions {
  baseUrl?: string;
  staticBaseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/** Translate resolved global CLI options into client options. */
export function toClientOptions(global: GlobalOptions): DwdClientOptions {
  const options: DwdClientOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.staticBaseUrl !== undefined) options.staticBaseUrl = global.staticBaseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  deps.io.out(text);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    const client = deps.createClient(toClientOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
