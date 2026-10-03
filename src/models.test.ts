import { expect, test } from "bun:test";

import type { Fetch } from "./http.ts";
import {
  listModels,
  preflight,
  transcriptionProviderOptions,
} from "./models.ts";
import { DEFAULT_MODEL } from "./settings.ts";

const entry = (id: string, prompt = "0.000055") => ({
  architecture: { output_modalities: ["transcription"] },
  context_length: 0,
  id,
  name: id,
  pricing: { completion: "0", prompt },
});
const catalog: Fetch = () =>
  Promise.resolve(Response.json({ data: [entry(DEFAULT_MODEL)] }));
const futureCatalog: Fetch = () =>
  Promise.resolve(
    Response.json({
      data: [
        {
          architecture: { output_modalities: ["transcription"] },
          id: "future/stt",
          name: "Future",
        },
      ],
    })
  );
const missingCatalog: Fetch = () => Promise.resolve(Response.json({}));
const foreignPagination: Fetch = () =>
  Promise.resolve(
    Response.json({
      data: [],
      links: { next: "https://openrouter.ai/api/v1/models" },
    })
  );
const mistralEndpoints: Fetch = () =>
  Promise.resolve(
    Response.json({ data: { endpoints: [{ tag: "mistral/eu" }] } })
  );
const mixedEndpoints: Fetch = () =>
  Promise.resolve(
    Response.json({
      data: { endpoints: [{ tag: "groq" }, { tag: "unsupported" }] },
    })
  );
const groqEndpoints: Fetch = () =>
  Promise.resolve(Response.json({ data: { endpoints: [{ tag: "groq" }] } }));
const cyclic: Fetch = (url) =>
  Promise.resolve(Response.json({ data: [], links: { next: String(url) } }));

test("regional catalog uses EU host and documented duration pricing", async () => {
  const urls: string[] = [];
  const models = await listModels("eu", {
    fetch: (url) => {
      urls.push(String(url));
      return Promise.resolve(
        Response.json({
          data: [
            entry(DEFAULT_MODEL),
            entry("openai/gpt-4o-transcribe", "0.000001"),
          ],
        })
      );
    },
  });
  expect(urls).toEqual([
    "https://eu.openrouter.ai/api/v1/models?output_modalities=transcription",
  ]);
  expect(models[0]?.pricePerSecond).toBe(0.000055);
  expect(models[0]?.languages).toEqual([
    "en",
    "zh",
    "hi",
    "es",
    "ar",
    "fr",
    "pt",
    "ru",
    "de",
    "ja",
    "ko",
    "it",
    "nl",
  ]);
  expect(models[1]?.pricePerSecond).toBeNull();
  expect(models[1]?.promptPrice).toBe(0.000001);
  expect(models[1]?.timestamps).toBe(false);
});

test("preflight rejects unavailable regional models and unsupported language before upload", async () => {
  await expect(
    preflight("openai/whisper-1", "eu", { apiKey: "test", fetch: catalog })
  ).rejects.toThrow();
  await expect(
    preflight(DEFAULT_MODEL, "eu", {
      apiKey: "test",
      fetch: catalog,
      language: "sv",
    })
  ).rejects.toThrow();
  const available = await preflight(DEFAULT_MODEL, "eu", {
    apiKey: "test",
    fetch: catalog,
    language: "en",
  });
  expect(available.id).toBe(DEFAULT_MODEL);
});

test("unknown capabilities and prices remain explicit and catalogs fail closed", async () => {
  const models = await listModels("eu", { fetch: futureCatalog });
  expect(models[0]).toMatchObject({
    completionPrice: null,
    diarization: null,
    languages: null,
    pricePerSecond: null,
    promptPrice: null,
    timestamps: null,
    vocabulary: null,
  });
  await expect(
    preflight("future/stt", "eu", {
      apiKey: "test",
      diarize: true,
      fetch: futureCatalog,
    })
  ).rejects.toThrow();
  await expect(listModels("eu", { fetch: missingCatalog })).rejects.toThrow();
  await expect(
    listModels("eu", { fetch: foreignPagination })
  ).rejects.toThrow();
});

test("pagination traverses only the regional catalog and rejects cycles", async () => {
  const urls: string[] = [];
  const fetch: Fetch = (url) => {
    urls.push(String(url));
    return Promise.resolve(
      Response.json(
        urls.length === 1
          ? {
              data: [entry(DEFAULT_MODEL)],
              links: { next: "/api/v1/models?page=2" },
            }
          : { data: [entry("openai/whisper-1")] }
      )
    );
  };
  const models = await listModels("eu", { fetch });
  expect(models.map((model) => model.id)).toEqual([
    DEFAULT_MODEL,
    "openai/whisper-1",
  ]);
  expect(urls[1]).toBe("https://eu.openrouter.ai/api/v1/models?page=2");
  await expect(listModels("eu", { fetch: cyclic })).rejects.toThrow();
});

test("malformed catalog fields are rejected instead of silently becoming unknown", async () => {
  const bodies = [
    {
      data: [
        { ...entry(DEFAULT_MODEL), architecture: { output_modalities: [42] } },
      ],
    },
    { data: [{ ...entry(DEFAULT_MODEL), pricing: [] }] },
    { data: [{ ...entry(DEFAULT_MODEL), pricing: { prompt: {} } }] },
    { data: [{ ...entry(DEFAULT_MODEL), context_length: -1 }] },
    { data: [], links: { next: 42 } },
    { data: [], links: [] },
  ];
  await Promise.all(
    bodies.map(async (body) => {
      const fetch: Fetch = () => Promise.resolve(Response.json(body));
      await expect(listModels("eu", { fetch })).rejects.toThrow();
    })
  );
});

test("free prompts and vocabulary with unknown support are rejected", async () => {
  await expect(
    transcriptionProviderOptions(DEFAULT_MODEL, "eu", {
      apiKey: "test",
      fetch: mistralEndpoints,
      prompt: "Please transcribe correctly",
    })
  ).rejects.toThrow();
  await expect(
    transcriptionProviderOptions("future/stt", "eu", {
      apiKey: "test",
      fetch: mistralEndpoints,
      vocabulary: ["Fortnox"],
    })
  ).rejects.toThrow();
});

test("hints must be documented for every candidate transcription provider", async () => {
  await expect(
    transcriptionProviderOptions("openai/whisper-large-v3", "global", {
      apiKey: "test",
      fetch: mixedEndpoints,
      vocabulary: ["Fortnox"],
    })
  ).rejects.toThrow();
  const hints = await transcriptionProviderOptions(
    "openai/whisper-large-v3",
    "global",
    {
      apiKey: "test",
      fetch: groqEndpoints,
      prompt: "Meeting transcript",
      vocabulary: ["Fortnox"],
    }
  );
  expect(hints).toEqual({
    groq: { prompt: "Meeting transcript\nExpected vocabulary: Fortnox" },
  });
});
