import { createHash } from "node:crypto";

import type { VideoInfo } from "./download.ts";
import { renderMarkdown, speakerLabel, timedSegments } from "./markdown.ts";
import type { ChunkTranscript, RenderOptions } from "./markdown.ts";

export type OutputFormat = "md" | "json" | "srt" | "vtt";

export interface TranscriptEvidence {
  id: string;
  text: string;
  start?: number;
  end?: number;
  chunkIndex: number;
  speaker?: number;
}

/** Chunk offsets are real media boundaries, but never substitute for speech timings. */
export const buildEvidence = (
  transcripts: ChunkTranscript[]
): TranscriptEvidence[] =>
  transcripts.flatMap<TranscriptEvidence>(({ chunk, transcription }) => {
    const segments = timedSegments(transcription, chunk.end - chunk.start);
    if (segments && Number.isFinite(chunk.start) && chunk.start >= 0) {
      return segments.map((segment, index) => {
        const item: TranscriptEvidence = {
          chunkIndex: chunk.index,
          end: chunk.start + segment.end,
          id: `c${chunk.index + 1}-s${index + 1}`,
          start: chunk.start + segment.start,
          text: segment.text.trim(),
        };
        if (segment.speaker !== undefined) {
          item.speaker = segment.speaker;
        }
        return item;
      });
    }
    const text =
      transcription.text.trim() ||
      transcription.segments
        ?.map((segment) => segment.text)
        .join(" ")
        .trim() ||
      transcription.words
        ?.map((word) => word.word)
        .join(" ")
        .trim() ||
      "";
    return text
      ? [{ chunkIndex: chunk.index, id: `c${chunk.index + 1}-p1`, text }]
      : [];
  });

const subtitleTimestamp = (seconds: number, format: "srt" | "vtt"): string => {
  const total = Math.round(seconds * 1000);
  const milliseconds = String(total % 1000).padStart(3, "0");
  const wholeSeconds = Math.floor(total / 1000);
  const hours = String(Math.floor(wholeSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((wholeSeconds % 3600) / 60)).padStart(
    2,
    "0"
  );
  const remainder = String(wholeSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${remainder}${format === "srt" ? "," : "."}${milliseconds}`;
};

export const renderOutput = (
  format: OutputFormat,
  info: VideoInfo,
  transcripts: ChunkTranscript[],
  options: RenderOptions
): string => {
  if (format === "md") {
    return renderMarkdown(info, transcripts, options);
  }
  const evidence = buildEvidence(transcripts);
  if (format === "json") {
    // Preserve provider responses verbatim; only temporary local media paths are omitted.
    const { audioPath: _audioPath, ...source } = info;
    return `${JSON.stringify(
      {
        chunks: transcripts.map(({ chunk, transcription }) => ({
          chunk: { end: chunk.end, index: chunk.index, start: chunk.start },
          transcription,
        })),
        evidence,
        metadata: {
          ...source,
          language:
            options.language ??
            transcripts.find(({ transcription }) => transcription.language)
              ?.transcription.language,
          model: options.model,
          region: options.region,
          speakerNames: options.speakerNames,
          transcribedAt: options.transcribedAt.toISOString(),
        },
        version: 1,
      },
      null,
      2
    )}\n`;
  }
  if (format !== "srt" && format !== "vtt") {
    throw new Error(`Unsupported output format: ${format}`);
  }
  const untimed = evidence.find(
    (item) => item.start === undefined || item.end === undefined
  );
  if (untimed) {
    throw new Error(
      `Cannot export ${format.toUpperCase()}: chunk ${untimed.chunkIndex + 1} lacks real speech timestamps. Choose Markdown or JSON instead.`
    );
  }
  const cues = evidence.map((item, index) => {
    // The whole transcript was checked before producing any cues, including text-only chunks.
    if (item.start === undefined || item.end === undefined) {
      throw new Error("Subtitle evidence is missing real speech timestamps");
    }
    const label =
      item.speaker === undefined
        ? ""
        : `${speakerLabel(item.chunkIndex, item.speaker, options)}: `;
    let text = `${label}${item.text}`.replaceAll(/\s+/gu, " ").trim();
    if (format === "vtt") {
      text = text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }
    return `${index + 1}\n${subtitleTimestamp(item.start, format)} --> ${subtitleTimestamp(item.end, format)}\n${text}`;
  });
  return `${format === "vtt" ? "WEBVTT\n\n" : ""}${cues.join("\n\n")}${cues.length ? "\n" : ""}`;
};

/** A deterministic basename, including source identity, that cannot escape an output directory. */
export const outputStem = (info: VideoInfo): string => {
  const slug =
    info.title
      .normalize("NFKD")
      .replaceAll(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "")
      .slice(0, 80)
      .replaceAll(/-+$/gu, "") || "video";
  const identity = /^[a-z0-9_-]{1,80}$/iu.test(info.id)
    ? info.id
    : createHash("sha256")
        .update(JSON.stringify([info.id, info.url]))
        .digest("hex")
        .slice(0, 16);
  return `${slug}-${identity}`;
};
