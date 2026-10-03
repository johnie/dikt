import path from "node:path";

import { z } from "zod";

import {
  OpenRouterError,
  reportedCost,
  requestJson,
  usageSchema,
} from "./http.ts";
import type { HttpOptions } from "./http.ts";
import { transcriptionProviderOptions } from "./models.ts";
import { BASE_URLS } from "./settings.ts";
import type { Region } from "./settings.ts";

export interface Segment {
  start: number;
  end: number;
  text: string;
  speaker?: number;
}
export interface Word {
  start: number;
  end: number;
  word: string;
  speaker?: number;
}
export interface Transcription {
  text: string;
  language: string | undefined;
  segments: Segment[] | undefined;
  words: Word[] | undefined;
  cost: number | null;
}
export interface TranscribeOptions extends HttpOptions {
  apiKey: string;
  model: string;
  region: Region;
  language: string | undefined;
  diarize: boolean;
  timestamps: boolean;
  /** Free-form provider prompt; only forwarded where explicitly supported. */
  prompt?: string;
  vocabulary?: string[];
}

const timingFields = {
  end: z.number().nonnegative(),
  speaker: z.int().nonnegative().optional(),
  start: z.number().nonnegative(),
};
const segmentSchema = z
  .object({
    ...timingFields,
    text: z.string(),
  })
  .refine((entry) => entry.end >= entry.start, "Invalid segment timing");
const wordSchema = z
  .object({
    ...timingFields,
    word: z
      .string()
      .refine((word) => Boolean(word.trim()), "Missing word text"),
  })
  .refine((entry) => entry.end >= entry.start, "Invalid word timing");

const orderedTimings = <T extends { start: number }>(entries: T[]): boolean => {
  let previousStart = -1;
  for (const entry of entries) {
    if (entry.start < previousStart) {
      return false;
    }
    previousStart = entry.start;
  }
  return true;
};
const segmentsSchema = z
  .array(segmentSchema)
  .refine(orderedTimings, "Unordered segment timing")
  .transform((entries) => (entries.length ? entries : undefined))
  .optional();
const wordsSchema = z
  .array(wordSchema)
  .refine(orderedTimings, "Unordered word timing")
  .transform((entries) => (entries.length ? entries : undefined))
  .optional();

/** Validate both live provider responses and persisted normalized transcriptions. */
export const transcriptionSchema = z
  .object({
    cost: z.number().nonnegative().nullable().optional(),
    error: z.undefined().optional(),
    language: z
      .string()
      .refine(
        (language) => Boolean(language.trim()),
        "Empty transcription language"
      )
      .optional(),
    segments: segmentsSchema,
    text: z.string(),
    usage: usageSchema,
    words: wordsSchema,
  })
  .refine((value) => {
    if (value.text.trim()) {
      return true;
    }
    return (
      !value.segments?.some((segment) => segment.text.trim()) &&
      !value.words?.length
    );
  }, "Empty text contradicts timed text")
  .transform((value): Transcription => {
    let cost = reportedCost(value.usage);
    if (!("usage" in value)) {
      cost = reportedCost({ cost: value.cost });
    }
    return {
      cost,
      language: value.language,
      segments: value.segments,
      text: value.text,
      words: value.words,
    };
  });
export const parseTranscription = transcriptionSchema.parse;

const unsupportedVerboseFormat = (cause: unknown): boolean => {
  if (!(cause instanceof OpenRouterError) || cause.status !== 400) {
    return false;
  }
  const message = cause.detail
    .toLowerCase()
    .replaceAll(/[_"'=:]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return (
    /(?:unsupported|does not support|not supported) (?:the )?(?:verbose json|response format)/u.test(
      message
    ) ||
    /(?:verbose json|response format(?: verbose json)?) (?:is )?(?:not supported|unsupported)/u.test(
      message
    ) ||
    /response format (?:must be|only supports?) json/u.test(message) ||
    /(?:unsupported|invalid) value for response format verbose json/u.test(
      message
    )
  );
};

export const transcribe = async (
  audioPath: string,
  options: TranscribeOptions
): Promise<Transcription> => {
  options.signal?.throwIfAborted();
  const format = path.extname(audioPath).slice(1).toLowerCase();
  if (!["mp3", "wav", "flac", "m4a", "ogg", "webm", "aac"].includes(format)) {
    throw new Error(
      `Unsupported cloud audio format: ${format || "missing extension"}`
    );
  }
  const providerOptions = await transcriptionProviderOptions(
    options.model,
    options.region,
    options
  );
  const bytes = await Bun.file(audioPath).bytes();
  options.signal?.throwIfAborted();
  const data = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).toString("base64");
  const send = (timestamps: boolean) =>
    requestJson(
      `${BASE_URLS[options.region]}/api/v1/audio/transcriptions`,
      {
        body: JSON.stringify({
          input_audio: { data, format },
          language: options.language,
          model: options.model,
          provider: providerOptions ? { options: providerOptions } : undefined,
          response_format: timestamps ? "verbose_json" : "json",
          timestamp_granularities: timestamps ? ["segment", "word"] : undefined,
        }),
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "dikt",
        },
        method: "POST",
      },
      transcriptionSchema,
      options
    );
  let result: Transcription;
  try {
    result = await send(options.timestamps);
  } catch (error) {
    if (!options.timestamps || !unsupportedVerboseFormat(error)) {
      throw error;
    }
    if (options.diarize) {
      throw new Error(
        "Model rejected verbose_json; diarization cannot be preserved in plain JSON",
        { cause: error }
      );
    }
    result = await send(false);
  }
  if (
    options.diarize &&
    result.text.trim() &&
    !result.segments?.some((segment) => segment.speaker !== undefined) &&
    !result.words?.some((word) => word.speaker !== undefined)
  ) {
    throw new Error(
      "Provider returned no speaker labels for requested diarization"
    );
  }
  return result;
};
