import path from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import type { OutputFormat } from "./exports.ts";
import { DEFAULT_MODEL, DEFAULT_REGION } from "./settings.ts";
import type { Region } from "./settings.ts";

const ROOT = path.dirname(import.meta.dir);
export const USAGE = `Usage:
  bun run dikt <url-or-file> [more inputs...] [options]
  bun run dikt batch <list.txt> [options]
  bun run dikt playlist <url> [options]
  bun run dikt models [--region eu|global] [--modality transcription|text]

Transcribe video/audio to Markdown, JSON, SRT and VTT. Completed chunks resume
from disk; changing transcription options creates a separate job.

Options:
  -m, --model <slug>          Cloud STT model (default: ${DEFAULT_MODEL})
  -r, --region <eu|global>    Cloud region (default: ${DEFAULT_REGION}); never silently switches
  -l, --language <code>       ISO-639-1 language hint (default: auto)
  -d, --diarize               Request chunk-local speaker labels (cloud only)
  -c, --chunk-minutes <n>     Maximum audio per request (default: 10)
  -o, --out <dir>             Output directory (default: <project>/transcripts)
      --format <list>         Comma-separated md,json,srt,vtt (default: md)
      --backend <name>        openrouter (default) or local (whisper.cpp)
      --local-model <file>    whisper.cpp GGML model file for local backend
      --whisper-bin <path>    whisper-cli executable (default: whisper-cli)
      --prompt <text>         Context on providers supporting free-form prompts
      --vocabulary <term>     Expected vocabulary; repeat for more terms
      --speaker-name <key=name>  Repeat; one-based chunk:speaker, e.g. 1:1=Alice
      --notes                Write separate source-linked notes and exact quotes
      --notes-model <slug>    Notes model (cloud default: google/gemini-2.5-flash)
      --allow-cloud-notes     Local notes consent; also requires --notes-model
      --batch <file>          Additional list files, one input per line; repeatable
      --playlist             Expand positional URLs as playlists
      --concurrency <n>      Transcription workers (default: 3; local: 1)
      --encode-concurrency <n>  ffmpeg workers (default: 2)
      --timeout-seconds <n>  Cloud request timeout (default: 90)
      --retries <n>          Transient HTTP retries, 0–5 (default: 2)
      --max-cost <usd>       Estimated NEW request admission budget for this run;
                              not a billing cap; unknown pricing blocked
      --dry-run              Prepare inputs and show cache/estimates, no paid calls
      --force                Retranscribe instead of using saved results
      --cache <dir>          Job cache (default: <project>/.cache/dikt)
      --downloads <dir>      Downloads (default: <project>/downloads)
  -h, --help                  Show help

Cloud calls require OPENROUTER_API_KEY. EU routing requires a Business/Enterprise
plan. Local file transcription stays offline. Subtitles require real timestamps.`;

export interface CliRunOptions {
  backend: "openrouter" | "local";
  region: Region;
  model: string;
  language: string | undefined;
  diarize: boolean;
  prompt: string | undefined;
  vocabulary: string[];
  speakerNames: Record<string, string>;
  localModel: string | undefined;
  whisperBin: string;
  notesModel: string | undefined;
  chunkSeconds: number;
  concurrency: number;
  encodeConcurrency: number;
  timeoutMs: number;
  retries: number;
  maximumCost: number | undefined;
  cacheDir: string;
  downloadDir: string;
  outDir: string;
  formats: OutputFormat[];
  force: boolean;
  dryRun: boolean;
}
export type CliCommand =
  | { kind: "help" }
  | { kind: "models"; region: Region; modality: "transcription" | "text" }
  | {
      kind: "run";
      inputs: string[];
      batchFiles: string[];
      playlist: boolean;
      options: CliRunOptions;
    };

const positiveNumber = (value: string, flag: string): number => {
  const result = z.coerce.number().positive().safeParse(value);
  if (!result.success) {
    throw new Error(`${flag} must be a finite positive number`, {
      cause: result.error,
    });
  }
  return result.data;
};
const integer = (
  value: string,
  flag: string,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER
): number => {
  const result = z.coerce
    .number()
    .int()
    .min(minimum)
    .max(maximum)
    .safeParse(value);
  if (!result.success) {
    throw new Error(
      `${flag} must be an integer from ${minimum} to ${maximum}`,
      { cause: result.error }
    );
  }
  return result.data;
};
const formatsFrom = (value: string): OutputFormat[] => {
  const choices = [...new Set(value.split(",").map((format) => format.trim()))];
  return z
    .array(z.enum(["md", "json", "srt", "vtt"]))
    .min(1)
    .parse(choices);
};
const speakerEntry = z
  .string()
  .regex(/^[1-9]\d*:[1-9]\d*=.+$/u)
  .transform((entry) => {
    const separator = entry.indexOf("=");
    return {
      key: entry.slice(0, separator),
      name: entry.slice(separator + 1).trim(),
    };
  })
  .refine((entry) => entry.name.length > 0, "Speaker name must not be blank");
const speakerMap = (values: string[], diarize: boolean) => {
  if (values.length && !diarize) {
    throw new Error("--speaker-name requires --diarize; IDs are chunk-local");
  }
  const names: Record<string, string> = {};
  for (const entry of z.array(speakerEntry).parse(values)) {
    if (names[entry.key]) {
      throw new Error(`Duplicate speaker name: ${entry.key}`);
    }
    names[entry.key] = entry.name;
  }
  return names;
};
const chooseNotes = (
  backend: "local" | "openrouter",
  enabled: boolean,
  explicitModel: string | undefined,
  cloudConsent: boolean
): string | undefined => {
  if (!enabled) {
    return undefined;
  }
  if (backend === "local" && (!cloudConsent || !explicitModel)) {
    throw new Error(
      "Local transcripts stay offline: notes require --allow-cloud-notes and an explicit --notes-model"
    );
  }
  return z
    .string()
    .trim()
    .min(1)
    .parse(explicitModel ?? "google/gemini-2.5-flash");
};
const maximumCost = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const result = z.coerce.number().nonnegative().safeParse(value);
  if (!value.trim() || !result.success) {
    throw new Error("--max-cost must be a finite, nonnegative USD amount");
  }
  return result.data;
};

export const parseCli = (args: string[]): CliCommand => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      "allow-cloud-notes": { default: false, type: "boolean" },
      backend: { default: "openrouter", type: "string" },
      batch: { default: [], multiple: true, type: "string" },
      cache: { default: path.join(ROOT, ".cache", "dikt"), type: "string" },
      "chunk-minutes": { default: "10", short: "c", type: "string" },
      concurrency: { type: "string" },
      diarize: { default: false, short: "d", type: "boolean" },
      downloads: { default: path.join(ROOT, "downloads"), type: "string" },
      "dry-run": { default: false, type: "boolean" },
      "encode-concurrency": { default: "2", type: "string" },
      force: { default: false, type: "boolean" },
      format: { default: "md", type: "string" },
      help: { default: false, short: "h", type: "boolean" },
      language: { short: "l", type: "string" },
      "local-model": { type: "string" },
      "max-cost": { type: "string" },
      modality: { default: "transcription", type: "string" },
      model: { default: DEFAULT_MODEL, short: "m", type: "string" },
      notes: { default: false, type: "boolean" },
      "notes-model": { type: "string" },
      out: {
        default: path.join(ROOT, "transcripts"),
        short: "o",
        type: "string",
      },
      playlist: { default: false, type: "boolean" },
      prompt: { type: "string" },
      region: { default: DEFAULT_REGION, short: "r", type: "string" },
      retries: { default: "2", type: "string" },
      "speaker-name": { default: [], multiple: true, type: "string" },
      "timeout-seconds": { default: "90", type: "string" },
      vocabulary: { default: [], multiple: true, type: "string" },
      "whisper-bin": { default: "whisper-cli", type: "string" },
    },
  });
  if (values.help) {
    return { kind: "help" };
  }
  const region = z.enum(["eu", "global"]).parse(values.region);
  const [command] = positionals;
  if (command === "models") {
    if (positionals.length !== 1) {
      throw new Error("models takes no positional input");
    }
    return {
      kind: "models",
      modality: z.enum(["transcription", "text"]).parse(values.modality),
      region,
    };
  }
  const backend = z.enum(["openrouter", "local"]).parse(values.backend);
  const chunkSeconds =
    positiveNumber(values["chunk-minutes"], "--chunk-minutes") * 60;
  if (!Number.isFinite(chunkSeconds)) {
    throw new TypeError("--chunk-minutes is too large");
  }
  const timeoutMs =
    positiveNumber(values["timeout-seconds"], "--timeout-seconds") * 1000;
  if (!Number.isSafeInteger(timeoutMs)) {
    throw new TypeError(
      "--timeout-seconds must resolve to safe integer milliseconds"
    );
  }
  const inputs = ["batch", "playlist", "transcribe"].includes(command ?? "")
    ? positionals.slice(1)
    : positionals;
  let batchFiles = values.batch;
  if (command === "batch") {
    const [file] = inputs;
    if (inputs.length !== 1 || !file) {
      throw new Error("batch requires exactly one list file");
    }
    batchFiles = [file, ...batchFiles];
    inputs.length = 0;
  }
  if (!inputs.length && !batchFiles.length) {
    throw new Error(`No input supplied.\n${USAGE}`);
  }
  const options: CliRunOptions = {
    backend,
    cacheDir: path.resolve(values.cache),
    chunkSeconds,
    concurrency: integer(
      values.concurrency ?? (backend === "local" ? "1" : "3"),
      "--concurrency"
    ),
    diarize: values.diarize,
    downloadDir: path.resolve(values.downloads),
    dryRun: values["dry-run"],
    encodeConcurrency: integer(
      values["encode-concurrency"],
      "--encode-concurrency"
    ),
    force: values.force,
    formats: formatsFrom(values.format),
    language: z
      .string()
      .regex(/^[a-z]{2}$/u)
      .optional()
      .parse(values.language),
    localModel: values["local-model"],
    maximumCost: maximumCost(values["max-cost"]),
    model: z.string().min(1).parse(values.model),
    notesModel: chooseNotes(
      backend,
      values.notes || values["notes-model"] !== undefined,
      values["notes-model"],
      values["allow-cloud-notes"]
    ),
    outDir: path.resolve(values.out),
    prompt: values.prompt?.trim() || undefined,
    region,
    retries: integer(values.retries, "--retries", 0, 5),
    speakerNames: speakerMap(values["speaker-name"], values.diarize),
    timeoutMs,
    vocabulary: z.array(z.string().trim().min(1)).parse(values.vocabulary),
    whisperBin: values["whisper-bin"],
  };
  return {
    batchFiles,
    inputs,
    kind: "run",
    options,
    playlist: values.playlist || command === "playlist",
  };
};
