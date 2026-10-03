import { z } from "zod";

import { requestJson } from "./http.ts";
import type { HttpOptions } from "./http.ts";
import { BASE_URLS, DEFAULT_MODEL } from "./settings.ts";
import type { Region } from "./settings.ts";

export interface ModelInfo {
  id: string;
  name: string;
  languages: string[] | null;
  timestamps: boolean | null;
  diarization: boolean | null;
  vocabulary: boolean | null;
  pricePerSecond: number | null;
  promptPrice: number | null;
  completionPrice: number | null;
  contextLength: number | null;
}
interface CatalogOptions extends HttpOptions {
  apiKey?: string;
  modality?: "transcription" | "text";
}
interface PreflightOptions extends HttpOptions {
  apiKey: string;
  language?: string;
  diarize?: boolean;
  prompt?: string;
  vocabulary?: string[];
  modality?: "transcription" | "text";
}
const voxtralLanguages = [
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
];
const whisperModels = {
  "openai/whisper-1": true,
  "openai/whisper-large-v3": true,
  "openai/whisper-large-v3-turbo": true,
} satisfies Record<string, true>;
const catalogPriceSchema = z
  .union([z.number(), z.string().min(1)])
  .nullish()
  .transform((value) => {
    if (value === undefined || value === null) {
      return null;
    }
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  });
const catalogEntrySchema = z.object({
  architecture: z.object({ output_modalities: z.array(z.string()) }),
  context_length: z.int().nonnegative().nullish(),
  id: z.string().min(1),
  name: z.string(),
  pricing: z
    .object({
      completion: catalogPriceSchema,
      prompt: catalogPriceSchema,
    })
    .optional(),
});
const catalogSchema = z.object({
  data: z.array(catalogEntrySchema),
  links: z.object({ next: z.string().nullish() }).nullish(),
});

const capabilities = (model: string, modality: "transcription" | "text") => {
  let timestamps: boolean | null = null;
  let diarization: boolean | null = null;
  let vocabulary: boolean | null = null;
  if (modality === "text") {
    return { diarization, timestamps, vocabulary };
  }
  const voxtral = model === DEFAULT_MODEL;
  const whisper = Object.hasOwn(whisperModels, model);
  const noVerbose = [
    "openai/gpt-4o-transcribe",
    "microsoft/mai-transcribe-1.5",
  ].includes(model);
  const diarizes =
    voxtral ||
    model === "microsoft/mai-transcribe-2" ||
    model.startsWith("deepgram/");
  if (noVerbose) {
    timestamps = false;
  } else if (voxtral || whisper || diarizes) {
    timestamps = true;
  }
  if (diarizes) {
    diarization = true;
  } else if (whisper || noVerbose) {
    diarization = false;
  }
  if (voxtral || whisper) {
    vocabulary = true;
  }
  return { diarization, timestamps, vocabulary };
};

const modelInfo = (
  raw: z.infer<typeof catalogEntrySchema>,
  modality: "transcription" | "text"
): ModelInfo => {
  const voxtral = raw.id === DEFAULT_MODEL;
  const promptPrice = raw.pricing?.prompt ?? null;
  return {
    ...capabilities(raw.id, modality),
    completionPrice: raw.pricing?.completion ?? null,
    contextLength:
      raw.context_length && raw.context_length > 0 ? raw.context_length : null,
    id: raw.id,
    languages: voxtral ? [...voxtralLanguages] : null,
    name: raw.name,
    // Documented duration-priced families expose seconds in pricing.prompt. Token-priced STT is not seconds.
    pricePerSecond:
      modality === "transcription" &&
      (voxtral || Object.hasOwn(whisperModels, raw.id))
        ? promptPrice
        : null,
    promptPrice,
  };
};

const catalogPage = async (
  url: string,
  origin: string,
  modality: "transcription" | "text",
  options: CatalogOptions,
  seen: Set<string>,
  result: ModelInfo[]
): Promise<ModelInfo[]> => {
  if (seen.has(url)) {
    throw new Error("Malformed model catalog: cyclic pagination");
  }
  seen.add(url);
  const body = await requestJson(
    url,
    {
      headers: options.apiKey
        ? { Authorization: `Bearer ${options.apiKey}` }
        : {},
    },
    catalogSchema,
    options
  );
  for (const raw of body.data) {
    if (raw.architecture.output_modalities.includes(modality)) {
      result.push(modelInfo(raw, modality));
    }
  }
  const next = body.links?.next;
  if (next === undefined || next === null) {
    return result;
  }
  const nextUrl = new URL(next, origin);
  if (nextUrl.origin !== origin || nextUrl.pathname !== "/api/v1/models") {
    throw new Error(
      "Regional model pagination attempted to leave selected host"
    );
  }
  return catalogPage(nextUrl.href, origin, modality, options, seen, result);
};

/** Always query the selected region. A globally available model is not regional availability. */
export const listModels = (
  region: Region,
  options: CatalogOptions = {}
): Promise<ModelInfo[]> => {
  const modality = options.modality ?? "transcription";
  const origin = BASE_URLS[region];
  return catalogPage(
    `${origin}/api/v1/models?output_modalities=${modality}`,
    origin,
    modality,
    options,
    new Set(),
    []
  );
};

interface ProviderOptions {
  context_bias?: string[];
  diarization?: { enabled: boolean };
  diarize?: boolean;
  prompt?: string;
}
const endpointsSchema = z.object({
  data: z.object({
    endpoints: z.array(z.object({ tag: z.string() })).min(1),
  }),
});
const vocabularySchema = z
  .array(
    z
      .string()
      .min(1)
      .refine(
        (term) => term === term.trim(),
        "Vocabulary terms must be trimmed"
      )
  )
  .max(100);

const mistralHints = (options: PreflightOptions): ProviderOptions => {
  const result: ProviderOptions = {};
  if (options.diarize) {
    result.diarize = true;
  }
  if (options.vocabulary) {
    result.context_bias = options.vocabulary;
  }
  return result;
};

const whisperHints = (options: PreflightOptions): ProviderOptions => {
  const prompts = [];
  if (options.prompt) {
    prompts.push(options.prompt);
  }
  if (options.vocabulary?.length) {
    prompts.push(`Expected vocabulary: ${options.vocabulary.join(", ")}`);
  }
  return { prompt: prompts.join("\n") };
};

const providerHints = (
  tag: string,
  model: string,
  options: PreflightOptions
): ProviderOptions => {
  const terms = options.vocabulary;
  if (model === DEFAULT_MODEL && (tag === "mistral" || tag === "mistral/eu")) {
    return mistralHints(options);
  }
  if (
    Object.hasOwn(whisperModels, model) &&
    tag === "groq" &&
    !options.diarize
  ) {
    return whisperHints(options);
  }
  if (!options.prompt && !terms?.length) {
    if (model === "microsoft/mai-transcribe-2" && tag.startsWith("azure")) {
      return { diarization: { enabled: true } };
    }
    if (model.startsWith("deepgram/") && tag.startsWith("deepgram")) {
      return { diarize: true };
    }
  }
  throw new Error(
    `Requested transcription options are not documented for provider ${tag} serving ${model}; refusing potentially ignored hints or diarization`
  );
};

/** Provider tags, not model-owner names, select forwarded transcription options. */
export const transcriptionProviderOptions = async (
  model: string,
  region: Region,
  options: PreflightOptions
): Promise<Record<string, ProviderOptions> | undefined> => {
  if (!options.prompt && !options.diarize && !options.vocabulary?.length) {
    return undefined;
  }
  options.signal?.throwIfAborted();
  if (options.prompt && model === DEFAULT_MODEL) {
    throw new Error(
      "Mistral transcription does not support a free-form prompt; use vocabulary terms instead"
    );
  }
  if (
    (options.prompt || options.vocabulary?.length) &&
    model !== DEFAULT_MODEL &&
    !Object.hasOwn(whisperModels, model)
  ) {
    throw new Error(
      `Vocabulary hints or prompts are not documented for ${model}; refusing to silently ignore them`
    );
  }
  if (options.vocabulary) {
    vocabularySchema.parse(options.vocabulary);
  }
  const body = await requestJson(
    `${BASE_URLS[region]}/api/v1/models/${model.split("/").map(encodeURIComponent).join("/")}/endpoints`,
    { headers: { Authorization: `Bearer ${options.apiKey}` } },
    endpointsSchema,
    options
  );
  const result: Record<string, ProviderOptions> = {};
  for (const { tag } of body.data.endpoints) {
    result[tag] = providerHints(tag, model, options);
  }
  return result;
};
export const preflight = async (
  model: string,
  region: Region,
  options: PreflightOptions
): Promise<ModelInfo> => {
  const models = await listModels(region, options);
  const info = models.find((entry) => entry.id === model);
  if (!info) {
    throw new Error(
      `Model ${model} is unavailable for ${options.modality ?? "transcription"} in region ${region}; no regional fallback is permitted`
    );
  }
  if (
    options.language &&
    info.languages &&
    !info.languages.includes(options.language)
  ) {
    throw new Error(
      `Model ${model} does not support language ${options.language}; supported: ${info.languages.join(", ")}`
    );
  }
  if (options.diarize && info.diarization !== true) {
    throw new Error(
      `Diarization support is ${info.diarization === false ? "unavailable" : "unknown"} for ${model}`
    );
  }
  if (options.vocabulary?.length && info.vocabulary !== true) {
    throw new Error(
      `Vocabulary hints are unsupported or unverified for ${model}`
    );
  }
  if (options.diarize || options.prompt || options.vocabulary?.length) {
    await transcriptionProviderOptions(model, region, options);
  }
  return info;
};
