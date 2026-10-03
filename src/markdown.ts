import type { AudioChunk } from "./audio.ts";
import type { VideoInfo } from "./download.ts";
import type { Segment, Transcription, Word } from "./openrouter.ts";
import type { Region } from "./settings.ts";

export interface ChunkTranscript {
  chunk: AudioChunk;
  transcription: Transcription;
}

interface Paragraph {
  /** Undefined when the model returned no timestamps for this paragraph. */
  start: number | undefined;
  speaker: number | undefined;
  chunkIndex: number;
  text: string;
}

/** Soft paragraph length; a paragraph closes at the next sentence end past it. */
const PARAGRAPH_SECONDS = 60;
/** Pauses longer than this always start a new paragraph. */
const PARAGRAPH_GAP_SECONDS = 2.5;
/** Paragraph size when only plain text (no segments) is available. */
const PARAGRAPH_CHARS = 700;
const SENTENCE_END = /[.!?…]["'”’)\]]*$/u;
/** Provider segments longer than this are too coarse to paragraph; sentences are rebuilt from word timestamps. */
const MAX_SEGMENT_SECONDS = 30;

const formatTimestamp = (seconds: number, withHours: boolean): string => {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return withHours || h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${s}`
    : `${String(m).padStart(2, "0")}:${s}`;
};

const chapterIndexAt = (info: VideoInfo, time: number) =>
  info.chapters.findLastIndex((c) => c.start <= time);

/** Groups words into bounded sentence segments without inventing timestamps. */
const sentencesFromWords = (words: Word[]): Segment[] => {
  const sentences: Segment[] = [];
  let current: Segment | undefined;
  for (const word of words) {
    const text = word.word.trim();
    if (!text) {
      continue;
    }
    if (
      current &&
      current.speaker === word.speaker &&
      word.start - current.end <= PARAGRAPH_GAP_SECONDS &&
      word.start - current.start < MAX_SEGMENT_SECONDS
    ) {
      current.text += ` ${text}`;
      current.end = word.end;
    } else {
      current = {
        end: word.end,
        speaker: word.speaker,
        start: word.start,
        text,
      };
      sentences.push(current);
    }
    if (SENTENCE_END.test(text)) {
      current = undefined;
    }
  }
  return sentences;
};

const hasRealTiming = (item: { start: number; end: number }): boolean =>
  Number.isFinite(item.start) &&
  Number.isFinite(item.end) &&
  item.start >= 0 &&
  item.end > item.start;

/** The same real timing selection is shared by Markdown, evidence and subtitles. */
export const timedSegments = (
  transcription: Transcription,
  chunkDuration: number
): Segment[] | undefined => {
  const segments = transcription.segments?.filter((segment) =>
    segment.text.trim()
  );
  const words = transcription.words?.filter((word) => word.word.trim());
  const validSegments =
    segments?.length && segments.every(hasRealTiming) ? segments : undefined;
  const validWords =
    words?.length && words.every(hasRealTiming) ? words : undefined;
  const selected =
    validWords &&
    (!validSegments ||
      validSegments.some(
        (segment) => segment.end - segment.start > MAX_SEGMENT_SECONDS
      ))
      ? sentencesFromWords(validWords)
      : validSegments;
  if (
    !selected ||
    !Number.isFinite(chunkDuration) ||
    chunkDuration <= 0 ||
    selected.some((segment) => segment.start >= chunkDuration)
  ) {
    return undefined;
  }
  // Providers can timestamp encoder padding beyond the real source boundary.
  // Preserve their raw response; bound only the presentation/evidence interval.
  return selected.some((segment) => segment.end > chunkDuration)
    ? selected.map((segment) =>
        segment.end > chunkDuration
          ? { ...segment, end: chunkDuration }
          : segment
      )
    : selected;
};

export const speakerLabel = (
  chunkIndex: number,
  speaker: number,
  options: RenderOptions
): string => {
  const name = options.speakerNames?.[`${chunkIndex + 1}:${speaker + 1}`];
  return `${name ?? `Speaker ${speaker + 1}`} (chunk ${chunkIndex + 1})`;
};

const paragraphsFromSegments = (
  segments: Segment[],
  offset: number,
  chunkIndex: number,
  info: VideoInfo
): Paragraph[] => {
  const paragraphs: Paragraph[] = [];
  let current: Paragraph | undefined;
  let lastEnd = 0;

  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) {
      continue;
    }
    const start = offset + segment.start;
    const breaks =
      !current ||
      current.start === undefined ||
      segment.speaker !== current.speaker ||
      chapterIndexAt(info, start) !== chapterIndexAt(info, current.start) ||
      start - lastEnd > PARAGRAPH_GAP_SECONDS ||
      (start - current.start >= PARAGRAPH_SECONDS &&
        SENTENCE_END.test(current.text));

    if (breaks) {
      current = { chunkIndex, speaker: segment.speaker, start, text };
      paragraphs.push(current);
    } else if (current) {
      current.text += ` ${text}`;
    }
    lastEnd = offset + segment.end;
  }
  return paragraphs;
};

/** Groups sentences into paragraphs; only the first carries the chunk timestamp. */
const paragraphsFromText = (
  text: string,
  start: number,
  chunkIndex: number,
  language: string | undefined
): Paragraph[] => {
  let segmenter: Intl.Segmenter;
  try {
    segmenter = new Intl.Segmenter(language, { granularity: "sentence" });
  } catch {
    segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  }
  const paragraphs: Paragraph[] = [];
  let buffer = "";
  for (const { segment } of segmenter.segment(text)) {
    buffer += segment;
    if (buffer.length >= PARAGRAPH_CHARS) {
      paragraphs.push({
        chunkIndex,
        speaker: undefined,
        start: undefined,
        text: buffer.trim(),
      });
      buffer = "";
    }
  }
  if (buffer.trim()) {
    paragraphs.push({
      chunkIndex,
      speaker: undefined,
      start: undefined,
      text: buffer.trim(),
    });
  }
  if (paragraphs[0]) {
    paragraphs[0].start = start;
  }
  return paragraphs;
};

export interface RenderOptions {
  model: string;
  region: Region | "local";
  language: string | undefined;
  transcribedAt: Date;
  speakerNames?: Record<string, string>;
}

export const renderMarkdown = (
  info: VideoInfo,
  transcripts: ChunkTranscript[],
  options: RenderOptions
): string => {
  const language =
    options.language ??
    transcripts.find((t) => t.transcription.language)?.transcription.language;
  const duration = info.duration ?? transcripts.at(-1)?.chunk.end ?? 0;
  const withHours = duration >= 3600;
  const durationLabel = formatTimestamp(duration, withHours);

  const link = (seconds: number) => {
    const stamp = formatTimestamp(seconds, withHours);
    return info.isYouTube
      ? `[${stamp}](https://youtu.be/${info.id}?t=${Math.floor(seconds)})`
      : `\`${stamp}\``;
  };

  const frontmatter = [
    "---",
    // JSON strings are valid YAML double-quoted scalars.
    `title: ${JSON.stringify(info.title)}`,
    `source: ${JSON.stringify(info.url)}`,
    info.channel ? `channel: ${JSON.stringify(info.channel)}` : undefined,
    info.uploadDate ? `published: ${info.uploadDate}` : undefined,
    `duration: ${JSON.stringify(durationLabel)}`,
    language ? `language: ${language}` : undefined,
    `model: ${options.model}`,
    `region: ${options.region}`,
    `transcribed: ${options.transcribedAt.toISOString().slice(0, 10)}`,
    "---",
  ].filter((line) => line !== undefined);

  const byline = [
    info.channel ? `**${info.channel}**` : undefined,
    info.uploadDate,
    durationLabel,
    `[Source](${info.url})`,
  ].filter(Boolean);

  const lines = [
    ...frontmatter,
    "",
    `# ${info.title}`,
    "",
    byline.join(" · "),
    "",
  ];

  const paragraphs = transcripts.flatMap(({ chunk, transcription }) => {
    const timed = timedSegments(transcription, chunk.end - chunk.start);
    return timed
      ? paragraphsFromSegments(timed, chunk.start, chunk.index, info)
      : paragraphsFromText(
          transcription.text.trim() ||
            transcription.segments?.map((segment) => segment.text).join(" ") ||
            transcription.words?.map((word) => word.word).join(" ") ||
            "",
          chunk.start,
          chunk.index,
          language
        );
  });

  let chapterIndex = -1;
  for (const paragraph of paragraphs) {
    if (paragraph.start !== undefined) {
      const index = chapterIndexAt(info, paragraph.start);
      if (index > chapterIndex) {
        chapterIndex = index;
        const chapter = info.chapters[index];
        if (chapter) {
          lines.push(`## ${chapter.title}`, "");
        }
      }
    }
    const prefix = [
      paragraph.start === undefined ? undefined : link(paragraph.start),
      paragraph.speaker === undefined
        ? undefined
        : `**${speakerLabel(paragraph.chunkIndex, paragraph.speaker, options)}:**`,
    ].filter(Boolean);
    lines.push([...prefix, paragraph.text].join(" "), "");
  }

  return lines.join("\n");
};
