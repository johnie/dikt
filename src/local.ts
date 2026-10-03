import { constants } from "node:fs";
import { access, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { runMediaProcess } from "./audio.ts";
import type { Transcription } from "./openrouter.ts";

export interface LocalOptions {
  modelPath: string;
  executable?: string;
  language?: string;
  prompt?: string;
  signal?: AbortSignal;
}

// Official whisper.cpp language IDs, including automatic detection.
// https://github.com/ggml-org/whisper.cpp/blob/master/src/whisper.cpp
const LANGUAGES: Record<string, true> = Object.fromEntries(
  "auto en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue"
    .split(" ")
    .map((language) => [language, true])
);

const localExecutable = (options: LocalOptions): string => {
  const requested = options.executable ?? "whisper-cli";
  const executable = Bun.which(requested);
  if (!executable) {
    throw new Error(
      `Offline executable not found: ${requested}. Install whisper.cpp and select whisper-cli.`
    );
  }
  return executable;
};

/** Checks offline requirements before downloading, splitting, or encoding audio. */
export const validateLocal = async (options: LocalOptions): Promise<void> => {
  options.signal?.throwIfAborted();
  const language = options.language ?? "auto";
  if (!Object.hasOwn(LANGUAGES, language)) {
    throw new Error(
      `Unsupported whisper.cpp language: ${language}. Use an ISO language code or auto.`
    );
  }
  const executable = localExecutable(options);
  await access(executable, constants.X_OK);
  if (!options.modelPath) {
    throw new Error(
      "Offline transcription requires a local whisper.cpp GGML model path"
    );
  }
  const modelPath = path.resolve(options.modelPath);
  const model = await stat(modelPath);
  if (!model.isFile() || model.size < 48) {
    throw new Error("Whisper model must be a nonempty GGML model file");
  }
  const handle = await open(modelPath, "r");
  try {
    const header = Buffer.alloc(48);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    // GGML_FILE_MAGIC followed by the eleven whisper model hyperparameters.
    if (
      bytesRead !== header.length ||
      header.readUInt32LE(0) !== 0x67_67_6d_6c
    ) {
      throw new Error("Invalid whisper.cpp model: expected a GGML model file");
    }
    const vocabulary = header.readInt32LE(4);
    if (vocabulary < 51_864) {
      throw new Error("Invalid whisper.cpp model vocabulary");
    }
    if (vocabulary === 51_864 && language !== "auto" && language !== "en") {
      throw new Error(
        `English-only whisper model cannot transcribe language ${language}`
      );
    }
  } finally {
    await handle.close();
  }
  const help = await runMediaProcess(
    executable,
    ["--help"],
    options.signal,
    "whisper-cli validation"
  );
  if (!`${help.stdout}\n${help.stderr}`.includes("--output-json-full")) {
    throw new Error(
      "Offline executable must be whisper-cli with --output-json-full support"
    );
  }
  options.signal?.throwIfAborted();
};

const timestampSchema = z
  .string()
  .regex(/^\d+:[0-5]\d:[0-5]\d[,.]\d{3}$/u, "Invalid whisper.cpp timestamp")
  .transform((timestamp) => {
    const [hours, minutes, seconds] = timestamp.replace(",", ".").split(":");
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  })
  .pipe(z.number().nonnegative());

const offsetSegmentSchema = z
  .object({
    offsets: z.object({
      from: z.number().nonnegative(),
      to: z.number().nonnegative(),
    }),
    text: z.string(),
  })
  .transform((segment) => ({
    end: segment.offsets.to / 1000,
    start: segment.offsets.from / 1000,
    text: segment.text,
  }));

const timestampSegmentSchema = z
  .object({
    offsets: z.null().optional(),
    text: z.string(),
    timestamps: z.object({ from: timestampSchema, to: timestampSchema }),
  })
  .transform((segment) => ({
    end: segment.timestamps.to,
    start: segment.timestamps.from,
    text: segment.text,
  }));

const whisperSegmentSchema = z
  .union([offsetSegmentSchema, timestampSegmentSchema])
  .refine(
    (segment) => segment.end >= segment.start,
    "Whisper.cpp segment has invalid timestamp bounds"
  );

const whisperSchema = z
  .object({
    result: z.object({
      language: z.string().refine((language) => language.trim().length > 0),
    }),
    transcription: z.array(whisperSegmentSchema),
  })
  .transform((output): Transcription => ({
    cost: 0,
    language: output.result.language,
    segments: output.transcription,
    text: output.transcription
      .map((segment) => segment.text.trim())
      .filter(Boolean)
      .join(" "),
    // Whisper tokens are subword pieces, not words. Segment timings remain exact.
    words: undefined,
  }));

/** Parses real whisper-cli full JSON; offsets are milliseconds, not seconds. */
export const parseWhisperJson = whisperSchema.parse.bind(whisperSchema);

export const transcribeLocal = async (
  audioPath: string,
  options: LocalOptions
): Promise<Transcription> => {
  await validateLocal(options);
  const executable = localExecutable(options);
  const dir = await mkdtemp(path.join(tmpdir(), "dikt-whisper-"));
  try {
    const wav = path.join(dir, "audio.wav");
    await runMediaProcess(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-i",
        path.resolve(audioPath),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        wav,
      ],
      options.signal
    );
    const output = path.join(dir, "transcription");
    const args = [
      "--model",
      path.resolve(options.modelPath),
      "--file",
      wav,
      "--language",
      options.language ?? "auto",
      "--output-json-full",
      "--output-file",
      output,
    ];
    if (options.prompt !== undefined) {
      args.push("--prompt", options.prompt);
    }
    await runMediaProcess(executable, args, options.signal, "whisper-cli");
    options.signal?.throwIfAborted();
    return parseWhisperJson(await Bun.file(`${output}.json`).json());
  } finally {
    // runMediaProcess settles only after the child has closed its files/streams.
    await rm(dir, { force: true, recursive: true });
  }
};
