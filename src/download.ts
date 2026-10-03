import { $ } from "bun";

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
}

interface YtDlpInfo {
  id: string;
  title: string;
  channel?: string | null;
  uploader?: string | null;
  upload_date?: string | null;
  duration?: number | null;
  webpage_url: string;
  extractor_key: string;
  chapters?: { start_time: number; title: string }[] | null;
  requested_downloads?: { filepath?: string }[];
}

/**
 * Downloads the best available audio track of `url` into `dir` via yt-dlp.
 * yt-dlp skips the download when the file already exists, so re-runs are cheap.
 */
export const downloadAudio = async (
  url: string,
  dir: string
): Promise<VideoInfo> => {
  const result =
    await $`yt-dlp --format bestaudio/best --no-playlist --no-simulate --output ${`${dir}/%(id)s.%(ext)s`} --dump-single-json ${url}`
      .nothrow()
      .quiet();
  if (result.exitCode !== 0) {
    throw new Error(`yt-dlp failed:\n${result.stderr.toString().trim()}`);
  }

  // SAFETY: --dump-single-json emits one info object for the requested (non-playlist) URL.
  const info = result.json() as YtDlpInfo;
  const audioPath = info.requested_downloads?.[0]?.filepath;
  if (!audioPath) {
    throw new Error("yt-dlp did not report a downloaded file path");
  }

  return {
    audioPath,
    channel: info.channel ?? info.uploader ?? undefined,
    chapters: (info.chapters ?? []).map((c) => ({
      start: c.start_time,
      title: c.title,
    })),
    duration: info.duration ?? undefined,
    id: info.id,
    isYouTube: info.extractor_key === "Youtube",
    title: info.title,
    uploadDate:
      info.upload_date?.replace(
        /^(?<y>\d{4})(?<m>\d{2})(?<d>\d{2})$/u,
        "$<y>-$<m>-$<d>"
      ) ?? undefined,
    url: info.webpage_url,
  };
};
