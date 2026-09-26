import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { DwdClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";

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

test("station-overview rejects a comma-only --id instead of injecting empty slots", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["station-overview", "--id", "10865", "--id", ","], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /must not be empty/);
});

test("station-overview trims padded --id values and splits comma lists", async () => {
  const cli = makeCli(() => jsonResponse({ "10865": {} }));
  const code = await run(["station-overview", "--id", " 10865 , 99999 "], cli.deps);
  assert.equal(code, 0);
  assert.equal(new URL(cli.mt.last().url).searchParams.get("stationIds"), "10865,99999");
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

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = { time: 1, warnings: [{ headline: `Sturm${controls}`, event: String.fromCharCode(0x1b) + "[31m" }] };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "warnings", "nowcast"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) => c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f);
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Sturm\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
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

test("subcommand help lists the global options that apply to it", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["help", "station-overview"], cli.deps), 0);
  const help = cli.out.join("\n");
  assert.match(help, /Global Options:/);
  assert.match(help, /--base-url/);
  assert.match(help, /--user-agent/);
});

test("--timeout accepts up to the largest timer Node supports and rejects more", async () => {
  const { MAX_TIMEOUT_MS } = await import("../src/client/index.js");
  assert.equal(MAX_TIMEOUT_MS, 2_147_483_647);

  const cli = makeCli(() => jsonResponse({ "10865": {} }));
  assert.equal(await run(["--timeout", "2147483647", "station-overview", "--id", "10865"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse({ "10865": {} }));
  assert.notEqual(await run(["--timeout", "2147483648", "station-overview", "--id", "10865"], over.deps), 0);
  assert.equal(over.mt.calls.length, 0);
  assert.match(over.err.join("\n"), /2147483647/);
});

test("a non-http(s) or malformed --base-url / --static-base-url is a usage error before any request", async () => {
  const cases: Array<[string, string[]]> = [
    ["--base-url", ["station-overview", "--id", "10865"]],
    ["--static-base-url", ["warnings", "gemeinde"]],
  ];
  for (const [option, command] of cases) {
    for (const bad of ["file:///etc/passwd", "ftp://example.org", "notaurl"]) {
      const cli = makeCli(() => jsonResponse({}));
      const code = await run([option, bad, ...command], cli.deps);
      assert.equal(code, 2, `${option} ${bad} should exit 2`);
      assert.equal(cli.mt.calls.length, 0, `${option} ${bad} must not reach the transport`);
      assert.match(cli.err.join("\n"), new RegExp(`option '${option} <url>' argument`));
    }
  }
});

test("--max-retries is bounded to 0..10", async () => {
  for (const [value, ok] of [["0", true], ["10", true], ["11", false], ["1000000", false]] as const) {
    const cli = makeCli(() => jsonResponse({ "10865": {} }));
    const code = await run(["--max-retries", value, "station-overview", "--id", "10865"], cli.deps);
    assert.equal(code, ok ? 0 : 2, value);
    if (!ok) assert.match(cli.err.join("\n"), /Must be <= 10\./);
  }
});

test("leaf commands reject extra positional arguments instead of ignoring them", async () => {
  const cases = [
    ["warnings", "nowcast", "en"],
    ["warnings", "gemeinde", "x"],
    ["warnings", "coast", "x"],
    ["crowd", "extra"],
    ["station-overview", "--id", "1", "extra"],
  ];
  for (const argv of cases) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0, argv.join(" "));
    assert.match(cli.err.join("\n"), /too many arguments/, argv.join(" "));
  }
});

test("a --base-url / --static-base-url with a query, fragment or surrounding whitespace is a usage error", async () => {
  const cases: Array<[string, string[]]> = [
    ["--base-url", ["station-overview", "--id", "10865"]],
    ["--static-base-url", ["crowd"]],
  ];
  for (const [option, command] of cases) {
    for (const [bad, message] of [
      ["http://127.0.0.1:1/ok?x=1", /query \(\?\) or fragment \(#\)/],
      ["http://127.0.0.1:1/echo#frag", /query \(\?\) or fragment \(#\)/],
      ["http://127.0.0.1:1/?", /query \(\?\) or fragment \(#\)/],
      [" http://127.0.0.1:1/", /surrounding whitespace/],
    ] as const) {
      const cli = makeCli(() => jsonResponse({}));
      assert.equal(await run([option, bad, ...command], cli.deps), 2, `${option} ${bad}`);
      assert.equal(cli.mt.calls.length, 0);
      assert.match(cli.err.join("\n"), message);
    }
  }
  const ok = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--static-base-url", "https://mirror.test/prefix/", "crowd"], ok.deps), 0);
  assert.equal(ok.mt.last().url, "https://mirror.test/prefix/v16/crowd_meldungen_overview_v2.json");
});

test("a base URL ending in the version segment the CLI adds is a usage error with a hint", async () => {
  const live = makeCli(() => jsonResponse({}));
  assert.equal(
    await run(["--base-url", "https://app-prod-ws.warnwetter.de/v30", "station-overview", "--id", "10865"], live.deps),
    2,
  );
  assert.equal(live.mt.calls.length, 0);
  assert.match(
    live.err.join("\n"),
    /Leave out \/v30: the CLI adds \/v30 itself \(try https:\/\/app-prod-ws\.warnwetter\.de\)\./,
  );

  const bucket = makeCli(() => jsonResponse({}));
  assert.equal(
    await run(
      ["--static-base-url", "https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16/", "crowd"],
      bucket.deps,
    ),
    2,
  );
  assert.equal(bucket.mt.calls.length, 0);
  assert.match(
    bucket.err.join("\n"),
    /Leave out \/v16: the CLI adds \/v16 itself \(try https:\/\/s3\.eu-central-1\.amazonaws\.com\/app-prod-static\.warnwetter\.de\)\./,
  );

  // The other host's segment is not special: /v16 on the live URL is just a prefix.
  const other = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--base-url", "https://mirror.test/v16", "station-overview", "--id", "1"], other.deps), 0);
  assert.equal(new URL(other.mt.last().url).pathname, "/v16/v30/stationOverviewExtended");
});

test("--user-agent rejects a blank or unsendable value as a usage error, before any request", async () => {
  for (const [bad, message] of [
    ["", /Expected a non-empty value\./],
    ["   ", /Expected a non-empty value\./],
    ["a\r\nX-Evil: 1", /Value contains control characters\./],
    ["a" + String.fromCharCode(0x7f), /Value contains control characters\./],
    ["\u{1F600}", /Value contains characters outside Latin-1 \(above U\+00FF\)\./],
  ] as const) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run(["--user-agent", bad, "crowd"], cli.deps), 2, JSON.stringify(bad));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), message);
  }
  const ok = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--user-agent", "my\ttool/1.0 (München)", "crowd"], ok.deps), 0);
  assert.equal(ok.mt.last().headers?.["User-Agent"], "my\ttool/1.0 (München)");
});

test("a deeply nested response fails pretty-printing cleanly and still prints with --compact", async () => {
  const depth = 200_000;
  const deep = () => rawResponse("[".repeat(depth) + "]".repeat(depth), "application/json");
  const pretty = makeCli(deep);
  assert.equal(await run(["crowd"], pretty.deps), 1);
  assert.deepEqual(pretty.out, []);
  assert.equal(pretty.err.join("\n"), "Error: The response is nested too deeply to pretty-print; try --compact.");

  // Compact serialisation goes much deeper (it prints this one on current Node);
  // should a runtime's stack still be too small, it must fail just as cleanly.
  const compact = makeCli(deep);
  const code = await run(["--compact", "crowd"], compact.deps);
  if (code === 0) assert.equal(compact.out.join("").length, 2 * depth);
  else assert.equal(compact.err.join("\n"), "Error: The response is nested too deeply to print.");
});
