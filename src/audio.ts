import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { mapLimit } from "./pool.ts";

export interface AudioChunk {
  index: number;
  /** Offset into the source audio, in seconds. */
  start: number;
  end: number;
  path: string;
}

export interface MediaProcessResult {
  stderr: string;
  stdout: string;
}

/** How far before a chunk boundary to look for a pause to cut at. */
const SILENCE_SEARCH_WINDOW = 30;

/** Waits for process closure, including on abort, before releasing callers. */
export const runMediaProcess = (
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
  name = executable
): Promise<MediaProcessResult> => {
  signal?.throwIfAborted();
  const { promise, resolve, reject } =
    Promise.withResolvers<MediaProcessResult>();
  const child = spawn(executable, [...args], {
    // yt-dlp can launch ffmpeg; cancel its entire process group on POSIX.
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let spawnError: Error | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = (terminationSignal: NodeJS.Signals) => {
    if (process.platform === "win32" || child.pid === undefined) {
      child.kill(terminationSignal);
      return;
    }
    try {
      process.kill(-child.pid, terminationSignal);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      ) {
        child.kill(terminationSignal);
      }
    }
  };
  const abort = () => {
    terminate("SIGTERM");
    killTimer = setTimeout(() => terminate("SIGKILL"), 1000);
    killTimer.unref();
  };
  child.stdout.on("data", (data: Buffer) => stdout.push(data));
  child.stderr.on("data", (data: Buffer) => stderr.push(data));
  child.on("error", (error) => {
    spawnError = error;
  });
  child.on("close", (code, terminationSignal) => {
    signal?.removeEventListener("abort", abort);
    clearTimeout(killTimer);
    const output = {
      stderr: Buffer.concat(stderr).toString("utf-8"),
      stdout: Buffer.concat(stdout).toString("utf-8"),
    };
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    } else if (spawnError) {
      reject(new Error(`${name} could not start: ${spawnError.message}`));
    } else if (code === 0) {
      resolve(output);
    } else {
      reject(
        new Error(
          `${name} failed (${code ?? terminationSignal}):\n${output.stderr.trim()}`
        )
      );
    }
  });
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    abort();
  }
  return promise;
};

export const parseDuration = (value: string): number => {
  const duration = Number(value.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Audio duration must be finite and positive");
  }
  return duration;
};

export const probeDuration = async (
  file: string,
  signal?: AbortSignal
): Promise<number> => {
  const result = await runMediaProcess(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      path.resolve(file),
    ],
    signal
  );
  return parseDuration(result.stdout);
};

/** Returns the midpoint (seconds) of every pause in the audio, ascending. */
const detectPauses = async (
  file: string,
  signal?: AbortSignal
): Promise<number[]> => {
  const result = await runMediaProcess(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-nostats",
      "-i",
      path.resolve(file),
      "-vn",
      "-af",
      "silencedetect=noise=-35dB:d=0.3",
      "-f",
      "null",
      "-",
    ],
    signal,
    "ffmpeg silencedetect"
  );
  const pauses: number[] = [];
  let silenceStart: number | undefined;
  for (const line of result.stderr.split("\n")) {
    const start = line.match(/silence_start: (?<time>-?[\d.]+)/u)?.groups?.time;
    if (start) {
      silenceStart = Math.max(Number(start), 0);
      continue;
    }
    const end = line.match(/silence_end: (?<time>[\d.]+)/u)?.groups?.time;
    if (end && silenceStart !== undefined) {
      pauses.push((silenceStart + Number(end)) / 2);
      silenceStart = undefined;
    }
  }
  return pauses;
};

/**
 * Picks cut points so no chunk exceeds `chunkSeconds`, preferring the latest
 * pause within the search window before each boundary to avoid splitting words.
 */
export const chooseCuts = (
  duration: number,
  chunkSeconds: number,
  pauses: number[]
): number[] => {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Audio duration must be finite and positive");
  }
  if (!Number.isFinite(chunkSeconds) || chunkSeconds <= 0) {
    throw new Error("Chunk duration must be finite and positive");
  }
  const validPauses = pauses
    .filter((pause) => Number.isFinite(pause) && pause > 0 && pause < duration)
    .toSorted((left, right) => left - right);
  const cuts: number[] = [];
  let previous = 0;
  while (duration - previous > chunkSeconds) {
    const target = previous + chunkSeconds;
    const windowStart = Math.max(previous, target - SILENCE_SEARCH_WINDOW);
    const cut =
      validPauses.findLast((p) => p > windowStart && p <= target) ?? target;
    cuts.push(cut);
    previous = cut;
  }
  return cuts;
};

/**
 * Re-encodes `file` into mono 16 kHz MP3 chunks of at most `chunkSeconds`,
 * cut at pauses where possible.
 */
export const splitAudio = async (
  file: string,
  chunkSeconds: number,
  outDir: string,
  options: { concurrency?: number; signal?: AbortSignal } = {}
): Promise<AudioChunk[]> => {
  if (!Number.isFinite(chunkSeconds) || chunkSeconds <= 0) {
    throw new Error("Chunk duration must be finite and positive");
  }
  const concurrency = options.concurrency ?? 2;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Encoder concurrency must be a positive integer");
  }
  options.signal?.throwIfAborted();
  const duration = await probeDuration(file, options.signal);
  const cuts =
    duration > chunkSeconds
      ? chooseCuts(
          duration,
          chunkSeconds,
          await detectPauses(file, options.signal)
        )
      : [];
  const bounds = [0, ...cuts, duration];
  await mkdir(outDir, { recursive: true });

  return await mapLimit(
    bounds.slice(0, -1),
    concurrency,
    async (start, index) => {
      const end = bounds[index + 1] ?? duration;
      const chunkPath = path.resolve(
        outDir,
        `chunk-${String(index).padStart(3, "0")}.mp3`
      );
      await runMediaProcess(
        "ffmpeg",
        [
          "-hide_banner",
          "-nostdin",
          "-v",
          "error",
          "-y",
          "-ss",
          String(start),
          "-t",
          String(end - start),
          "-i",
          path.resolve(file),
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "libmp3lame",
          "-b:a",
          "64k",
          chunkPath,
        ],
        options.signal
      );
      return { end, index, path: chunkPath, start };
    },
    options.signal
  );
};
