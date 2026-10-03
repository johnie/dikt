import { expect, test } from "bun:test";

import { z } from "zod";

import {
  OpenRouterError,
  reportedCost,
  requestJson,
  retryDelay,
} from "./http.ts";
import type { Fetch } from "./http.ts";

const url = "https://eu.openrouter.ai/api/v1/audio/transcriptions";
const responseSchema = z.object({ text: z.string() });
const forbidden: Fetch = () =>
  Promise.resolve(
    Response.json({ error: { message: "Forbidden" } }, { status: 403 })
  );
const invalidJson: Fetch = () => Promise.resolve(new Response("not json"));
const apiError: Fetch = () =>
  Promise.resolve(
    Response.json({ error: { code: 502, message: "upstream failed" } })
  );
const malformedSuccess: Fetch = () =>
  Promise.resolve(Response.json({ text: 42 }));

test("honors Retry-After seconds/date and refuses excessive wait", () => {
  expect(retryDelay("2", 0, 0)).toBe(2000);
  expect(retryDelay("Thu, 01 Jan 1970 00:00:03 GMT", 0, 1000)).toBe(2000);
  expect(retryDelay("nonsense", 2, 0)).toBe(2000);
  expect(retryDelay("-1", 0, 0)).toBe(500);
  expect(() => retryDelay("61", 0)).toThrow();
});

test("missing cost remains unknown and malformed billing never becomes free", () => {
  expect(reportedCost(null)).toBeNull();
  expect(reportedCost({})).toBeNull();
  expect(reportedCost({ cost: null })).toBeNull();
  expect(reportedCost({ cost: 0 })).toBe(0);
  for (const usage of [
    false,
    [],
    "free",
    { cost: -1 },
    { cost: "0.1" },
    { cost: Number.NaN },
    { cost: Infinity },
  ]) {
    expect(() => reportedCost(usage)).toThrow();
  }
});

test("retries only bounded explicit transient HTTP failures", async () => {
  let calls = 0;
  const fetch: Fetch = (_url, init) => {
    expect(init?.redirect).toBe("error");
    calls += 1;
    const response =
      calls < 3
        ? Response.json(
            { error: { message: "busy" } },
            { headers: { "Retry-After": "0" }, status: 429 }
          )
        : Response.json({ text: "ok" });
    return Promise.resolve(response);
  };
  const result = await requestJson(url, { method: "POST" }, responseSchema, {
    fetch,
    retries: 2,
  });
  expect(result.text).toBe("ok");
  expect(calls).toBe(3);
  calls = 0;
  await expect(
    requestJson(url, { method: "POST" }, responseSchema, { fetch, retries: 1 })
  ).rejects.toBeInstanceOf(OpenRouterError);
  expect(calls).toBe(2);
});

test("never retries a POST network error of uncertain billing", async () => {
  let calls = 0;
  const fetch: Fetch = () => {
    calls += 1;
    return Promise.reject(new TypeError("connection reset"));
  };
  await expect(
    requestJson(url, { method: "POST" }, responseSchema, { fetch })
  ).rejects.toThrow("may have been billed");
  expect(calls).toBe(1);
});

test("explicit 400 and malformed successful responses never become empty successes", async () => {
  let calls = 0;
  const fetch: Fetch = () => {
    calls += 1;
    return Promise.resolve(
      Response.json({ error: { message: "bad language" } }, { status: 400 })
    );
  };
  await expect(
    requestJson(url, { method: "POST" }, responseSchema, { fetch })
  ).rejects.toBeInstanceOf(OpenRouterError);
  expect(calls).toBe(1);
  await expect(
    requestJson(url, {}, responseSchema, { fetch: invalidJson })
  ).rejects.toThrow();
  await expect(
    requestJson(url, {}, responseSchema, { fetch: malformedSuccess })
  ).rejects.toThrow();
  await expect(
    requestJson(url, {}, responseSchema, { fetch: apiError })
  ).rejects.toMatchObject({ status: 502 });
});

test("pre-aborted requests never reach fetch", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  let calls = 0;
  const fetch: Fetch = () => {
    calls += 1;
    return Promise.resolve(Response.json({ text: "ok" }));
  };
  await expect(
    requestJson(url, {}, responseSchema, { fetch, signal: controller.signal })
  ).rejects.toThrow("cancelled");
  expect(calls).toBe(0);
});

test("cancellation interrupts Retry-After without scheduling another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetch: Fetch = () => {
    calls += 1;
    const stream = new ReadableStream({
      cancel: () => controller.abort(new Error("cancelled")),
    });
    return Promise.resolve(
      new Response(stream, { headers: { "Retry-After": "30" }, status: 503 })
    );
  };
  await expect(
    requestJson(url, { method: "POST" }, responseSchema, {
      fetch,
      signal: controller.signal,
    })
  ).rejects.toThrow("cancelled");
  expect(calls).toBe(1);
});

test("timeout aborts an active request and reports uncertain POST billing", async () => {
  let calls = 0;
  const fetch: Fetch = (_url, init) => {
    calls += 1;
    const { promise, reject } = Promise.withResolvers<Response>();
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
      once: true,
    });
    return promise;
  };
  await expect(
    requestJson(url, { method: "POST" }, responseSchema, {
      fetch,
      timeoutMs: 5,
    })
  ).rejects.toThrow("billing may be unknown");
  expect(calls).toBe(1);
});

test("EU authentication failure explains account access without global fallback", async () => {
  await expect(
    requestJson(url, {}, responseSchema, { fetch: forbidden })
  ).rejects.toThrow("no global fallback");
});
