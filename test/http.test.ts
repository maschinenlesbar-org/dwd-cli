import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { nodeHttpTransport } from "../src/client/http.js";
import { DwdNetworkError } from "../src/client/errors.js";

/** Start a throwaway loopback server for one test and return its base URL. */
async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("performs a real GET and returns status, headers and body", async () => {
  await withServer(
    (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url }));
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: `${baseUrl}/v30/` });
      assert.equal(resp.status, 200);
      assert.equal(resp.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(resp.body.toString("utf8")), { path: "/v30/" });
    },
  );
});

test("rejects an unsupported protocol with DwdNetworkError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "ftp://example.test/x" }),
    DwdNetworkError,
  );
});

test("enforces maxResponseBytes", async () => {
  await withServer(
    (_req, res) => res.end("x".repeat(1000)),
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, maxResponseBytes: 10 }),
        DwdNetworkError,
      );
    },
  );
});

test("transparently decompresses a gzip-encoded body", async () => {
  const payload = JSON.stringify({ time: 1, warnings: [] });
  await withServer(
    (_req, res) => {
      res.setHeader("content-encoding", "gzip");
      res.setHeader("content-type", "application/json");
      res.end(zlib.gzipSync(Buffer.from(payload)));
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: baseUrl });
      assert.equal(resp.body.toString("utf8"), payload);
      // the encoding header is stripped once the body is decoded
      assert.equal(resp.headers["content-encoding"], undefined);
    },
  );
});

test("transparently decompresses a zlib-wrapped deflate body", async () => {
  const payload = "hello deflate";
  await withServer(
    (_req, res) => {
      res.setHeader("content-encoding", "deflate");
      res.end(zlib.deflateSync(Buffer.from(payload)));
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: baseUrl });
      assert.equal(resp.body.toString("utf8"), payload);
      assert.equal(resp.headers["content-encoding"], undefined);
    },
  );
});

test("decodes a raw-DEFLATE body via inflateRaw fallback", async () => {
  const payload = "raw deflate body";
  await withServer(
    (_req, res) => {
      res.setHeader("content-encoding", "deflate");
      // deflateRawSync produces RFC 1951 raw DEFLATE (no zlib header), which
      // inflateSync rejects — exercises the fallback path.
      res.end(zlib.deflateRawSync(Buffer.from(payload)));
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: baseUrl });
      assert.equal(resp.body.toString("utf8"), payload);
    },
  );
});

test("transparently decompresses a brotli-encoded body", async () => {
  const payload = JSON.stringify({ br: true });
  await withServer(
    (_req, res) => {
      res.setHeader("content-encoding", "br");
      res.end(zlib.brotliCompressSync(Buffer.from(payload)));
    },
    async (baseUrl) => {
      const resp = await nodeHttpTransport({ method: "GET", url: baseUrl });
      assert.equal(resp.body.toString("utf8"), payload);
    },
  );
});

test("a malformed compressed body surfaces as DwdNetworkError", async () => {
  await withServer(
    (_req, res) => {
      res.setHeader("content-encoding", "gzip");
      res.end(Buffer.from("this is not gzip"));
    },
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl }),
        DwdNetworkError,
      );
    },
  );
});

test("caps the DECOMPRESSED size, not just the compressed wire bytes", async () => {
  // A tiny compressed body that expands far past the cap (decompression bomb).
  const decompressedSize = 5_000_000;
  const cap = 10_000;
  const bomb = zlib.gzipSync(Buffer.alloc(decompressedSize, 0x61));
  await withServer(
    (_req, res) => {
      res.setHeader("content-encoding", "gzip");
      res.end(bomb);
    },
    async (baseUrl) => {
      // The compressed body is well under the cap, but the decoded output is not.
      assert.ok(bomb.length < cap);
      await assert.rejects(
        () =>
          nodeHttpTransport({
            method: "GET",
            url: baseUrl,
            maxResponseBytes: cap,
          }),
        DwdNetworkError,
      );
    },
  );
});

test("times out and rejects with DwdNetworkError", async () => {
  await withServer(
    (_req, _res) => {
      /* never responds */
    },
    async (baseUrl) => {
      await assert.rejects(
        () => nodeHttpTransport({ method: "GET", url: baseUrl, timeoutMs: 50 }),
        DwdNetworkError,
      );
    },
  );
});
