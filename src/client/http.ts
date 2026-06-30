// HTTP transport built on Node's built-in `http`/`https` modules — no axios,
// no fetch polyfill, no third-party HTTP client.
//
// The transport is a plain function so it can be trivially swapped out in tests
// (inject a `mock.fn()` returning a canned HttpResponse) without touching the
// network. The default implementation below is exercised against a real local
// `http.createServer` in the test-suite.
//
// DWD's static warning files are stored on S3 with `Content-Encoding: gzip` and
// are served compressed regardless of the request's Accept-Encoding, so this
// transport transparently decompresses gzip/deflate/brotli bodies.

import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { DwdNetworkError } from "./errors.js";

// Async (libuv thread-pool) variants of the zlib calls. Decoding runs off the
// main thread so a large warning feed does not block the event loop — important
// because this transport ships as part of a reusable library, not only a CLI.
const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotliDecompress = promisify(zlib.brotliDecompress);

// `req.setTimeout` holds the delay in a 32-bit signed integer. A larger value
// makes Node emit a `TimeoutOverflowWarning` to stderr and silently truncate the
// timer, so clamp here: the effective timeout is already unbounded for practical
// purposes (~24.8 days) and the parser accepts up to Number.MAX_SAFE_INTEGER.
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface HttpRequest {
  method: string;
  /** Fully-qualified absolute URL. */
  url: string;
  headers?: Record<string, string>;
  /** Optional request body (already serialised). */
  body?: string | Buffer;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Hard cap on the response body size in bytes; the request aborts if exceeded. */
  maxResponseBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * Decompress a body according to its Content-Encoding (identity if none/unknown).
 *
 * `maxBytes` (when > 0) bounds the *decompressed* output via zlib's
 * `maxOutputLength`: a small compressed body can expand to many gigabytes
 * ("decompression bomb"), so capping only the compressed wire bytes upstream is
 * not enough. Past the cap zlib throws `ERR_BUFFER_TOO_LARGE`, which the caller
 * turns into a DwdNetworkError — preserving the documented memory-exhaustion
 * protection across compressed responses too.
 */
async function decode(
  body: Buffer,
  encoding: string | undefined,
  maxBytes: number | undefined,
): Promise<Buffer> {
  // `maxOutputLength` is honoured by both zlib and brotli option objects.
  const limit = maxBytes && maxBytes > 0 ? { maxOutputLength: maxBytes } : {};
  // When the decompressed output exceeds `maxOutputLength`, zlib throws an error
  // with code `ERR_BUFFER_TOO_LARGE`. Translate it into the same documented
  // size-cap error the wire-size cap produces, so a decompression bomb reports
  // "Response exceeded maxResponseBytes" rather than looking like a corrupt body.
  const overCap = (): DwdNetworkError =>
    new DwdNetworkError(`Response exceeded maxResponseBytes (${maxBytes})`);
  const isOverCap = (err: unknown): boolean =>
    typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE";
  try {
    switch ((encoding ?? "").toLowerCase()) {
      case "gzip":
      case "x-gzip":
        return await gunzip(body, limit);
      case "deflate":
        // The `deflate` content-coding is ambiguous in the wild: some servers send
        // zlib-wrapped data (RFC 1950, handled by inflate) and some send raw
        // DEFLATE (RFC 1951, handled by inflateRaw). Try zlib-wrapped first, then
        // fall back to raw, so both are decoded like browsers/fetch do.
        try {
          return await inflate(body, limit);
        } catch (err) {
          // A hit on the size cap is a deliberate limit, not a wrong-wrapper
          // mismatch; don't waste a second decode attempt re-tripping it.
          if (isOverCap(err)) throw err;
          return await inflateRaw(body, limit);
        }
      case "br":
        return await brotliDecompress(body, limit);
      default:
        if (maxBytes && maxBytes > 0 && body.length > maxBytes) {
          throw overCap();
        }
        return body;
    }
  } catch (err) {
    if (isOverCap(err)) throw overCap();
    throw err;
  }
}

/** Wrap a thrown value as a DwdNetworkError unless it already is one. */
function toNetworkError(err: unknown): DwdNetworkError {
  if (err instanceof DwdNetworkError) return err;
  return new DwdNetworkError(err instanceof Error ? err.message : String(err), { cause: err });
}

/**
 * Default transport. Resolves with the raw response (including non-2xx) — status
 * interpretation is the client's job. Rejects only on transport-level failures
 * (connection errors, timeouts, malformed URLs).
 */
export const nodeHttpTransport: Transport = (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      reject(new DwdNetworkError(`Invalid URL: ${request.url}`));
      return;
    }

    // Only http/https are supported. Reject anything else up front with a clear,
    // typed error instead of letting Node throw an opaque ERR_INVALID_PROTOCOL
    // (and so this never reaches the file:/ftp:/etc. drivers).
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      reject(new DwdNetworkError(`Unsupported protocol "${url.protocol}" in URL: ${request.url}`));
      return;
    }

    const isHttps = url.protocol === "https:";
    const driver = isHttps ? https : http;
    const maxBytes = request.maxResponseBytes;

    const onResponse = (res: http.IncomingMessage): void => {
      const chunks: Buffer[] = [];
      let received = 0;
      let aborted = false;

      res.on("data", (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.length;
        if (maxBytes !== undefined && received > maxBytes) {
          aborted = true;
          res.destroy();
          reject(new DwdNetworkError(`Response exceeded maxResponseBytes (${maxBytes})`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (aborted) return;
        const raw = Buffer.concat(chunks);
        decode(raw, res.headers["content-encoding"], maxBytes).then(
          (body) => {
            // The body is now decoded; drop the encoding header so downstream
            // consumers don't try to decode it a second time.
            const headers = { ...res.headers };
            delete headers["content-encoding"];
            resolve({ status: res.statusCode ?? 0, headers, body });
          },
          (err) => {
            if (err instanceof DwdNetworkError) {
              reject(err);
              return;
            }
            reject(
              new DwdNetworkError(
                `Failed to decode ${res.headers["content-encoding"]} response body`,
                { cause: err },
              ),
            );
          },
        );
      });
      res.on("error", (err) => {
        if (aborted) return; // we already rejected with the size-cap error
        reject(new DwdNetworkError(`Response stream error: ${err.message}`, { cause: err }));
      });
    };

    let req: http.ClientRequest;
    try {
      // Node validates the outgoing headers synchronously here. A non-Latin-1
      // header value (e.g. an emoji or CJK --user-agent) makes it throw a
      // TypeError *before* the request is sent; surface it as the typed
      // DwdNetworkError used for every other transport failure rather than
      // letting a bare TypeError escape to the CLI's "Unexpected error" fallback.
      req = driver.request(url, { method: request.method, headers: request.headers }, onResponse);
    } catch (err) {
      reject(toNetworkError(err));
      return;
    }

    if (request.timeoutMs && request.timeoutMs > 0) {
      const timeoutMs = Math.min(request.timeoutMs, MAX_TIMEOUT_MS);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new DwdNetworkError(`Request timed out after ${timeoutMs}ms`));
      });
    }

    req.on("error", (err) => {
      // A timeout destroy already passes a DwdNetworkError; don't double-wrap.
      reject(toNetworkError(err));
    });

    try {
      if (request.body !== undefined) req.write(request.body);
      req.end();
    } catch (err) {
      reject(toNetworkError(err));
    }
  });
