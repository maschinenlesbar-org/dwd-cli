import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { renderJson } from "../src/cli/shared.js";
import { DwdClient } from "@maschinenlesbar.org/dwd-client/internal/client";
import { credentialsIn } from "@maschinenlesbar.org/dwd-client/internal/errors";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/dwd-client/internal/http";
import { makeMockTransport, jsonResponse, rawResponse, untimed } from "./helpers.js";

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
    assert.deepEqual(JSON.parse(text), { ...served, staleFeed: true }); // time 1 is 1970
  }
});

test("bidi controls in server data are escaped in the JSON output, so they can't reorder the terminal", async () => {
  // U+202E (right-to-left override) turned "Sturm" + "‮mrofnietS" into a spoofed line on screen.
  const bidi = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
  const served = { time: 1, warnings: [{ headline: `Sturm${String.fromCharCode(0x202e)}gnunraW`, all: String.fromCharCode(...bidi) }] };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "warnings", "nowcast"], cli.deps), 0);
    const text = cli.out.join("\n");
    assert.match(text, /Sturm\\u202egnunraW/, format.join(" "));
    assert.deepEqual([...text].filter((c) => bidi.includes(c.charCodeAt(0))), [], format.join(" "));
    assert.deepEqual(JSON.parse(text), { ...served, staleFeed: true });
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

test("an unknown command close to a real one gets commander's suggestion", async () => {
  for (const [argv, hint] of [[["crowdd"], "crowd"], [["warnings", "nowcst"], "nowcast"], [["station-overviewx"], "station-overview"]] as const) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run([...argv], cli.deps), 2, argv.join(" "));
    assert.match(cli.err.join("\n"), new RegExp(`unknown command '${argv[argv.length - 1]}'\\n?.*\\(Did you mean ${hint}\\?\\)`), cli.err.join("\n"));
    assert.equal(cli.mt.calls.length, 0);
  }
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
  const { MAX_TIMEOUT_MS } = await import("@maschinenlesbar.org/dwd-client");
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
  const ok = makeCli(() => jsonResponse({ meldungen: [] }));
  assert.equal(await run(["--static-base-url", "https://mirror.test/prefix/", "crowd"], ok.deps), 0);
  assert.equal(ok.mt.last().url, "https://mirror.test/prefix/v16/crowd_meldungen_overview_v2.json");
});

test("a base URL ending in the version segment the client adds is a usage error with a hint", async () => {
  const live = makeCli(() => jsonResponse({}));
  assert.equal(
    await run(["--base-url", "https://app-prod-ws.warnwetter.de/v30", "station-overview", "--id", "10865"], live.deps),
    2,
  );
  assert.equal(live.mt.calls.length, 0);
  assert.match(
    live.err.join("\n"),
    /Leave out \/v30: the client adds \/v30 itself \(try https:\/\/app-prod-ws\.warnwetter\.de\)\./,
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
    /Leave out \/v16: the client adds \/v16 itself \(try https:\/\/s3\.eu-central-1\.amazonaws\.com\/app-prod-static\.warnwetter\.de\)\./,
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
  const ok = makeCli(() => jsonResponse({ meldungen: [] }));
  assert.equal(await run(["--user-agent", "my\ttool/1.0 (München)", "crowd"], ok.deps), 0);
  assert.equal(ok.mt.last().headers?.["User-Agent"], "my\ttool/1.0 (München)");
});

test("an answer nested too deeply is a clean error; it suggests --compact only where --compact prints it (D7)", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't. Whether
  // the compact printer can depends on the Node version (iterative from Node 26) and the stack:
  // probed here, never assumed.
  const depth = 200_000;
  const body = `{"meldungen":${"[".repeat(depth)}${"]".repeat(depth)}}`;
  let compactPrints = true;
  try {
    JSON.stringify(JSON.parse(body));
  } catch {
    compactPrints = false;
  }
  const deep = () => rawResponse(body, "application/json");
  const pretty = makeCli(deep);
  assert.equal(await run(["crowd"], pretty.deps), 1);
  assert.deepEqual(pretty.out, []);
  assert.equal(
    untimed(pretty.err.join("\n")),
    `ERROR [dwd.output] The answer is nested too deeply to pretty-print${compactPrints ? "; try --compact" : ""}.`,
  );
  const compact = makeCli(deep);
  assert.equal(await run(["--compact", "crowd"], compact.deps), compactPrints ? 0 : 1);
  if (compactPrints) assert.equal(compact.out.join(""), body);
  else assert.equal(untimed(compact.err.join("\n")), "ERROR [dwd.output] The answer is nested too deeply to print.");
});

test("an answer too large to print is called too large, not too deep; the hint only where --compact prints (D7)", (t) => {
  const { deps } = makeCli(() => jsonResponse({}));
  const real = JSON.stringify;
  // V8's own error for a text past its longest string, stood in for: a real one needs 512 MB.
  const tooLarge = (gap: unknown): boolean => gap === 2 || gap === "big";
  t.mock.method(JSON, "stringify", (value: unknown, replacer: never, gap: unknown) => {
    if (tooLarge(gap) || (gap === undefined && (value as { all?: boolean }).all === true)) throw new RangeError("Invalid string length");
    return real(value, replacer, gap as number);
  });
  assert.throws(() => renderJson(deps, {}, { id: "a1" }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print; try --compact\.$/.test(err.message));
  assert.throws(() => renderJson(deps, {}, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to pretty-print\.$/.test(err.message));
  assert.throws(() => renderJson(deps, { compact: true }, { all: true }), (err: Error) =>
    /^The answer is too large \(more than \d+ characters of JSON\) to print\.$/.test(err.message));
});

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const { deps, out } = makeCli(() => jsonResponse({}));
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, { id: "a1", text: huge });
  renderJson(deps, { compact: true }, { id: "a1", x: [[["Rede"]]], text: huge.slice(1) });
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: "a1" });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});

test("a 200 body of null is a parse error (exit 7), not printed with exit 0", async () => {
  const cli = makeCli(() => rawResponse("null", "application/json"));
  assert.equal(await run(["--compact", "crowd"], cli.deps), 7);
  assert.deepEqual(cli.out, []);
  assert.equal(
    untimed(cli.err.join("\n")),
    "ERROR [dwd.api] GET https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16/crowd_meldungen_overview_v2.json: unexpected response shape: expected a JSON object with a meldungen array.",
  );
});

test("help with an unknown command name reports it as an unknown command", async () => {
  for (const argv of [["help", "bogus"], ["warnings", "help", "nope"]]) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
    assert.deepEqual(cli.out, []);
    const path = argv.length === 2 ? "dwd" : "dwd warnings";
    assert.equal(
      untimed(cli.err.join("\n")),
      `ERROR [dwd.cli] unknown command '${argv[argv.length - 1]}'\nINFO  [dwd.cli] (run "${path} --help" for usage)`,
    );
  }
  const leaf = makeCli(() => jsonResponse({}));
  assert.equal(await run(["warnings", "help", "nowcast"], leaf.deps), 0);
  assert.match(leaf.out.join("\n"), /Usage: dwd warnings nowcast/);
  assert.equal(leaf.err.length, 0);
});

test("station-overview splits a whitespace-separated --id list; a ';' list is a usage error (finding 01#3)", async () => {
  for (const [value, sent] of [
    ["10865 10147", "10865,10147"],
    ["10865\n10147", "10865,10147"],
    ["  10865\t10147 , 10400 ", "10865,10147,10400"],
  ] as const) {
    const cli = makeCli(() => jsonResponse({}));
    const code = await run(["station-overview", "--id", value], cli.deps);
    assert.equal(code, 0, cli.err.join("\n"));
    assert.equal(new URL(cli.mt.last().url).searchParams.get("stationIds"), sent);
  }
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["station-overview", "--id", "10865;10147"], cli.deps);
  assert.equal(code, 2);
  assert.match(cli.err.join("\n"), /expected one id, got "10865;10147"/);
  assert.equal(cli.mt.calls.length, 0);
});

test("P20: the cleartext warning checks the base URL of the host the command talks to", async () => {
  // A feed command talks to --static-base-url: an http one warns, an http --base-url doesn't.
  const feed = makeCli(() => jsonResponse({ meldungen: [] }));
  assert.equal(await run(["--base-url", "http://ws.example", "--static-base-url", "http://bucket.example", "crowd"], feed.deps), 0);
  assert.deepEqual(
    feed.err.map(untimed).filter((l) => l.startsWith("WARN ")),
    ["WARN  [dwd.http] requests to bucket.example are sent unencrypted (http:, not https:)"],
  );
  // station-overview talks to --base-url: an http --static-base-url alone doesn't warn.
  const ws = makeCli(() => jsonResponse({ "10865": {} }));
  assert.equal(await run(["--static-base-url", "http://bucket.example", "station-overview", "--id", "10865"], ws.deps), 0);
  assert.deepEqual(ws.err.map(untimed).filter((l) => l.startsWith("WARN ")), []);
});

test("station-overview notes unknown ids on stderr; stdout and exit code are unchanged", async () => {
  const one = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--compact", "station-overview", "--id", "99999"], one.deps), 0);
  assert.deepEqual(one.out, ["{}"]);
  assert.deepEqual(one.err.map(untimed), ["INFO  [dwd.api] no data for station id 99999 — the API answers an unknown id with nothing, not an error"]);

  const mixed = makeCli(() => jsonResponse({ "10865": { days: [] } }));
  assert.equal(await run(["station-overview", "--id", "10865,99999", "--id", "88888"], mixed.deps), 0);
  assert.deepEqual(mixed.err.map(untimed), ["INFO  [dwd.api] no data for station ids 99999, 88888 — the API answers an unknown id with nothing, not an error"]);

  const known = makeCli(() => jsonResponse({ "10865": { days: [] } }));
  assert.equal(await run(["station-overview", "--id", "10865"], known.deps), 0);
  assert.deepEqual(known.err, []);
});

test("warning feeds carry staleFeed; a feed older than 60 minutes gets a stderr note", async () => {
  const fresh = Date.now() - 5 * 60_000;
  const fcli = makeCli(() => jsonResponse({ time: fresh, warnings: [], binnenSee: null }));
  assert.equal(await run(["--compact", "warnings", "nowcast"], fcli.deps), 0);
  assert.deepEqual(JSON.parse(fcli.out.join("")), { time: fresh, warnings: [], binnenSee: null, staleFeed: false });
  assert.deepEqual(fcli.err, []);

  const old = Date.now() - 2 * 60 * 60_000;
  const scli = makeCli(() => jsonResponse({ time: old, warnings: {}, vorabInformation: {} }));
  assert.equal(await run(["--compact", "warnings", "coast"], scli.deps), 0);
  assert.equal(JSON.parse(scli.out.join("")).staleFeed, true);
  assert.equal(scli.err.length, 1);
  assert.match(untimed(scli.err[0]!), /^INFO  \[dwd\.api\] coast warnings: the feed was published 1[12]\d minutes ago \(time \d{4}-\d\d-\d\dT.*Z\), more than 60 minutes; /);

  // crowd is not a warning feed: no staleFeed field.
  const ccli = makeCli(() => jsonResponse({ start: 1, end: 2, meldungen: [] }));
  assert.equal(await run(["--compact", "crowd"], ccli.deps), 0);
  assert.equal("staleFeed" in JSON.parse(ccli.out.join("")), false);
});

test("the /v30 hint for --base-url keeps a login as ***@ and never prints it", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--base-url", "https://alice:s3cret@proxy.example/api/v30", "station-overview", "--id", "10865"], cli.deps);
  assert.equal(code, 2);
  assert.equal(cli.mt.calls.length, 0);
  const err = cli.err.join("\n");
  assert.match(err, /\(try https:\/\/\*\*\*@proxy\.example\/api\)/);
  assert.ok(!err.includes("s3cret") && !err.includes("alice"), err);
});

test("station-overview --decode prints real units; without it the scaled integers", async () => {
  const body = { "10865": { forecast1: { start: 1, timeStep: 3600000, temperature: [97, 32767] }, days: [{ windDirection: 2700 }] } };
  const plain = makeCli(() => jsonResponse(body));
  assert.equal(await run(["--compact", "station-overview", "--id", "10865"], plain.deps), 0);
  assert.deepEqual(JSON.parse(plain.out.join("")), { "10865": { forecast1: { start: 1, timeStep: 3600000, temperature: [97, null] }, days: [{ windDirection: 2700 }] } });
  const decoded = makeCli(() => jsonResponse(body));
  assert.equal(await run(["--compact", "station-overview", "--id", "10865", "--decode"], decoded.deps), 0);
  assert.deepEqual(JSON.parse(decoded.out.join("")), { "10865": { forecast1: { start: 1, timeStep: 3600000, temperature: [9.7, null] }, days: [{ windDirection: 270 }] } });
});

test("an a:b@c argument (a station id, a User-Agent) is neither a credential in the log nor rewritten in the JSON on stdout (L14)", async () => {
  const cli = makeCli(() => jsonResponse({ "10865": { note: "run:2026-10-09@x" } }));
  assert.equal(await run(["--user-agent", "run:2026-10-09@x", "station-overview", "--id", "10865", "--id", "a:b@c"], cli.deps), 0);
  assert.match(cli.out.join("\n"), /"note": "run:2026-10-09@x"/);
  assert.match(untimed(cli.err.join("\n")), /^INFO  \[dwd\.api\] no data for station id a:b@c /);
  const typed = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--timeout", "run:2026-10-09@x", "crowd"], typed.deps), 2);
  assert.ok(typed.err.some((line) => line.includes("'run:2026-10-09@x'")), typed.err.join("\n"));
  assert.deepEqual(credentialsIn("run:2026-10-09@x"), []);
  assert.deepEqual(credentialsIn("https://alice:pw@host"), ["alice:pw"]);
  // A base URL typed without its scheme is still read as one: its password is never echoed.
  for (const flag of ["--base-url", "--static-base-url"]) {
    const bare = makeCli(() => jsonResponse({}));
    assert.equal(await run([flag, "alice:hunter2-pw@mirror.example", "crowd"], bare.deps), 2);
    assert.ok(!bare.err.join("\n").includes("hunter2-pw"), bare.err.join("\n"));
  }
});

test("a usage error is followed by a one-line pointer to the command's help, not the whole help", async () => {
  for (const [argv, path] of [
    [["crowd", "--bogus"], "dwd crowd"],
    [["warnings", "nowcast", "--lang", "fr"], "dwd warnings nowcast"],
    [["station-overview"], "dwd station-overview"],
    [["--timeout", "x", "crowd"], "dwd"],
  ] as const) {
    const cli = makeCli(() => jsonResponse({}));
    assert.equal(await run([...argv], cli.deps), 2, argv.join(" "));
    const lines = untimed(cli.err.join("\n")).split("\n");
    assert.equal(lines.length, 2, lines.join("\n"));
    assert.match(lines[0] ?? "", /^ERROR \[dwd\.cli\] /);
    assert.equal(lines[1], `INFO  [dwd.cli] (run "${path} --help" for usage)`);
    assert.deepEqual(cli.out, []);
  }
});

test("a repeated --log-format: the last one counts, as commander reads it (L6)", async () => {
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--log-format", "text", "--log-format", "jsonl", "crowd", "--bogus"], cli.deps), 2);
  assert.equal((JSON.parse(cli.err[0] ?? "") as Record<string, unknown>)["level"], "ERROR");
});

test("an option's value that looks like --log-format sets no format, in a parse error too (finding #5, L6)", async () => {
  // commander takes "--log-format" as the User-Agent and then fails on the command "jsonl".
  const ua = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--user-agent", "--log-format", "jsonl", "crowd"], ua.deps), 2);
  assert.match(ua.err[0] ?? "", /^\S+Z ERROR \[dwd\.cli\] unknown command 'jsonl'/);
  // commander takes "--log-format=text" as the User-Agent and keeps jsonl.
  const kept = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--log-format", "jsonl", "--user-agent", "--log-format=text", "warnings", "nowcast", "--lang", "fr"], kept.deps), 2);
  assert.equal((JSON.parse(kept.err[0] ?? "") as Record<string, unknown>)["level"], "ERROR");
  // commander takes "--" as the User-Agent and then parses --log-format jsonl.
  const dashes = makeCli(() => jsonResponse({}));
  assert.equal(await run(["--user-agent", "--", "--log-format", "jsonl", "crowd", "--bogus"], dashes.deps), 2);
  assert.equal((JSON.parse(dashes.err[0] ?? "") as Record<string, unknown>)["level"], "ERROR");
});

test("a feed time no Date can hold exits 7 with an api record, not \"Unexpected error: Invalid time value\" (02 Bug 1)", async () => {
  for (const argv of [["warnings", "nowcast"], ["warnings", "gemeinde", "--lang", "en"]]) {
    const cli = makeCli(() => jsonResponse({ time: -1e20, warnings: [] }));
    assert.equal(await run(argv, cli.deps), 7, argv.join(" "));
    assert.deepEqual(cli.out, []);
    assert.match(untimed(cli.err.join("\n")), /^ERROR \[dwd\.api\] GET https:\/\/s3\.eu-central-1\.amazonaws\.com\/app-prod-static\.warnwetter\.de\/v16\/\S+: unexpected response shape: expected a numeric time \(epoch milliseconds\)\.$/);
  }
});

test("a subcommand's value option does not swallow the program's --log-format, in a parse error too (L6)", async () => {
  // commander takes the program's --log-format out of argv first; --lang is left without its value.
  const cli = makeCli(() => jsonResponse({}));
  assert.equal(await run(["warnings", "nowcast", "--lang", "--log-format", "jsonl"], cli.deps), 2);
  assert.ok(cli.err.length > 0 && cli.err.every((line) => line.startsWith("{")), cli.err.join("\n"));
  assert.match((JSON.parse(cli.err[0] ?? "") as Record<string, unknown>)["msg"] as string, /--lang <lang>' argument missing/);
});

test("a single-value option given twice is a usage error, never 'the last one wins'", async () => {
  // commander keeps the last value silently: `--timeout 1000 --timeout 0` switched the timeout off.
  for (const argv of [
    ["--timeout", "1000", "--timeout", "0", "crowd"],
    ["--timeout=1000", "crowd", "--timeout", "1000"],
    ["--base-url", "https://app-prod-ws.warnwetter.de", "--base-url", "https://app-prod-ws.warnwetter.de", "station-overview", "--id", "10865"],
    ["--static-base-url", "https://s.example", "--static-base-url=https://s.example", "crowd"],
    ["--log-format", "jsonl", "--log-format", "text", "crowd"],
    ["--user-agent", "a", "--user-agent", "b", "crowd"],
    ["--max-retries", "1", "--max-retries", "2", "crowd"],
    ["--max-response-bytes", "1", "--max-response-bytes", "2", "crowd"],
    ["warnings", "nowcast", "--lang", "de", "--lang", "en"],
  ]) {
    const cli = makeCli(() => jsonResponse({ time: 1, warnings: [], meldungen: [] }));
    assert.equal(await run(argv, cli.deps), 2, argv.join(" "));
    assert.equal(cli.mt.calls.length, 0, `${argv.join(" ")} sent a request`);
    assert.match(untimed(cli.err.join("\n")), /^ERROR \[dwd\.cli\] .*--[a-z-]+ may be given only once\./m, argv.join(" "));
  }
  // Flags may repeat, and --id is repeatable: each value adds to the list.
  const flags = makeCli(() => jsonResponse({ meldungen: [] }));
  assert.equal(await run(["--compact", "--compact", "crowd"], flags.deps), 0);
  const ids = makeCli(() => jsonResponse({ "10865": {}, "01766": {} }));
  assert.equal(await run(["station-overview", "--id", "10865", "--id", "01766", "--decode", "--decode"], ids.deps), 0);
  assert.equal(new URL(ids.mt.last().url).searchParams.get("stationIds"), "10865,01766");
});
