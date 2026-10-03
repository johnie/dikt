import { expect, test } from "bun:test";
import path from "node:path";

import {
  expandPlaylist,
  parseDownloadInfo,
  parseLocalMetadata,
  parsePlaylist,
} from "./download.ts";

test("local metadata requires a real audio stream and finite positive duration", () => {
  const metadata = {
    format: {
      duration: "12.345",
      tags: { artist: "Team", title: "Recorded meeting" },
    },
    streams: [{ codec_type: "audio" }],
  };
  const info = parseLocalMetadata(metadata, "meeting with spaces.wav");
  expect(info.audioPath).toBe(path.resolve("meeting with spaces.wav"));
  expect(info.url).toContain("meeting%20with%20spaces.wav");
  expect(info.inputKind).toBe("local");
  expect(info.title).toBe("Recorded meeting");
  expect(info.duration).toBe(12.345);
  expect(info.channel).toBe("Team");
  expect(info.isYouTube).toBe(false);
  expect(parseLocalMetadata(metadata, "meeting with spaces.wav").id).toBe(
    info.id
  );
  expect(
    parseLocalMetadata(metadata, "different/meeting with spaces.wav").id
  ).not.toBe(info.id);
  expect(() =>
    parseLocalMetadata({ ...metadata, streams: [{ codec_type: "video" }] }, "a")
  ).toThrow();
  for (const duration of ["Infinity", "0", "-1", "N/A"]) {
    expect(() =>
      parseLocalMetadata({ ...metadata, format: { duration } }, "a")
    ).toThrow();
  }
});

test("local chapters preserve source timestamps and reject invalid bounds", () => {
  const metadata = {
    chapters: [{ start_time: "1.25", tags: { title: "Introduction" } }],
    format: { duration: "20" },
    streams: [{ codec_type: "audio" }],
  };
  expect(parseLocalMetadata(metadata, "recording.wav").chapters).toEqual([
    { start: 1.25, title: "Introduction" },
  ]);
  for (const startTime of [
    undefined,
    null,
    "",
    " ",
    true,
    "21",
    "-1",
    "NaN",
    "Infinity",
  ]) {
    expect(() =>
      parseLocalMetadata(
        { ...metadata, chapters: [{ start_time: startTime }] },
        "recording.wav"
      )
    ).toThrow();
  }
  expect(
    parseLocalMetadata(
      { ...metadata, chapters: [{ start_time: "0" }, { start_time: 20 }] },
      "recording.wav"
    ).chapters
  ).toEqual([
    { start: 0, title: "Chapter 0s" },
    { start: 20, title: "Chapter 20s" },
  ]);
});

test("playlist expansion uses individual HTTP video URLs rather than IDs", () => {
  expect(
    parsePlaylist({
      entries: [
        {
          ie_key: "Youtube",
          url: "https://www.youtube.com/watch?v=abcdefghijk",
        },
        { ie_key: "Youtube", url: "abcdefghijl" },
        { url: "other", webpage_url: "https://example.com/video?a=1&b=2" },
      ],
    })
  ).toEqual([
    "https://www.youtube.com/watch?v=abcdefghijk",
    "https://www.youtube.com/watch?v=abcdefghijl",
    "https://example.com/video?a=1&b=2",
  ]);
});

test("embedded playlist entries sharing a webpage retain distinct media identities", () => {
  expect(
    parsePlaylist({
      entries: [
        {
          url: "https://example.com/first.wav",
          webpage_url: "https://example.com/playlist",
        },
        {
          url: "https://example.com/second.wav",
          webpage_url: "https://example.com/playlist",
        },
      ],
    })
  ).toEqual([
    "https://example.com/first.wav",
    "https://example.com/second.wav",
  ]);
});

test("playlist expansion fails on empty, nested, unavailable or unsafe entries", async () => {
  for (const value of [
    {},
    { entries: [] },
    { entries: [null] },
    { entries: [{ url: "file:///tmp/audio" }] },
    { entries: [{ url: "--exec=malicious" }] },
    { entries: [{ _type: "playlist", url: "https://example.com" }] },
    { entries: [{ entries: [], url: "https://example.com" }] },
    { entries: [{ url: "ftp://example.com/audio" }] },
    { entries: [{ ie_key: "Generic", url: "abcdefghijk" }] },
  ]) {
    expect(() => parsePlaylist(value)).toThrow();
  }
  await expect(expandPlaylist("--exec=malicious")).rejects.toThrow(
    "Invalid media URL"
  );
  await expect(expandPlaylist("file:///tmp/audio")).rejects.toThrow(
    "http or https"
  );
});

test("download metadata rejects malformed successful responses", () => {
  const valid = {
    duration: 10,
    extractor_key: "Youtube",
    id: "video",
    requested_downloads: [{ filepath: "download with spaces.mp3" }],
    title: "A video",
    webpage_url: "https://example.com/video",
  };
  expect(parseDownloadInfo(valid)).toMatchObject({
    audioPath: path.resolve("download with spaces.mp3"),
    duration: 10,
    id: "video",
    inputKind: "url",
    isYouTube: true,
    title: "A video",
    url: "https://example.com/video",
  });
  for (const metadata of [
    {},
    { ...valid, title: undefined },
    { ...valid, requested_downloads: [] },
    { ...valid, requested_downloads: [{ filepath: null }] },
    { ...valid, duration: Number.POSITIVE_INFINITY },
    { ...valid, duration: true },
    { ...valid, webpage_url: "file:///tmp/a" },
    { ...valid, chapters: [{ start_time: null, title: "Missing" }] },
    { ...valid, chapters: [{ start_time: -1, title: "Negative" }] },
  ]) {
    expect(() => parseDownloadInfo(metadata)).toThrow();
  }
});

test("download metadata preserves source chapters, date and uploader fallback", () => {
  const info = parseDownloadInfo({
    chapters: [{ start_time: 1.125, title: "Introduction" }],
    duration: "20.5",
    extractor_key: "Generic",
    id: "video",
    requested_downloads: [{ filepath: "recording.mp3" }],
    title: "A recording",
    upload_date: "20260930",
    uploader: "Recording team",
    webpage_url: "https://example.com/recording",
  });
  expect(info.chapters).toEqual([{ start: 1.125, title: "Introduction" }]);
  expect(info.duration).toBe(20.5);
  expect(info.channel).toBe("Recording team");
  expect(info.uploadDate).toBe("2026-09-30");
  expect(info.isYouTube).toBe(false);
});
