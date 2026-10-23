import path from "node:path";

import { cli } from "cleye";
import type { Flags } from "cleye";
import kleur from "kleur";
import { z } from "zod";

import type { OutputFormat } from "./exports.ts";
import { DEFAULT_MODEL, DEFAULT_REGION } from "./settings.ts";
import type { Region } from "./settings.ts";

const ROOT = path.dirname(import.meta.dir);

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
  | { kind: "help"; showHelp: () => void }
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

const flags = {
  allowCloudNotes: {
    default: false,
    description:
      "Consent to cloud notes for local transcripts; requires --notes-model",
    type: Boolean,
  },
  backend: {
    default: "openrouter",
    description: "Transcription backend: openrouter or local (whisper.cpp)",
    type: String,
  },
  batch: {
    description: "Additional list file, one input per line; repeatable",
    placeholder: "<file>",
    type: [String],
  },
  cache: {
    default: path.join(ROOT, ".cache", "dikt"),
    description: "Resumable job cache",
    placeholder: "<dir>",
    type: String,
  },
  chunkMinutes: {
    alias: "c",
    default: "10",
    description: "Maximum audio per request",
    placeholder: "<minutes>",
    type: String,
  },
  concurrency: {
    description: "Transcription workers (default: 3 cloud, 1 local)",
    placeholder: "<n>",
    type: String,
  },
  diarize: {
    alias: "d",
    default: false,
    description: "Request chunk-local speaker labels (cloud only)",
    type: Boolean,
  },
  downloads: {
    default: path.join(ROOT, "downloads"),
    description: "Downloaded media directory",
    placeholder: "<dir>",
    type: String,
  },
  dryRun: {
    default: false,
    description: "Prepare inputs and show cache/estimates without paid calls",
    type: Boolean,
  },
  encodeConcurrency: {
    default: "2",
    description: "ffmpeg workers",
    placeholder: "<n>",
    type: String,
  },
  force: {
    default: false,
    description: "Retranscribe instead of using saved results",
    type: Boolean,
  },
  format: {
    default: "md",
    description: "Comma-separated md,json,srt,vtt",
    placeholder: "<list>",
    type: String,
  },
  help: { alias: "h", default: false, description: "Show help", type: Boolean },
  language: {
    alias: "l",
    description: "ISO-639-1 language hint (default: auto)",
    placeholder: "<code>",
    type: String,
  },
  localModel: {
    description: "whisper.cpp GGML model for the local backend",
    placeholder: "<file>",
    type: String,
  },
  maxCost: {
    description:
      "Estimated NEW request budget; not a billing cap; unknown pricing blocked",
    placeholder: "<usd>",
    type: String,
  },
  modality: {
    default: "transcription",
    description: "Model catalog modality (models command)",
    placeholder: "<transcription|text>",
    type: String,
  },
  model: {
    alias: "m",
    default: DEFAULT_MODEL,
    description: "Cloud transcription model",
    placeholder: "<slug>",
    type: String,
  },
  notes: {
    default: false,
    description: "Write separate source-linked notes and exact quotes",
    type: Boolean,
  },
  notesModel: {
    description:
      "Enable notes with this model (cloud default: google/gemini-2.5-flash)",
    placeholder: "<slug>",
    type: String,
  },
  out: {
    alias: "o",
    default: path.join(ROOT, "transcripts"),
    description: "Transcript and notes directory",
    placeholder: "<dir>",
    type: String,
  },
  playlist: {
    default: false,
    description: "Expand positional URLs as playlists",
    type: Boolean,
  },
  prompt: {
    description: "Context on providers supporting free-form prompts",
    placeholder: "<text>",
    type: String,
  },
  region: {
    alias: "r",
    default: DEFAULT_REGION,
    description: "Cloud region; never silently switches",
    placeholder: "<eu|global>",
    type: String,
  },
  retries: {
    default: "2",
    description: "Transient HTTP retries, 0–5",
    placeholder: "<n>",
    type: String,
  },
  speakerName: {
    description: "Repeatable one-based speaker assignment, e.g. 1:1=Alice",
    placeholder: "<chunk:speaker=name>",
    type: [String],
  },
  timeoutSeconds: {
    default: "90",
    description: "Cloud request timeout",
    placeholder: "<seconds>",
    type: String,
  },
  vocabulary: {
    description: "Expected vocabulary; repeatable",
    placeholder: "<term>",
    type: [String],
  },
  whisperBin: {
    default: "whisper-cli",
    description: "whisper-cli executable",
    placeholder: "<path>",
    type: String,
  },
} satisfies Flags;

const parseArgv = (args: string[]) => {
  const argv = cli(
    {
      flags,
      help: false,
      name: "dikt",
    },
    undefined,
    [...args]
  );
  const unknown = Object.keys(argv.unknownFlags);
  if (unknown.length) {
    throw new Error(
      `Unknown option(s): ${unknown.map((flag) => `--${flag}`).join(", ")}. Run bun run dikt --help.`
    );
  }
  for (const [name, value] of Object.entries(argv.flags)) {
    if (value === "" || (Array.isArray(value) && value.includes(""))) {
      const flag = name.replaceAll(
        /[A-Z]/gu,
        (letter) => `-${letter.toLowerCase()}`
      );
      throw new Error(`Option --${flag} requires a value`);
    }
  }
  return argv;
};

const commandUsage = {
  batch: "bun run dikt batch <list.txt> [flags...]",
  models: "bun run dikt models [flags...]",
  playlist: "bun run dikt playlist <url> [more URLs...] [flags...]",
  transcribe:
    "bun run dikt transcribe <url-or-file> [more inputs...] [flags...]",
};

const showCliHelp = (command: string | undefined): void => {
  const helpFlags =
    command === "models"
      ? { help: flags.help, modality: flags.modality, region: flags.region }
      : flags;
  const { showHelp: renderHelp } = cli(
    { flags: helpFlags, help: false, name: "dikt" },
    undefined,
    []
  );
  renderHelp({
    description:
      command === "models"
        ? "List regional model capabilities and pricing. Unknown support remains unknown."
        : "Transcribe video/audio to Markdown, JSON, SRT and VTT.\nCompleted chunks resume from disk; changed transcription options create a separate job.",
    examples:
      command === "models"
        ? [
            "bun run dikt models --region eu",
            "bun run dikt models --region global --modality text",
          ]
        : [
            "bun run dikt ./meeting.mp4 --language en --format md,json,srt,vtt",
            "bun run dikt batch ./sources.txt --dry-run",
            "bun run dikt ./meeting.wav --backend local --local-model ./models/ggml-small.bin",
          ],
    usage: Object.entries(commandUsage).find(
      ([name]) => name === command
    )?.[1] ?? [
      "bun run dikt <url-or-file> [more inputs...] [flags...]",
      ...Object.values(commandUsage),
    ],
  });
  console.log(
    kleur.dim(
      "Cloud calls require OPENROUTER_API_KEY. EU routing requires a Business/Enterprise plan.\nLocal file transcription stays offline. Subtitles require real timestamps."
    )
  );
};

export const parseCli = (args: string[]): CliCommand => {
  const argv = parseArgv(args);
  const values = argv.flags;
  const positionals = argv._;
  const [command] = positionals;
  if (values.help || args.length === 0) {
    return {
      kind: "help",
      showHelp: () => showCliHelp(command),
    };
  }
  const region = z.enum(["eu", "global"]).parse(values.region);
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
    positiveNumber(values.chunkMinutes, "--chunk-minutes") * 60;
  if (!Number.isFinite(chunkSeconds)) {
    throw new TypeError("--chunk-minutes is too large");
  }
  const timeoutMs =
    positiveNumber(values.timeoutSeconds, "--timeout-seconds") * 1000;
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
    throw new Error("No input supplied. Run bun run dikt --help for usage.");
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
    dryRun: values.dryRun,
    encodeConcurrency: integer(
      values.encodeConcurrency,
      "--encode-concurrency"
    ),
    force: values.force,
    formats: formatsFrom(values.format),
    language: z
      .string()
      .regex(/^[a-z]{2}$/u)
      .optional()
      .parse(values.language),
    localModel: values.localModel,
    maximumCost: maximumCost(values.maxCost),
    model: z.string().min(1).parse(values.model),
    notesModel: chooseNotes(
      backend,
      values.notes || values.notesModel !== undefined,
      values.notesModel,
      values.allowCloudNotes
    ),
    outDir: path.resolve(values.out),
    prompt: values.prompt?.trim() || undefined,
    region,
    retries: integer(values.retries, "--retries", 0, 5),
    speakerNames: speakerMap(values.speakerName, values.diarize),
    timeoutMs,
    vocabulary: z.array(z.string().trim().min(1)).parse(values.vocabulary),
    whisperBin: values.whisperBin,
  };
  return {
    batchFiles,
    inputs,
    kind: "run",
    options,
    playlist: values.playlist || command === "playlist",
  };
};
