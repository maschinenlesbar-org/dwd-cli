// Compile-time checks of the exported library types, and the runtime behaviour they promise.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DwdClient, RequestEngine } from "../src/index.js";
import { constantJson } from "./helpers.js";

// Runs the TypeScript compiler over a consumer file.
const STARTS_A_PROCESS = { timeout: 30_000 };
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a consumer with the strictest compiler settings can pass undefined for any option", STARTS_A_PROCESS, async () => {
  // Under exactOptionalPropertyTypes, `{ baseUrl: process.env.X }` fails to compile against an
  // option declared `?: string`, although the runtime treats undefined as omitted.
  const dir = mkdtempSync(join(tmpdir(), "dwd-types-"));
  try {
    writeFileSync(
      join(dir, "use.ts"),
      [
        `import { DwdClient, RequestEngine, type DwdClientOptions, type EngineOptions } from ${JSON.stringify(INDEX)};`,
        "declare function allUndefined<T>(): { [K in keyof T]-?: undefined };",
        "export const options: EngineOptions = allUndefined<EngineOptions>();",
        "export const clientOptions: DwdClientOptions = allUndefined<DwdClientOptions>();",
        "export const client = new DwdClient({ baseUrl: process.env.DWD_BASE_URL, staticBaseUrl: process.env.DWD_STATIC_BASE_URL, timeoutMs: 15_000 });",
        "export const engine = new RequestEngine({ userAgent: process.env.DWD_USER_AGENT });",
        "export const raw = () => engine.request(\"GET\", \"/x\", { query: undefined, accept: \"application/json\" });",
        "export const nowcast = async (): Promise<number> => (await client.warnings.nowcast(\"de\")).time;",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const result = await new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: stdout + stderr }),
      );
    });
    assert.equal(result.code, 0, result.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an option given as undefined means its default, as an omitted one does", async () => {
  const mt = constantJson({ time: 1, warnings: [] });
  const client = new DwdClient({
    baseUrl: undefined,
    staticBaseUrl: undefined,
    userAgent: undefined,
    timeoutMs: undefined,
    maxRetries: undefined,
    retryDelayMs: undefined,
    maxRedirects: undefined,
    maxResponseBytes: undefined,
    sleep: undefined,
    onRetry: undefined,
    transport: mt.transport,
  });
  await client.warnings.nowcast();
  const sent = mt.calls[0]!;
  assert.equal(sent.url, "https://s3.eu-central-1.amazonaws.com/app-prod-static.warnwetter.de/v16/warnings_nowcast.json");
  assert.equal(sent.headers?.["User-Agent"], "dwd-cli");
  assert.equal(sent.timeoutMs, 30_000);
  assert.equal(sent.maxResponseBytes, 100 * 1024 * 1024);

  const ws = constantJson({ "10865": { forecast1: {} } });
  await new DwdClient({ baseUrl: undefined, transport: ws.transport }).weather.stationOverview(["10865"]);
  assert.equal(ws.calls[0]!.url, "https://app-prod-ws.warnwetter.de/v30/stationOverviewExtended?stationIds=10865");

  const raw = constantJson({ ok: 1 });
  await new RequestEngine({ transport: raw.transport }).request("GET", "/x", { query: undefined, accept: "application/json" });
  assert.equal(raw.calls[0]!.url, "https://app-prod-ws.warnwetter.de/x");
});
