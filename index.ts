import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { splitAudio } from "./src/audio.ts";
import type { AudioChunk } from "./src/audio.ts";
import { downloadAudio } from "./src/download.ts";
import { renderMarkdown } from "./src/markdown.ts";
import type { ChunkTranscript } from "./src/markdown.ts";
import {
  BASE_URLS,
  DEFAULT_MODEL,
  DEFAULT_REGION,
  OpenRouterError,
  transcribe,
} from "./src/openrouter.ts";
import type { TranscribeOptions, Transcription } from "./src/openrouter.ts";

const DOWNLOAD_DIR = path.join(import.meta.dir, "downloads");
const CONCURRENCY = 3;

const USAGE = `Usage: bun run dikt <url> [options]

Downloads the audio of a video with yt-dlp, transcribes it through OpenRouter
and writes a Markdown transcript.

Options:
  -m, --model <slug>        OpenRouter STT model (default: ${DEFAULT_MODEL})
  -l, --language <code>     ISO-639-1 language hint, e.g. en, sv (default: auto)
  -r, --region <eu|global>  OpenRouter data region (default: ${DEFAULT_REGION})
                            eu = ${BASE_URLS.eu}, in-region routing (Business/Enterprise plan)
                            global = ${BASE_URLS.global}, needed for models not served in the EU
  -d, --diarize             Label speakers (Azure/Deepgram/Mistral-served models)
  -c, --chunk-minutes <n>   Max audio per request (default: 10)
  -o, --out <dir>           Output directory (default: <project>/transcripts)
  -h, --help                Show this help

Requires OPENROUTER_API_KEY (Bun loads it from .env).`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  args: Bun.argv.slice(2),
  options: {
    "chunk-minutes": { default: "10", short: "c", type: "string" },
    diarize: { default: false, short: "d", type: "boolean" },
    help: { default: false, short: "h", type: "boolean" },
    language: { short: "l", type: "string" },
    model: { default: DEFAULT_MODEL, short: "m", type: "string" },
    out: {
      default: path.join(import.meta.dir, "transcripts"),
      short: "o",
      type: "string",
    },
    region: { default: DEFAULT_REGION, short: "r", type: "string" },
  },
});

const [url] = positionals;
if (values.help || !url) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const apiKey = Bun.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is not set (add it to .env).");
  process.exit(1);
}

const chunkMinutes = Number(values["chunk-minutes"]);
if (!(chunkMinutes > 0)) {
  console.error(`Invalid --chunk-minutes: ${values["chunk-minutes"]}`);
  process.exit(1);
}

const { region } = values;
if (region !== "eu" && region !== "global") {
  console.error(`Invalid --region: ${region} (expected eu or global)`);
  process.exit(1);
}

const options: TranscribeOptions = {
  apiKey,
  diarize: values.diarize,
  language: values.language,
  model: values.model,
  region,
  timestamps: true,
};

const transcribeChunk = async (
  chunk: AudioChunk,
  total: number
): Promise<ChunkTranscript> => {
  const { timestamps } = options;
  let transcription: Transcription;
  try {
    transcription = await transcribe(chunk.path, { ...options, timestamps });
  } catch (error) {
    // Some models (e.g. openai/gpt-4o-transcribe) reject verbose_json with a 400. Retry without it; if the
    // retry fails too, the 400 had another cause (e.g. unsupported language) and that error is reported.
    if (
      !(error instanceof OpenRouterError && error.status === 400 && timestamps)
    ) {
      throw error;
    }
    transcription = await transcribe(chunk.path, {
      ...options,
      timestamps: false,
    });
    if (options.timestamps) {
      console.error(
        `  ! ${options.model} rejected timestamped output; continuing without timestamps`
      );
      options.timestamps = false;
    }
  }
  console.error(`  ✓ chunk ${chunk.index + 1}/${total}`);
  return { chunk, transcription };
};

/** Runs `fn` over `items` with at most `limit` in flight; stops scheduling after the first failure. */
const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = [];
  // Workers share one iterator, so each item is taken exactly once.
  const queue = items.entries();
  let failed = false;
  const worker = async () => {
    for (const [index, item] of queue) {
      if (failed) {
        return;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- bounded concurrency by design
        results[index] = await fn(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
};

const workDir = await mkdtemp(path.join(tmpdir(), "dikt-"));
try {
  console.error(`Downloading audio: ${url}`);
  const info = await downloadAudio(url, DOWNLOAD_DIR);
  console.error(`  → ${info.title} (${info.audioPath})`);

  const chunks = await splitAudio(info.audioPath, chunkMinutes * 60, workDir);
  console.error(
    `Transcribing ${chunks.length} chunk(s) with ${options.model} via ${BASE_URLS[region]}${options.diarize ? " (diarized)" : ""}`
  );
  const transcripts = await mapLimit(chunks, CONCURRENCY, (chunk) =>
    transcribeChunk(chunk, chunks.length)
  );

  const markdown = renderMarkdown(info, transcripts, {
    language: options.language,
    model: options.model,
    region,
    transcribedAt: new Date(),
  });
  const slug =
    info.title
      .normalize("NFKD")
      .replaceAll(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "")
      .slice(0, 80) || "video";
  await mkdir(values.out, { recursive: true });
  const outPath = path.join(values.out, `${slug}-${info.id}.md`);
  await Bun.write(outPath, markdown);

  const cost = transcripts.reduce((sum, t) => sum + t.transcription.cost, 0);
  console.error(`Wrote ${outPath} (cost $${cost.toFixed(4)})`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await rm(workDir, { force: true, recursive: true });
}
