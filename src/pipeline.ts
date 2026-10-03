import { mkdir } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { splitAudio } from "./audio.ts";
import type { AudioChunk } from "./audio.ts";
import type { Budget } from "./budget.ts";
import {
  atomicWrite,
  digest,
  fingerprint,
  lockJob,
  readCheckpoint,
} from "./cache.ts";
import { resolveInput } from "./download.ts";
import type { VideoInfo } from "./download.ts";
import { buildEvidence, outputStem, renderOutput } from "./exports.ts";
import type { OutputFormat } from "./exports.ts";
import { transcribeLocal } from "./local.ts";
import type { LocalOptions } from "./local.ts";
import type { ChunkTranscript, RenderOptions } from "./markdown.ts";
import type { ModelInfo } from "./models.ts";
import {
  estimateNotesCost,
  generateNotes,
  notesResultSchema,
  parseNotesResult,
  renderNotes,
} from "./notes.ts";
import { transcriptionSchema, transcribe } from "./openrouter.ts";
import type { TranscribeOptions, Transcription } from "./openrouter.ts";
import { mapLimit } from "./pool.ts";

export interface RunOptions {
  backend: "openrouter" | "local";
  cloud: TranscribeOptions;
  local: LocalOptions | undefined;
  modelFingerprint?: string;
  modelInfo: ModelInfo | undefined;
  notesModelInfo: ModelInfo | undefined;
  notesModel: string | undefined;
  chunkSeconds: number;
  concurrency: number;
  encodeConcurrency: number;
  cacheDir: string;
  downloadDir: string;
  outDir: string;
  formats: OutputFormat[];
  speakerNames: Record<string, string>;
  force: boolean;
  dryRun: boolean;
  budget: Budget;
  signal: AbortSignal;
  log: (message: string) => void;
}

const chunkSchema = z
  .object({
    end: z.number().positive(),
    index: z.number().int().nonnegative(),
    path: z.string().min(1),
    start: z.number().nonnegative(),
  })
  .refine((chunk) => chunk.end > chunk.start, "Invalid chunk interval");
const manifestSchema = z
  .object({
    chunks: z.array(chunkSchema).min(1),
    createdAt: z.iso.datetime(),
    version: z.literal(1),
  })
  .refine(
    (manifest) =>
      manifest.chunks.every(
        (chunk, index) =>
          chunk.index === index &&
          chunk.start === (manifest.chunks[index - 1]?.end ?? 0)
      ),
    "Discontinuous cached audio"
  );
type Manifest = z.infer<typeof manifestSchema>;

const requireLocal = (options: RunOptions): LocalOptions => {
  if (!options.local || !options.modelFingerprint) {
    throw new Error(
      "Local backend requires validated options and a model fingerprint"
    );
  }
  return options.local;
};

// Ordered tuples keep cache identity independent of object-key formatting.
const jobIdentity = (
  info: VideoInfo,
  source: string,
  options: RunOptions
): string =>
  digest(
    JSON.stringify([
      "job-v1",
      "mono-16k-mp3-64k-pause-v1",
      source,
      info.url,
      options.chunkSeconds,
      options.backend,
      options.backend === "local"
        ? options.modelFingerprint
        : options.cloud.model,
      options.backend === "local" ? "local" : options.cloud.region,
      options.cloud.language ?? null,
      options.cloud.prompt ?? null,
      options.cloud.vocabulary ?? [],
      options.cloud.diarize,
      options.cloud.timestamps,
    ])
  );

const loadManifest = async (
  jobDir: string,
  audioPath: string,
  options: RunOptions
): Promise<Manifest> => {
  const audioDir = path.join(jobDir, "audio");
  const manifestPath = path.join(jobDir, "manifest.json");
  const previous = options.force
    ? undefined
    : await readCheckpoint(manifestPath, manifestSchema);
  if (previous) {
    for (const chunk of previous.chunks) {
      if (
        !path
          .resolve(chunk.path)
          .startsWith(`${path.resolve(audioDir)}${path.sep}`)
      ) {
        throw new Error("Cached audio path escapes job directory");
      }
    }
    const available = await Promise.all(
      previous.chunks.map((chunk) => Bun.file(chunk.path).exists())
    );
    if (available.every(Boolean)) {
      return previous;
    }
  }
  await mkdir(audioDir, { mode: 0o700, recursive: true });
  const chunks = await splitAudio(audioPath, options.chunkSeconds, audioDir, {
    concurrency: options.encodeConcurrency,
    signal: options.signal,
  });
  const manifest: Manifest = {
    chunks,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    version: 1,
  };
  await atomicWrite(manifestPath, JSON.stringify(manifest));
  return manifest;
};

const transcriptionEstimate = (
  seconds: number,
  options: RunOptions
): number | null => {
  if (options.backend === "local" || seconds === 0) {
    return 0;
  }
  const price = options.modelInfo?.pricePerSecond;
  return price === undefined || price === null ? null : seconds * price;
};

const loadSaved = (
  jobDir: string,
  chunks: AudioChunk[],
  force: boolean
): Promise<(Transcription | undefined)[]> =>
  Promise.all(
    chunks.map((chunk) =>
      force
        ? undefined
        : readCheckpoint(
            path.join(jobDir, `transcript-${chunk.index}.json`),
            transcriptionSchema
          )
    )
  );

const transcribeOne = async (
  chunk: AudioChunk,
  options: RunOptions
): Promise<Transcription> => {
  if (options.backend === "local") {
    return await transcribeLocal(chunk.path, {
      ...requireLocal(options),
      signal: options.signal,
    });
  }
  try {
    return await transcribe(chunk.path, {
      ...options.cloud,
      signal: options.signal,
    });
  } catch (error) {
    // A failed or invalid response cannot establish whether the POST was billed.
    options.budget.record(null);
    throw error;
  }
};

const transcribeChunks = (
  jobDir: string,
  chunks: AudioChunk[],
  saved: (Transcription | undefined)[],
  options: RunOptions
): Promise<ChunkTranscript[]> =>
  mapLimit(
    chunks,
    options.concurrency,
    async (chunk) => {
      const cached = saved[chunk.index];
      if (cached) {
        options.log(`  cached chunk ${chunk.index + 1}/${chunks.length}`);
        return { chunk, transcription: cached };
      }
      const transcription = await transcribeOne(chunk, options);
      options.budget.record(transcription.cost);
      await atomicWrite(
        path.join(jobDir, `transcript-${chunk.index}.json`),
        JSON.stringify(transcription)
      );
      options.log(`  saved chunk ${chunk.index + 1}/${chunks.length}`);
      return { chunk, transcription };
    },
    options.signal
  );

const writeTranscripts = async (
  info: VideoInfo,
  manifest: Manifest,
  transcripts: ChunkTranscript[],
  options: RunOptions
): Promise<string[]> => {
  const renderOptions: RenderOptions = {
    language: options.cloud.language,
    model:
      options.backend === "local"
        ? `whisper.cpp:${path.basename(requireLocal(options).modelPath)}`
        : options.cloud.model,
    region: options.backend === "local" ? "local" : options.cloud.region,
    speakerNames: options.speakerNames,
    transcribedAt: new Date(manifest.createdAt),
  };
  // Validate every requested format before publishing any transcript output.
  const outputs = options.formats.map((format) => ({
    content: renderOutput(format, info, transcripts, renderOptions),
    file: path.join(options.outDir, `${outputStem(info)}.${format}`),
  }));
  return await mapLimit(outputs, 1, async (output) => {
    await atomicWrite(output.file, output.content);
    options.log(`Wrote ${output.file}`);
    return output.file;
  });
};

const writeNotes = async (
  jobDir: string,
  info: VideoInfo,
  transcripts: ChunkTranscript[],
  options: RunOptions
): Promise<string | undefined> => {
  const model = options.notesModel;
  if (!model) {
    return undefined;
  }
  if (!options.notesModelInfo) {
    throw new Error("Notes require model preflight");
  }
  const evidence = buildEvidence(transcripts);
  const key = digest(
    JSON.stringify([
      "notes-v1",
      info.title,
      model,
      options.cloud.region,
      2048,
      evidence.map((item) => [
        item.id,
        item.text,
        item.start ?? null,
        item.end ?? null,
        item.chunkIndex,
        item.speaker ?? null,
      ]),
    ])
  );
  const notesPath = path.join(jobDir, `notes-${key}.json`);
  const saved = options.force
    ? undefined
    : await readCheckpoint(notesPath, notesResultSchema);
  if (saved && saved.cost === undefined) {
    throw new Error("Cached notes require a reported or unknown cost");
  }
  let notes = saved
    ? parseNotesResult(saved, evidence, model, saved.cost ?? null)
    : undefined;
  if (notes) {
    options.log("Using cached notes");
  } else {
    options.budget.reserve(
      estimateNotesCost(evidence, options.notesModelInfo),
      `notes for ${info.title}`
    );
    try {
      notes = await generateNotes(info, evidence, {
        apiKey: options.cloud.apiKey,
        maxTokens: 2048,
        model,
        region: options.cloud.region,
        retries: options.cloud.retries,
        signal: options.signal,
        timeoutMs: options.cloud.timeoutMs,
      });
    } catch (error) {
      options.budget.record(null);
      throw error;
    }
    options.budget.record(notes.cost);
    await atomicWrite(notesPath, JSON.stringify(notes));
  }
  if (!notes) {
    throw new Error("Missing generated notes");
  }
  const file = path.join(options.outDir, `${outputStem(info)}.notes.md`);
  await atomicWrite(file, renderNotes(info, evidence, notes));
  options.log(`Wrote ${file}`);
  return file;
};

export const runInput = async (
  input: string,
  options: RunOptions
): Promise<string[]> => {
  const { log, signal } = options;
  signal.throwIfAborted();
  if (options.backend === "local") {
    requireLocal(options);
  }
  log(`Opening ${input}`);
  const info = await resolveInput(input, options.downloadDir, signal);
  const source = await fingerprint(info.audioPath, signal);
  const jobDir = path.join(
    options.cacheDir,
    jobIdentity(info, source, options)
  );
  const unlock = await lockJob(jobDir);
  try {
    const manifest = await loadManifest(jobDir, info.audioPath, options);
    const { chunks } = manifest;
    const saved = await loadSaved(jobDir, chunks, options.force);
    const missingSeconds = chunks.reduce(
      (sum, chunk) => sum + (saved[chunk.index] ? 0 : chunk.end - chunk.start),
      0
    );
    const estimate = transcriptionEstimate(missingSeconds, options);
    log(
      `${info.title}: ${chunks.length} chunk(s), ${options.backend === "local" ? "offline whisper.cpp" : `${options.cloud.model} (${options.cloud.region})`}`
    );
    log(
      `${saved.filter(Boolean).length}/${chunks.length} cached; new transcription estimate ${estimate === null ? "unknown" : `$${estimate.toFixed(4)}`}`
    );
    if (options.dryRun) {
      if (options.notesModel) {
        log(
          "Notes estimate requires completed transcription; no paid requests made."
        );
      }
      return [];
    }
    if (missingSeconds > 0) {
      options.budget.reserve(estimate, `transcribing ${info.title}`);
    }
    const transcripts = await transcribeChunks(jobDir, chunks, saved, options);
    const outputs = await writeTranscripts(
      info,
      manifest,
      transcripts,
      options
    );
    const notesFile = await writeNotes(jobDir, info, transcripts, options);
    if (notesFile) {
      outputs.push(notesFile);
    }
    return outputs;
  } finally {
    await unlock();
  }
};
