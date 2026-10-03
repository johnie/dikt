import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;
export interface HttpOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  fetch?: Fetch;
}

export class OpenRouterError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, message: string) {
    super(`OpenRouter ${status}: ${message}`);
    this.name = "OpenRouterError";
    this.status = status;
    this.detail = message;
  }
}

export const costSchema = z.number().nonnegative().nullable();
export const usageSchema = z.object({ cost: costSchema.optional() }).nullish();

/** Missing billing information is unknown, never a zero-dollar request. */
export const reportedCost = usageSchema.transform(
  (usage) => usage?.cost ?? null
).parse;

export const retryDelay = (
  header: string | null,
  attempt: number,
  now = Date.now()
): number => {
  if (header !== null) {
    const seconds = Number(header);
    const date = Date.parse(header);
    let delay: number | null = null;
    if (header.trim() && Number.isFinite(seconds)) {
      if (seconds >= 0) {
        delay = seconds * 1000;
      }
    } else if (Number.isFinite(date)) {
      delay = Math.max(0, date - now);
    }
    if (delay !== null) {
      if (delay > 60_000) {
        throw new Error(
          "OpenRouter Retry-After exceeds the 60-second retry limit; retry manually later"
        );
      }
      return delay;
    }
  }
  return Math.min(500 * 2 ** attempt, 8000);
};

const errorEnvelopeSchema = z.object({ error: z.unknown().optional() });
const errorDetailSchema = z.object({
  // Error metadata is advisory; malformed fields still reject the response.
  code: z.number().optional(),
  message: z.string().optional(),
});

const checkApiError = (
  body: z.infer<typeof errorEnvelopeSchema>,
  response: Response,
  url: string
): void => {
  if (response.ok && body.error === undefined) {
    return;
  }
  const detail = errorDetailSchema.safeParse(body.error);
  const message = detail.success
    ? (detail.data.message ?? (response.statusText || "API returned an error"))
    : response.statusText || "API returned an error";
  const status =
    response.ok && detail.success
      ? (detail.data.code ?? response.status)
      : response.status;
  const access =
    url.startsWith("https://eu.openrouter.ai/") && [401, 403].includes(status)
      ? " EU in-region routing requires eligible OpenRouter account access; no global fallback was attempted."
      : "";
  throw new OpenRouterError(status, message + access);
};

const decodeResponse = async <T>(
  response: Response,
  url: string,
  schema: z.ZodType<T>,
  signal: AbortSignal
): Promise<T> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    signal.throwIfAborted();
    if (!response.ok) {
      throw new OpenRouterError(
        response.status,
        response.statusText || "Invalid error response"
      );
    }
    throw new Error(
      "Malformed OpenRouter response: expected JSON; billing may be unknown",
      { cause: error }
    );
  }
  signal.throwIfAborted();
  const envelope = errorEnvelopeSchema.safeParse(body);
  checkApiError(envelope.success ? envelope.data : {}, response, url);
  return schema.parse(body);
};

interface RequestContext<T> {
  url: string;
  init: RequestInit;
  schema: z.ZodType<T>;
  signal: AbortSignal;
  fetch: Fetch;
  retries: number;
}

const requestAttempt = async <T>(
  context: RequestContext<T>,
  attempt: number
): Promise<T> => {
  const { signal } = context;
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await context.fetch(context.url, {
      ...context.init,
      redirect: "error",
      signal,
    });
  } catch (error) {
    signal.throwIfAborted();
    const post = context.init.method?.toUpperCase() === "POST";
    throw new Error(
      `OpenRouter network request failed${post ? "; request may have been billed; not retried" : "; not retried"}`,
      { cause: error }
    );
  }
  if (
    !response.ok &&
    [408, 429, 500, 502, 503, 504].includes(response.status) &&
    attempt < context.retries
  ) {
    const delay = retryDelay(response.headers.get("Retry-After"), attempt);
    await response.body?.cancel();
    signal.throwIfAborted();
    try {
      await sleep(delay, undefined, { signal });
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    }
    return requestAttempt(context, attempt + 1);
  }
  return decodeResponse(response, context.url, context.schema, signal);
};

const requestLimitsSchema = z.object({
  retries: z.int().min(0).max(5),
  timeoutMs: z.number().positive(),
});

/** Retry only explicit transient HTTP responses, never an ambiguous POST transport failure. */
export const requestJson = async <T>(
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
  options: HttpOptions = {}
): Promise<T> => {
  const { retries, timeoutMs } = requestLimitsSchema.parse({
    retries: options.retries ?? 2,
    timeoutMs: options.timeoutMs ?? 90_000,
  });
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const post = init.method?.toUpperCase() === "POST";
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(
          `OpenRouter request timed out after ${timeoutMs}ms${post ? "; billing may be unknown; not retried" : ""}`
        )
      ),
    timeoutMs
  );
  try {
    return await requestAttempt(
      {
        fetch: options.fetch ?? fetch,
        init,
        retries,
        schema,
        signal: controller.signal,
        url,
      },
      0
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
};
