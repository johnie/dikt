import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { parseTranscription, transcribe } from "./openrouter.ts";
import type { TranscribeOptions } from "./openrouter.ts";
import { DEFAULT_MODEL } from "./settings.ts";

const requestSchema = z.object({ response_format: z.string() });

const malformedText = () => Promise.resolve(Response.json({ language: "en" }));
const options: TranscribeOptions = {
  apiKey: "test",
  diarize: false,
  language: undefined,
  model: DEFAULT_MODEL,
  region: "eu",
  timestamps: true,
};

test("missing/wrong text and malformed costs never become successful empty transcripts", () => {
  for (const body of [
    {},
    { text: null },
    { text: 4 },
    { text: "ok", usage: { cost: -1 } },
    { text: "ok", usage: { cost: "0.1" } },
    { cost: Number.NaN, text: "ok" },
  ]) {
    expect(() => parseTranscription(body)).toThrow();
  }
  expect(parseTranscription({ text: "" }).text).toBe("");
  expect(parseTranscription({ segments: [], text: "", words: [] }).text).toBe(
    ""
  );
  expect(parseTranscription({ text: "hello" }).cost).toBeNull();
  expect(parseTranscription({ text: "hello", usage: { cost: 0 } }).cost).toBe(
    0
  );
  expect(parseTranscription({ cost: null, text: "hello" }).cost).toBeNull();
});

test("validates timestamp arrays and speaker indices at live/cache boundary", () => {
  for (const segment of [
    { end: 1, start: -1, text: "hi" },
    { end: 1, start: 2, text: "hi" },
    { end: Infinity, start: 0, text: "hi" },
    { end: 1, speaker: "Alice", start: 0, text: "hi" },
    { end: 1, speaker: -1, start: 0, text: "hi" },
    { end: 1, start: 0 },
  ]) {
    expect(() =>
      parseTranscription({ segments: [segment], text: "hi" })
    ).toThrow();
  }
  expect(() => parseTranscription({ text: "hi", words: {} })).toThrow();
  expect(() =>
    parseTranscription({
      segments: [{ end: 1, start: 0, text: "hi" }],
      text: "",
    })
  ).toThrow();
  const body = {
    cost: 0.5,
    segments: [{ end: 1, speaker: 0, start: 0, text: "hi" }],
    text: "hi",
  };
  expect(parseTranscription(body)).toMatchObject(body);
});

test("timestamp fallback only handles explicit unsupported format and does not mutate options", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dikt-cloud-test-"));
  const audioPath = path.join(directory, "audio.mp3");
  await Bun.write(audioPath, "audio fixture");
  try {
    const bodies: z.infer<typeof requestSchema>[] = [];
    const immutable = Object.freeze({
      ...options,
      fetch: (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(requestSchema.parse(JSON.parse(String(init?.body))));
        const response =
          bodies.length === 1
            ? Response.json(
                {
                  error: {
                    message: "verbose_json is not supported by this model",
                  },
                },
                { status: 400 }
              )
            : Response.json({ text: "hello" });
        return Promise.resolve(response);
      },
    });
    const result = await transcribe(audioPath, immutable);
    expect(result.text).toBe("hello");
    expect(bodies).toMatchObject([
      { response_format: "verbose_json" },
      { response_format: "json" },
    ]);
    expect(immutable.timestamps).toBe(true);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("unrelated 400 errors mentioning response format are never timestamp retries", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dikt-cloud-test-"));
  const audioPath = path.join(directory, "audio.mp3");
  await Bun.write(audioPath, "audio fixture");
  try {
    let calls = 0;
    await expect(
      transcribe(audioPath, {
        ...options,
        fetch: () => {
          calls += 1;
          return Promise.resolve(
            Response.json(
              {
                error: {
                  message:
                    "Unsupported language sv; response_format=verbose_json",
                },
              },
              { status: 400 }
            )
          );
        },
      })
    ).rejects.toThrow();
    expect(calls).toBe(1);
    await expect(
      transcribe(audioPath, {
        ...options,
        fetch: malformedText,
      })
    ).rejects.toThrow();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("timestamp fallback cannot discard explicitly requested diarization", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dikt-cloud-test-"));
  const audioPath = path.join(directory, "audio.mp3");
  await Bun.write(audioPath, "audio fixture");
  let uploads = 0;
  const fetch = (url: string | URL | Request) => {
    if (String(url).endsWith("/endpoints")) {
      return Promise.resolve(
        Response.json({ data: { endpoints: [{ tag: "mistral/eu" }] } })
      );
    }
    uploads += 1;
    return Promise.resolve(
      Response.json(
        { error: { message: "verbose_json is not supported" } },
        { status: 400 }
      )
    );
  };
  try {
    await expect(
      transcribe(audioPath, { ...options, diarize: true, fetch })
    ).rejects.toThrow();
    expect(uploads).toBe(1);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("timed transcription rejects disorder and normalizes absent timings without inventing them", () => {
  expect(() =>
    parseTranscription({
      segments: [
        { end: 3, start: 2, text: "later" },
        { end: 2, start: 1, text: "earlier" },
      ],
      text: "later earlier",
    })
  ).toThrow();
  expect(() => parseTranscription({ language: " ", text: "hello" })).toThrow();
  expect(() => parseTranscription({ text: "hello", usage: [] })).toThrow();
  expect(() => parseTranscription({ error: null, text: "hello" })).toThrow();
  expect(
    parseTranscription({ segments: [], text: "hello", words: [] })
  ).toEqual({
    cost: null,
    language: undefined,
    segments: undefined,
    text: "hello",
    words: undefined,
  });
});
