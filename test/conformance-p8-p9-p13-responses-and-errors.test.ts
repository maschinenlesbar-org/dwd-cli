// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { DwdClient as Client } from "../src/client/client.js";
import {
  DwdError as BaseError,
  DwdParseError as ParseError,
  DwdValidationError as ValidationError,
} from "../src/client/errors.js";
/** A call whose answer contains a text field, and how to read that field from the result. */
const textCall = (client: Client): Promise<unknown> => client.warnings.nowcast();
const textBody = (text: string): unknown => ({ time: 1, warnings: [{ headLine: text }] });
const readText = (result: unknown): string => (result as { warnings: Array<{ headLine: string }> }).warnings[0]!.headLine;
/** 2xx bodies the call must reject (error envelopes, empty or wrong shapes). */
const malformedBodies: unknown[] = [
  null, {}, [], "text", 42, { warnings: "x" }, { error: "boom" }, { warnings: null },
  // An S3 error document as JSON, and a feed without (or with a non-numeric) time (02#1).
  { Error: { Code: "NoSuchKey" } }, { warnings: [] }, { time: "yesterday", warnings: [] },
];
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["stationOverview(5)", () => new Client().weather.stationOverview(5 as unknown as string[])],
  ["stationOverview(null)", () => new Client().weather.stationOverview(null as unknown as string[])],
  ["stationOverview([{}])", () => new Client().weather.stationOverview([{}] as unknown as string[])],
  ["stationOverview([])", () => new Client().weather.stationOverview([])],
  ["warnings.nowcast('fr')", () => new Client().warnings.nowcast("fr" as unknown as "de")],
  ["warnings.coast(5)", () => new Client().warnings.coast(5 as unknown as "de")],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["maxRedirects: 21", () => new Client({ maxRedirects: 21 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["staticBaseUrl: {}", () => new Client({ staticBaseUrl: {} as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["transport: 'x'", () => new Client({ transport: "x" as never })],
  ["sleep: 1", () => new Client({ sleep: 1 as never })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
