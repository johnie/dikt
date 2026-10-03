import path from "node:path";

import { Budget } from "./src/budget.ts";
import { fingerprint } from "./src/cache.ts";
import { parseCli, USAGE } from "./src/cli.ts";
import type { CliCommand, CliRunOptions } from "./src/cli.ts";
import { expandPlaylist } from "./src/download.ts";
import { validateLocal } from "./src/local.ts";
import type { LocalOptions } from "./src/local.ts";
import { listModels, preflight } from "./src/models.ts";
import type { ModelInfo } from "./src/models.ts";
import { runInput } from "./src/pipeline.ts";
import type { RunOptions } from "./src/pipeline.ts";
import { mapLimit } from "./src/pool.ts";
import { BASE_URLS } from "./src/settings.ts";

const capability = (value: boolean | null): string => {
  if (value === null) {
    return "unknown";
  }
  return value ? "yes" : "no";
};
const showModels = (models: ModelInfo[], region: string): void => {
  console.log(
    `Region: ${region}; unknown means the catalog does not establish support.`
  );
  console.log(
    "MODEL\tLANGUAGES\tTIMESTAMPS\tDIARIZATION\tVOCABULARY\tUSD/SECOND"
  );
  for (const model of models) {
    console.log(
      [
        model.id,
        model.languages?.join(",") ?? "unknown",
        capability(model.timestamps),
        capability(model.diarization),
        capability(model.vocabulary),
        model.pricePerSecond ?? "unknown",
      ].join("\t")
    );
  }
};

const readBatch = async (file: string): Promise<string[]> => {
  const absolute = path.resolve(file);
  const content = await Bun.file(absolute).text();
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    throw new Error(`Empty batch file: ${absolute}`);
  }
  return lines.map((line) =>
    /^(?:https?:\/\/|file:)/iu.test(line)
      ? line
      : path.resolve(path.dirname(absolute), line)
  );
};
const expandInputs = async (
  command: Extract<CliCommand, { kind: "run" }>,
  signal: AbortSignal
): Promise<string[]> => {
  const inputs = [...command.inputs];
  const batches = await mapLimit(command.batchFiles, 1, readBatch, signal);
  for (const batch of batches) {
    inputs.push(...batch);
  }
  if (command.playlist) {
    const expanded: string[] = [];
    const playlists = await mapLimit(
      inputs,
      1,
      (input) => expandPlaylist(input, signal),
      signal
    );
    for (const playlist of playlists) {
      expanded.push(...playlist);
    }
    return [...new Set(expanded)];
  }
  return [...new Set(inputs)];
};

const prepareRun = async (
  options: CliRunOptions,
  signal: AbortSignal
): Promise<RunOptions> => {
  const apiKey = Bun.env.OPENROUTER_API_KEY ?? "";
  let local: LocalOptions | undefined;
  let modelFingerprint: string | undefined;
  let modelInfo: ModelInfo | undefined;
  let notesModelInfo: ModelInfo | undefined;
  if (options.backend === "local") {
    if (!options.localModel) {
      throw new Error(
        "--backend local requires --local-model <GGML model file>"
      );
    }
    if (options.diarize) {
      throw new Error(
        "The local whisper.cpp backend does not support speaker diarization"
      );
    }
    const localPrompt =
      [
        options.prompt,
        options.vocabulary.length
          ? `Expected vocabulary: ${options.vocabulary.join(", ")}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n") || undefined;
    local = {
      executable: options.whisperBin,
      language: options.language,
      modelPath: path.resolve(options.localModel),
      prompt: localPrompt,
      signal,
    };
    await validateLocal(local);
    modelFingerprint = await fingerprint(local.modelPath, signal);
  }
  if (options.backend === "openrouter" || options.notesModel) {
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is not set (add it to .env)");
    }
    console.error(
      `Cloud region: ${options.region} (${BASE_URLS[options.region]})${options.region === "eu" ? "; Business/Enterprise plan required" : "; audio/text may be processed outside the EU"}`
    );
  }
  if (options.backend === "openrouter") {
    modelInfo = await preflight(options.model, options.region, {
      apiKey,
      diarize: options.diarize,
      language: options.language,
      prompt: options.prompt,
      signal,
      vocabulary: options.vocabulary,
    });
    if (
      modelInfo.timestamps === false &&
      options.formats.some((format) => format === "srt" || format === "vtt")
    ) {
      throw new Error(
        `Model ${options.model} does not provide the speech timestamps required by SRT/VTT; choose Markdown or JSON instead`
      );
    }
  }
  if (options.notesModel) {
    notesModelInfo = await preflight(options.notesModel, options.region, {
      apiKey,
      modality: "text",
      signal,
    });
  }
  if (options.maximumCost !== undefined) {
    console.error(
      "--max-cost limits estimated admitted requests, not provider billing; failed/retried requests may be charged."
    );
  }
  return {
    backend: options.backend,
    budget: new Budget(options.maximumCost),
    cacheDir: options.cacheDir,
    chunkSeconds: options.chunkSeconds,
    cloud: {
      apiKey,
      diarize: options.diarize,
      language: options.language,
      model: options.model,
      prompt: local?.prompt ?? options.prompt,
      region: options.region,
      retries: options.retries,
      signal,
      timeoutMs: options.timeoutMs,
      timestamps: modelInfo?.timestamps !== false,
      vocabulary: options.vocabulary,
    },
    concurrency: options.concurrency,
    downloadDir: options.downloadDir,
    dryRun: options.dryRun,
    encodeConcurrency: options.encodeConcurrency,
    force: options.force,
    formats: options.formats,
    local,
    log: (message) => console.error(message),
    modelFingerprint,
    modelInfo,
    notesModel: options.notesModel,
    notesModelInfo,
    outDir: options.outDir,
    signal,
    speakerNames: options.speakerNames,
  };
};

const runBatch = async (
  inputs: string[],
  options: RunOptions
): Promise<void> => {
  let failures = 0;
  await mapLimit(
    inputs,
    1,
    async (input) => {
      options.signal.throwIfAborted();
      try {
        await runInput(input, options);
      } catch (error) {
        failures += 1;
        console.error(
          `${input}: ${error instanceof Error ? error.message : String(error)}`
        );
        options.signal.throwIfAborted();
      }
    },
    options.signal
  );
  console.error(
    `${inputs.length - failures}/${inputs.length} input(s) completed; ${options.budget.describe()}`
  );
  if (failures) {
    process.exitCode = 1;
  }
};

const main = async (): Promise<void> => {
  const command = parseCli(Bun.argv.slice(2));
  if (command.kind === "help") {
    console.log(USAGE);
    return;
  }
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(
      new Error("Interrupted; completed chunks are saved for resume")
    );
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const { signal } = controller;
  try {
    if (command.kind === "models") {
      showModels(
        await listModels(command.region, {
          apiKey: Bun.env.OPENROUTER_API_KEY,
          modality: command.modality,
          signal,
        }),
        command.region
      );
      return;
    }
    const options = await prepareRun(command.options, signal);
    const inputs = await expandInputs(command, signal);
    await runBatch(inputs, options);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
