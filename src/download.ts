import { createHash } from "node:crypto";
import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

import { runMediaProcess } from "./audio.ts";

export interface Chapter {
  start: number;
  title: string;
}

export interface VideoInfo {
  id: string;
  title: string;
  channel: string | undefined;
  /** ISO date (YYYY-MM-DD). */
  uploadDate: string | undefined;
  duration: number | undefined;
  url: string;
  isYouTube: boolean;
  chapters: Chapter[];
  audioPath: string;
  inputKind?: "url" | "local";
}

const httpUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid media URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Media URLs must use http or https");
  }
  return url.href;
};

const requiredText = z.string().refine((text) => text.trim().length > 0);
const optionalText = z
  .string()
  .nullish()
  .transform((text) => (text?.trim() ? text : undefined));
// ffprobe emits numeric strings; reject missing times and booleans before conversion.
const numericSeconds = z
  .union([z.number(), z.string().trim().min(1).transform(Number)])
  .pipe(z.number().nonnegative());
const positiveDuration = numericSeconds.pipe(z.number().positive());

const downloadChapterSchema = z
  .object({
    start_time: z.number().nonnegative(),
    title: requiredText,
  })
  .transform((chapter): Chapter => ({
    start: chapter.start_time,
    title: chapter.title,
  }));

const downloadSchema = z
  .object({
    channel: optionalText,
    chapters: z.array(downloadChapterSchema).nullish(),
    duration: positiveDuration.nullish(),
    extractor_key: optionalText,
    id: requiredText,
    requested_downloads: z
      .tuple([z.object({ filepath: requiredText })])
      .rest(z.object({ filepath: requiredText })),
    title: requiredText,
    upload_date: optionalText,
    uploader: optionalText,
    webpage_url: requiredText.transform(httpUrl),
  })
  .transform((info): VideoInfo => ({
    audioPath: path.resolve(info.requested_downloads[0].filepath),
    channel: info.channel ?? info.uploader,
    chapters: info.chapters ?? [],
    duration: info.duration ?? undefined,
    id: info.id,
    inputKind: "url",
    isYouTube: info.extractor_key === "Youtube",
    title: info.title,
    uploadDate: info.upload_date?.replace(
      /^(?<y>\d{4})(?<m>\d{2})(?<d>\d{2})$/u,
      "$<y>-$<m>-$<d>"
    ),
    url: info.webpage_url,
  }));

/** Validates yt-dlp metadata and preserves downloaded paths and source chapters. */
export const parseDownloadInfo = downloadSchema.parse.bind(downloadSchema);

/** Downloads one URL, never implicitly expanding a playlist. */
export const downloadAudio = async (
  url: string,
  dir: string,
  signal?: AbortSignal
): Promise<VideoInfo> => {
  const input = httpUrl(url);
  signal?.throwIfAborted();
  await mkdir(dir, { recursive: true });
  const result = await runMediaProcess(
    "yt-dlp",
    [
      "--format",
      "bestaudio/best",
      "--no-playlist",
      "--no-simulate",
      "--output",
      path.resolve(dir, "%(id)s.%(ext)s"),
      "--dump-single-json",
      "--",
      input,
    ],
    signal
  );
  const info = parseDownloadInfo(JSON.parse(result.stdout));
  const file = await stat(info.audioPath);
  if (!file.isFile() || file.size === 0) {
    throw new Error("yt-dlp did not produce a nonempty audio file");
  }
  return info;
};

const localTagsSchema = z.object({
  album_artist: optionalText,
  artist: optionalText,
  title: optionalText,
});

const localChapterSchema = z
  .object({
    start_time: numericSeconds,
    tags: localTagsSchema.nullish(),
  })
  .transform((chapter): Chapter => ({
    start: chapter.start_time,
    title: chapter.tags?.title ?? `Chapter ${chapter.start_time}s`,
  }));

const localMetadataSchema = z
  .object({
    chapters: z.array(localChapterSchema).nullish(),
    format: z.object({
      duration: positiveDuration,
      tags: localTagsSchema.nullish(),
    }),
    streams: z
      .array(z.object({ codec_type: z.string() }))
      .refine(
        (streams) => streams.some((stream) => stream.codec_type === "audio"),
        "Local input does not contain an audio stream"
      ),
  })
  .refine(
    (metadata) =>
      metadata.chapters?.every(
        (chapter) => chapter.start <= metadata.format.duration
      ) ?? true,
    "Invalid local chapter start time"
  );

/** Validates ffprobe audio metadata, including chapter bounds, before local use. */
export const parseLocalMetadata = (
  value: Parameters<typeof localMetadataSchema.parse>[0],
  audioPath: string
): VideoInfo => {
  const metadata = localMetadataSchema.parse(value);
  const absolutePath = path.resolve(audioPath);
  const { tags } = metadata.format;
  return {
    audioPath: absolutePath,
    channel: tags?.artist ?? tags?.album_artist,
    chapters: metadata.chapters ?? [],
    duration: metadata.format.duration,
    id: createHash("sha256").update(absolutePath).digest("hex").slice(0, 16),
    inputKind: "local",
    isYouTube: false,
    title:
      tags?.title ?? path.basename(absolutePath, path.extname(absolutePath)),
    uploadDate: undefined,
    url: pathToFileURL(absolutePath).href,
  };
};

/** Local paths and file URLs never invoke yt-dlp or perform network requests. */
export const resolveInput = async (
  input: string,
  dir: string,
  signal?: AbortSignal
): Promise<VideoInfo> => {
  if (/^https?:\/\//iu.test(input)) {
    return await downloadAudio(input, dir, signal);
  }
  signal?.throwIfAborted();
  const audioPath = input.startsWith("file:")
    ? fileURLToPath(input)
    : path.resolve(input);
  const file = await stat(audioPath);
  if (!file.isFile() || file.size === 0) {
    throw new Error("Local input must be a nonempty regular file");
  }
  await access(audioPath);
  const result = await runMediaProcess(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-show_chapters",
      "-of",
      "json",
      audioPath,
    ],
    signal
  );
  return parseLocalMetadata(JSON.parse(result.stdout), audioPath);
};

const playlistEntrySchema = z
  .object({
    _type: optionalText,
    entries: z.null().optional(),
    extractor_key: optionalText,
    ie_key: optionalText,
    url: optionalText,
    webpage_url: optionalText,
  })
  .refine(
    (entry) => entry._type !== "playlist",
    "Playlist expansion returned a nested playlist instead of a video"
  );

type PlaylistEntry = z.output<typeof playlistEntrySchema>;

const playlistVideoUrl = (entry: PlaylistEntry): string => {
  // Embedded media can share a containing webpage; prefer each item's URL.
  const direct = entry.url;
  if (direct && /^https?:\/\//iu.test(direct)) {
    return httpUrl(direct);
  }
  if (
    direct &&
    (entry.ie_key === "Youtube" || entry.extractor_key === "Youtube") &&
    /^[A-Za-z\d_-]{11}$/u.test(direct)
  ) {
    return `https://www.youtube.com/watch?v=${direct}`;
  }
  if (entry.webpage_url) {
    return httpUrl(entry.webpage_url);
  }
  throw new Error("Playlist entry has no valid video URL");
};

const playlistSchema = z
  .object({ entries: z.array(playlistEntrySchema).min(1) })
  .transform((info) => info.entries.map(playlistVideoUrl));

export const parsePlaylist = playlistSchema.parse.bind(playlistSchema);

export const expandPlaylist = async (
  url: string,
  signal?: AbortSignal
): Promise<string[]> => {
  const input = httpUrl(url);
  const result = await runMediaProcess(
    "yt-dlp",
    ["--flat-playlist", "--skip-download", "--dump-single-json", "--", input],
    signal
  );
  return parsePlaylist(JSON.parse(result.stdout));
};
