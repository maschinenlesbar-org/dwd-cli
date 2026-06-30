import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { DwdClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

function makeCli(responder: (req: HttpRequest) => HttpResponse) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
    createClient: (opts) => new DwdClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

test("station-overview joins repeated --id into stationIds", async () => {
  const cli = makeCli(() => jsonResponse({ "10865": {} }));
  const code = await run(
    ["station-overview", "--id", "10865", "--id", "01766"],
    cli.deps,
  );
  assert.equal(code, 0);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.pathname, "/v30/stationOverviewExtended");
  assert.equal(url.searchParams.get("stationIds"), "10865,01766");
});

test("station-overview requires at least one --id", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["station-overview"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
});

test("warnings nowcast --lang en uses the _en feed on the static host", async () => {
  const cli = makeCli(() => jsonResponse({ time: 1, warnings: [] }));
  await run(["warnings", "nowcast", "--lang", "en"], cli.deps);
  const url = new URL(cli.mt.last().url);
  assert.equal(url.host, "s3.eu-central-1.amazonaws.com");
  assert.match(url.pathname, /warnings_nowcast_en\.json$/);
});

test("warnings rejects an invalid lang as a usage error (exit 2) before any request", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["warnings", "nowcast", "--lang", "fr"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /option '--lang <lang>' argument 'fr' is invalid/);
});

test("--static-base-url overrides the static host", async () => {
  const cli = makeCli(() => jsonResponse({ time: 1, warnings: [] }));
  await run(["--static-base-url", "https://example.test", "warnings", "gemeinde"], cli.deps);
  assert.equal(new URL(cli.mt.last().url).host, "example.test");
});

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({}, 404));
  const code = await run(["crowd"], cli.deps);
  assert.equal(code, 4);
});

test("an unknown command says 'unknown command', not 'too many arguments'", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["bogus"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /unknown command 'bogus'/);
  assert.equal(cli.out.length, 0);
});

test("an unknown warnings subcommand says 'unknown command'", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["warnings", "nowcst"], cli.deps);
  assert.equal(code, 2);
  assert.match(cli.err.join("\n"), /unknown command 'nowcst'/);
});

test("bare program prints help to stdout and exits 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.out.join("\n"), /Usage: dwd/);
  assert.equal(cli.err.length, 0);
});

test("bare warnings group prints help to stdout and exits 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["warnings"], cli.deps);
  assert.equal(code, 0);
  assert.match(cli.out.join("\n"), /Usage: dwd warnings/);
  assert.equal(cli.err.length, 0);
});

test("the help command works for the program and a subcommand", async () => {
  const root = makeCli(() => jsonResponse({}));
  assert.equal(await run(["help"], root.deps), 0);
  assert.match(root.out.join("\n"), /Usage: dwd/);

  const group = makeCli(() => jsonResponse({}));
  assert.equal(await run(["help", "warnings"], group.deps), 0);
  assert.match(group.out.join("\n"), /Usage: dwd warnings/);
});
