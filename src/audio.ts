import path from "node:path";

import { $ } from "bun";

export interface AudioChunk {
  index: number;
  /** Offset into the source audio, in seconds. */
  start: number;
  end: number;
  path: string;
}

/** How far before a chunk boundary to look for a pause to cut at. */
const SILENCE_SEARCH_WINDOW = 30;

const run = async (cmd: $.ShellPromise, name: string) => {
  const result = await cmd.nothrow().quiet();
  if (result.exitCode !== 0) {
    throw new Error(`${name} failed:\n${result.stderr.toString().trim()}`);
  }
  return result;
};

const probeDuration = async (file: string): Promise<number> => {
  const result = await run(
    $`ffprobe -v error -show_entries format=duration -of csv=p=0 ${file}`,
    "ffprobe"
  );
  const duration = Number(result.text());
  if (!(duration > 0)) {
    throw new Error(`Could not determine duration of ${file}`);
  }
  return duration;
};

/** Returns the midpoint (seconds) of every pause in the audio, ascending. */
const detectPauses = async (file: string): Promise<number[]> => {
  const result = await run(
    $`ffmpeg -hide_banner -nostats -i ${file} -vn -af silencedetect=noise=-35dB:d=0.3 -f null -`,
    "ffmpeg silencedetect"
  );
  const pauses: number[] = [];
  let silenceStart: number | undefined;
  for (const line of result.stderr.toString().split("\n")) {
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
const chooseCuts = (
  duration: number,
  chunkSeconds: number,
  pauses: number[]
): number[] => {
  const cuts: number[] = [];
  let previous = 0;
  while (duration - previous > chunkSeconds) {
    const target = previous + chunkSeconds;
    const windowStart = Math.max(previous, target - SILENCE_SEARCH_WINDOW);
    const cut =
      pauses.findLast((p) => p > windowStart && p <= target) ?? target;
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
  outDir: string
): Promise<AudioChunk[]> => {
  const duration = await probeDuration(file);
  const cuts =
    duration > chunkSeconds
      ? chooseCuts(duration, chunkSeconds, await detectPauses(file))
      : [];
  const bounds = [0, ...cuts, duration];

  return await Promise.all(
    bounds.slice(0, -1).map(async (start, index) => {
      const end = bounds[index + 1] ?? duration;
      const chunkPath = path.join(
        outDir,
        `chunk-${String(index).padStart(3, "0")}.mp3`
      );
      await run(
        $`ffmpeg -hide_banner -v error -y -ss ${start} -t ${end - start} -i ${file} -vn -ac 1 -ar 16000 -c:a libmp3lame -b:a 64k ${chunkPath}`,
        "ffmpeg"
      );
      return { end, index, path: chunkPath, start };
    })
  );
};
