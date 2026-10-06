import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertValid,
  baseUrlProblem,
  headerValueProblem,
  normalizeStationIds,
  serviceBaseUrlProblem,
  stationIdProblem,
  type Problem,
} from "../src/client/validate.js";
import { validateBaseUrl } from "../src/client/engine.js";
import * as lib from "../src/index.js";
import { DwdError, DwdNetworkError, DwdValidationError } from "../src/client/errors.js";
import { DwdClient } from "../src/client/client.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { parity, jsonResponse, makeMockTransport } from "./helpers.js";

const nonBlank: Problem<string> = (v) => (v.trim() === "" ? "Expected a non-empty value." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("id", "10865", nonBlank), "10865");
});

test("assertValid throws DwdValidationError 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("id", "  ", nonBlank),
    (err: unknown) =>
      err instanceof DwdValidationError &&
      err instanceof DwdError &&
      err.name === "DwdValidationError" &&
      err.message === "Invalid id: Expected a non-empty value.",
  );
});

test("the validation layer is exported from the package root", () => {
  assert.equal(lib.assertValid, assertValid);
  assert.equal(lib.DwdValidationError, DwdValidationError);
});

test("run() maps a DwdValidationError raised in an action to exit 2, 'Error: <message>'", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: () => {
      throw new DwdValidationError("Invalid thing: Expected a non-empty value.");
    },
  };
  assert.equal(await run(["crowd"], deps), 2);
  assert.deepEqual(err, ["Error: Invalid thing: Expected a non-empty value."]);
  assert.deepEqual(out, []);
});

test("run() still maps a plain DwdError to exit 1", async () => {
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: () => {}, err: (s) => err.push(s) },
    createClient: () => {
      throw new DwdError("boom");
    },
  };
  assert.equal(await run(["crowd"], deps), 1);
  assert.deepEqual(err, ["Error: boom"]);
});

test("parity() runs one input through the CLI and the library on one recording transport", async () => {
  const { cli, lib: l } = await parity(
    ["--compact", "crowd"],
    (transport) => new DwdClient({ transport }).crowd(),
    () => jsonResponse({ meldungen: [] }),
  );
  assert.equal(cli.code, 0);
  assert.equal(cli.requests.length, 1);
  assert.equal(l.ok, true);
  assert.equal(l.requests.length, 1);
  assert.equal(cli.requests[0]!.url, l.requests[0]!.url);
  assert.deepEqual(JSON.parse(cli.out), l.ok ? l.value : undefined);
});

test("headerValueProblem: blank, controls other than tab, DEL and above U+00FF have a reason", () => {
  assert.equal(headerValueProblem("my-app/1.0"), undefined);
  assert.equal(headerValueProblem("é"), undefined);
  assert.equal(headerValueProblem("a\tb"), undefined);
  assert.equal(headerValueProblem(""), "Expected a non-empty value.");
  assert.equal(headerValueProblem("   "), "Expected a non-empty value.");
  assert.equal(headerValueProblem(5), "Expected a string.");
  for (const bad of ["a\r\nb", "a\u0000b", "a\u007fb"]) {
    assert.equal(headerValueProblem(bad), "Value contains control characters.", JSON.stringify(bad));
  }
  assert.equal(headerValueProblem("€"), "Value contains characters outside Latin-1 (above U+00FF).");
});

test("DwdClient: userAgent is checked in the constructor; only an omitted one selects the default", () => {
  for (const ua of ["", "   ", "a\r\nb", "a\u007fb", "€"]) {
    assert.throws(
      () => new DwdClient({ userAgent: ua }),
      (err: unknown) => err instanceof DwdValidationError && err.message.startsWith("Invalid userAgent: "),
      JSON.stringify(ua),
    );
  }
  assert.equal(lib.headerValueProblem, headerValueProblem);
  assert.equal(typeof lib.assertHeaderValue, "function");
});

test("baseUrlProblem: the base-URL rules, in order, each with its reason", () => {
  for (const ok of ["https://app-prod-ws.warnwetter.de", "http://127.0.0.1:1/prefix/", "https://u:p@proxy.test/"]) {
    assert.equal(baseUrlProblem(ok), undefined, ok);
  }
  assert.equal(baseUrlProblem(5), "Expected a string.");
  assert.equal(baseUrlProblem(""), "Expected an absolute http(s) URL.");
  assert.equal(baseUrlProblem("   "), "Expected an absolute http(s) URL.");
  assert.equal(baseUrlProblem(" https://h.example"), "A base URL cannot have surrounding whitespace.");
  assert.equal(baseUrlProblem("https://h.example/\n"), "A base URL cannot have surrounding whitespace.");
  for (const bad of ["https://h.example/a b", "https://h.ex\tample", "https://h.example/\u0000x", "https://h/\u007fx"]) {
    assert.equal(baseUrlProblem(bad), "A base URL cannot contain whitespace or control characters.", JSON.stringify(bad));
  }
  assert.equal(baseUrlProblem("not-a-url"), "Expected an absolute http(s) URL.");
  assert.equal(baseUrlProblem("ftp://h.example"), 'Unsupported scheme "ftp:". Expected an http(s) URL.');
  for (const bad of ["https://h.example/?", "https://h.example?x=1", "https://h.example/#"]) {
    assert.equal(baseUrlProblem(bad), "A base URL cannot have a query (?) or fragment (#).", bad);
  }
});

test("validateBaseUrl strips trailing slashes and throws DwdValidationError naming the option", () => {
  assert.equal(validateBaseUrl("https://h.example/prefix//"), "https://h.example/prefix");
  assert.throws(
    () => validateBaseUrl("ftp://h.example", "staticBaseUrl"),
    (err: unknown) =>
      err instanceof DwdValidationError &&
      !(err instanceof DwdNetworkError) &&
      err.message === 'Invalid staticBaseUrl: Unsupported scheme "ftp:". Expected an http(s) URL.',
  );
  assert.equal(lib.validateBaseUrl, validateBaseUrl);
  assert.equal(lib.baseUrlProblem, baseUrlProblem);
});

test("DwdClient checks both base URLs in the constructor, before any request", () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  assert.throws(() => new DwdClient({ transport: mt.transport, baseUrl: "https://h.example/ " }), DwdValidationError);
  assert.throws(() => new DwdClient({ transport: mt.transport, staticBaseUrl: "https://h.example/?" }), DwdValidationError);
  assert.equal(mt.calls.length, 0);
});

test("normalizeStationIds trims each id and is idempotent; stationIdProblem names a bad id", () => {
  assert.deepEqual(normalizeStationIds([" 10865 ", "\t01766"]), ["10865", "01766"]);
  assert.deepEqual(normalizeStationIds(normalizeStationIds([" 10865 "])), ["10865"]);
  assert.equal(stationIdProblem("10865"), undefined);
  assert.equal(stationIdProblem(""), 'expected a non-blank id without commas, got "".');
  assert.equal(stationIdProblem("1,2"), 'expected a non-blank id without commas, got "1,2".');
  assert.equal(stationIdProblem(5), "expected a non-blank id without commas, got 5.");
  assert.equal(lib.normalizeStationIds, normalizeStationIds);
  assert.equal(lib.stationIdProblem, stationIdProblem);
});

test("stationOverview rejects a bad id list with DwdValidationError and no request", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const client = new DwdClient({ transport: mt.transport });
  for (const bad of [[], ["  "], ["10865, 10870"], ["1", ""]]) {
    await assert.rejects(() => client.weather.stationOverview(bad), DwdValidationError, JSON.stringify(bad));
  }
  assert.equal(mt.calls.length, 0);
});

test("serviceBaseUrlProblem: a path ending in the segment has a hint naming the value to use", () => {
  const v30 = serviceBaseUrlProblem("/v30");
  assert.equal(v30("https://app-prod-ws.warnwetter.de"), undefined);
  assert.equal(v30("https://h.example/v300"), undefined);
  assert.equal(v30("https://h.example/v16"), undefined);
  assert.equal(v30("not a url"), undefined); // left to baseUrlProblem
  assert.equal(v30("https://h.example/v30"), "Leave out /v30: the client adds /v30 itself (try https://h.example).");
  // A login stays in the suggestion, redacted the way every message shows it.
  assert.equal(v30("https://u:p@h.example/a/v30//"), "Leave out /v30: the client adds /v30 itself (try https://***@h.example/a).");
  assert.equal(v30("http://alice@h.example:8080/v30"), "Leave out /v30: the client adds /v30 itself (try http://***@h.example:8080).");
  assert.equal(lib.serviceBaseUrlProblem, serviceBaseUrlProblem);
  assert.equal(lib.WS_VERSION, "/v30");
  assert.equal(lib.STATIC_VERSION, "/v16");
});

test("DwdClient rejects a base URL ending in its version segment in the constructor", () => {
  assert.throws(() => new DwdClient({ baseUrl: "https://app-prod-ws.warnwetter.de/v30/" }), DwdValidationError);
  assert.throws(
    () => new DwdClient({ staticBaseUrl: "https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16" }),
    DwdValidationError,
  );
});
