import { describe, expect, test } from "bun:test";

import type { VideoInfo } from "./download.ts";
import { buildEvidence, outputStem, renderOutput } from "./exports.ts";
import { renderMarkdown } from "./markdown.ts";
import type { ChunkTranscript, RenderOptions } from "./markdown.ts";
import type { Transcription } from "./openrouter.ts";

const info: VideoInfo = {
  audioPath: "/temporary/recording.mp3",
  channel: undefined,
  chapters: [],
  duration: 1200,
  id: "abc123",
  isYouTube: false,
  title: "A recording",
  uploadDate: undefined,
  url: "https://example.com/recording",
};
const options: RenderOptions = {
  language: "en",
  model: "test/transcribe",
  region: "eu",
  transcribedAt: new Date("2026-10-03T10:00:00.000Z"),
};
const transcript = (
  index: number,
  start: number,
  transcription: Partial<Transcription>
): ChunkTranscript => ({
  chunk: {
    end: start + 600,
    index,
    path: `/temporary/chunk-${index}.mp3`,
    start,
  },
  transcription: {
    cost: null,
    language: "en",
    segments: undefined,
    text: "",
    words: undefined,
    ...transcription,
  },
});

describe("transcript evidence", () => {
  test("applies precise chunk offsets and keeps deterministic IDs and raw speakers", () => {
    const chunks = [
      transcript(2, 600.125, {
        segments: [
          { end: 1.375, speaker: 0, start: 0.25, text: " First. " },
          { end: 2.875, speaker: 1, start: 1.625, text: "Second." },
        ],
        text: "First. Second.",
      }),
    ];
    expect(buildEvidence(chunks)).toEqual([
      {
        chunkIndex: 2,
        end: 601.5,
        id: "c3-s1",
        speaker: 0,
        start: 600.375,
        text: "First.",
      },
      {
        chunkIndex: 2,
        end: 603,
        id: "c3-s2",
        speaker: 1,
        start: 601.75,
        text: "Second.",
      },
    ]);
  });

  test("plain text never acquires invented speech timestamps", () => {
    const evidence = buildEvidence([
      transcript(1, 600, { text: " Untimed text. " }),
    ]);
    expect(evidence).toEqual([
      { chunkIndex: 1, id: "c2-p1", text: "Untimed text." },
    ]);
    expect(evidence[0]).not.toHaveProperty("start");
    expect(evidence[0]).not.toHaveProperty("end");
  });

  test("word-only responses work even when segments is an empty array", () => {
    const chunks = [
      transcript(0, 12, {
        segments: [],
        words: [
          { end: 0.375, speaker: 0, start: 0.125, word: "Hello" },
          { end: 0.875, speaker: 0, start: 0.4, word: "world!" },
          { end: 1.5, speaker: 0, start: 1.125, word: "Again." },
          { end: 2.125, speaker: 1, start: 1.75, word: "Yes." },
        ],
      }),
    ];
    expect(buildEvidence(chunks)).toEqual([
      {
        chunkIndex: 0,
        end: 12.875,
        id: "c1-s1",
        speaker: 0,
        start: 12.125,
        text: "Hello world!",
      },
      {
        chunkIndex: 0,
        end: 13.5,
        id: "c1-s2",
        speaker: 0,
        start: 13.125,
        text: "Again.",
      },
      {
        chunkIndex: 0,
        end: 14.125,
        id: "c1-s3",
        speaker: 1,
        start: 13.75,
        text: "Yes.",
      },
    ]);
  });

  test("word segmentation respects speaker changes and pauses without punctuation", () => {
    const chunks = [
      transcript(0, 0, {
        words: [
          { end: 1, speaker: 0, start: 0, word: "One" },
          { end: 2, speaker: 1, start: 1, word: "two" },
          { end: 9, speaker: 1, start: 8, word: "three" },
        ],
      }),
    ];
    expect(buildEvidence(chunks).map((item) => item.text)).toEqual([
      "One",
      "two",
      "three",
    ]);
  });

  test("coarse segments use real word timings without rewriting the raw response", () => {
    const chunk = transcript(0, 0, {
      segments: [{ end: 65, start: 0, text: "Coarse provider text." }],
      text: "Raw transcription is not corrected.",
      words: [
        { end: 2, start: 1, word: "Fine." },
        { end: 41, start: 40, word: "Timing." },
      ],
    });
    const original = JSON.stringify(chunk);
    expect(buildEvidence([chunk]).map((item) => item.text)).toEqual([
      "Fine.",
      "Timing.",
    ]);
    expect(JSON.stringify(chunk)).toBe(original);
  });

  test("invalid and zero-duration timings do not become speech evidence", () => {
    for (const end of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      const chunk = transcript(0, 100, {
        segments: [{ end, start: 0, text: "Missing real timing." }],
        text: "Missing real timing.",
      });
      expect(buildEvidence([chunk])).toEqual([
        { chunkIndex: 0, id: "c1-p1", text: "Missing real timing." },
      ]);
    }
  });
});

describe("subtitle exports", () => {
  test("encoder-padding timestamps cannot overlap the following source chunk", () => {
    const first = transcript(0, 0, {
      segments: [{ end: 6.56, start: 3.68, text: "First." }],
      text: "First.",
    });
    first.chunk.end = 6;
    const second = transcript(1, 6, {
      segments: [{ end: 6, start: 0, text: "Second." }],
      text: "Second.",
    });
    second.chunk.end = 12;
    expect(renderOutput("srt", info, [first, second], options)).toBe(
      "1\n00:00:03,680 --> 00:00:06,000\nFirst.\n\n2\n00:00:06,000 --> 00:00:12,000\nSecond.\n"
    );
    expect(first.transcription.segments?.[0]?.end).toBe(6.56);
  });

  test("speech starting outside the real chunk cannot acquire an invented subtitle interval", () => {
    const chunk = transcript(0, 0, {
      segments: [{ end: 6.5, start: 6.1, text: "Outside." }],
      text: "Outside.",
    });
    chunk.chunk.end = 6;
    expect(() => renderOutput("srt", info, [chunk], options)).toThrow(
      "lacks real speech timestamps"
    );
  });

  test("SRT uses exact milliseconds with chunk offsets and carry across hours", () => {
    const chunks = [
      transcript(0, 3599.125, {
        segments: [{ end: 1.875, start: 0.125, text: "Precise." }],
        text: "Precise.",
      }),
    ];
    expect(renderOutput("srt", info, chunks, options)).toBe(
      "1\n00:59:59,250 --> 01:00:01,000\nPrecise.\n"
    );
  });

  test("VTT uses exact milliseconds, scoped speaker maps and escaped cue markup", () => {
    const chunks = [
      transcript(1, 600.125, {
        segments: [
          { end: 0.875, speaker: 0, start: 0.001, text: "A < B & C." },
        ],
        text: "A < B & C.",
      }),
    ];
    expect(
      renderOutput("vtt", info, chunks, {
        ...options,
        speakerNames: { "1:1": "Other", "2:1": "Alice" },
      })
    ).toBe(
      "WEBVTT\n\n1\n00:10:00.126 --> 00:10:01.000\nAlice (chunk 2): A &lt; B &amp; C.\n"
    );
  });

  test("all subtitle formats refuse a mixed timed and untimed meaningful transcript", () => {
    const chunks = [
      transcript(0, 0, {
        segments: [{ end: 2, start: 1, text: "Timed." }],
        text: "Timed.",
      }),
      transcript(1, 600, { text: "No timestamps." }),
    ];
    for (const format of ["srt", "vtt"] as const) {
      expect(() => renderOutput(format, info, chunks, options)).toThrow(
        "chunk 2 lacks real speech timestamps"
      );
    }
  });

  test("subtitles reject incomplete real timing data rather than dropping content", () => {
    const chunks = [
      transcript(0, 0, {
        segments: [
          { end: 1, start: 0, text: "First." },
          { end: Number.NaN, start: 1, text: "Missing." },
        ],
        text: "First. Missing.",
      }),
    ];
    expect(() => renderOutput("srt", info, chunks, options)).toThrow(
      "lacks real speech timestamps"
    );
  });

  test("empty chunks are not meaningful and do not block a complete subtitle export", () => {
    const chunks = [
      transcript(0, 0, {
        segments: [{ end: 2, start: 1, text: "Timed." }],
        text: "Timed.",
      }),
      transcript(1, 600, { segments: [], text: "  ", words: [] }),
    ];
    expect(renderOutput("srt", info, chunks, options)).toBe(
      "1\n00:00:01,000 --> 00:00:02,000\nTimed.\n"
    );
  });

  test("word-only timing produces subtitles instead of invented chunk boundaries", () => {
    const chunks = [
      transcript(1, 600, {
        text: "Word.",
        words: [{ end: 3.375, start: 2.125, word: "Word." }],
      }),
    ];
    expect(renderOutput("srt", info, chunks, options)).toBe(
      "1\n00:10:02,125 --> 00:10:03,375\nWord.\n"
    );
  });
});

describe("Markdown rendering", () => {
  test("chapters, speaker changes and chunk offsets retain paragraph boundaries", () => {
    const chunks = [
      transcript(1, 600, {
        segments: [
          { end: 2, speaker: 0, start: 0.125, text: "One." },
          { end: 4, speaker: 0, start: 2.125, text: "Two." },
          { end: 6, speaker: 1, start: 4.125, text: "Three." },
        ],
        text: "One. Two. Three.",
      }),
    ];
    const markdown = renderMarkdown(
      {
        ...info,
        chapters: [
          { start: 0, title: "Introduction" },
          { start: 602, title: "Discussion" },
        ],
      },
      chunks,
      options
    );
    expect(markdown).toContain(
      "## Introduction\n\n`10:00` **Speaker 1 (chunk 2):** One."
    );
    expect(markdown).toContain(
      "## Discussion\n\n`10:02` **Speaker 1 (chunk 2):** Two."
    );
    expect(markdown).toContain("`10:04` **Speaker 2 (chunk 2):** Three.");
  });

  test("short neighboring segments merge, while pauses break paragraphs", () => {
    const chunk = transcript(0, 0, {
      segments: [
        { end: 1, start: 0, text: "First." },
        { end: 2, start: 1.5, text: "Together." },
        { end: 9, start: 8, text: "After a pause." },
        { end: 69, start: 68, text: "After a minute." },
      ],
    });
    const markdown = renderMarkdown(info, [chunk], options);
    expect(markdown).toContain(
      "`00:00` First. Together.\n\n`00:08` After a pause.\n\n`01:08` After a minute."
    );
  });

  test("continuous speech closes a paragraph at a sentence boundary after sixty seconds", () => {
    const chunk = transcript(0, 0, {
      segments: Array.from({ length: 62 }, (_, index) => ({
        end: index + 1,
        start: index,
        text: `Sentence ${index}.`,
      })),
    });
    const markdown = renderMarkdown(info, [chunk], options);
    expect(markdown).toContain(
      "Sentence 59.\n\n`01:00` Sentence 60. Sentence 61."
    );
    expect(markdown).not.toContain("`00:30`");
  });

  test("speaker names are one-based chunk scoped and unnamed labels remain explicit", () => {
    const chunks = [
      transcript(0, 0, {
        segments: [{ end: 1, speaker: 0, start: 0, text: "First." }],
      }),
      transcript(1, 600, {
        segments: [{ end: 1, speaker: 0, start: 0, text: "Second." }],
      }),
      transcript(2, 1200, {
        segments: [{ end: 1, speaker: 0, start: 0, text: "Third." }],
      }),
    ];
    const markdown = renderMarkdown(info, chunks, {
      ...options,
      speakerNames: { "1:1": "Alice", "2:1": "Bob" },
    });
    expect(markdown).toContain("**Alice (chunk 1):** First.");
    expect(markdown).toContain("**Bob (chunk 2):** Second.");
    expect(markdown).toContain("**Speaker 1 (chunk 3):** Third.");
  });

  test("plain text fallback retains the chunk reference only on its first paragraph", () => {
    const text = `${"A sentence without precise timing. ".repeat(25)}Final words.`;
    const chunks = [transcript(1, 600, { segments: [], text })];
    const markdown = renderMarkdown(info, chunks, options);
    expect(markdown).toContain("`10:00` A sentence without precise timing.");
    expect(markdown.split("`10:00`")).toHaveLength(2);
    expect(markdown).toContain("Final words.");
    expect(buildEvidence(chunks)[0]).not.toHaveProperty("start");
  });

  test("word-only transcripts render text and local region metadata", () => {
    const chunks = [
      transcript(0, 0, {
        words: [{ end: 1.875, start: 1.125, word: "Offline." }],
      }),
    ];
    const markdown = renderOutput("md", info, chunks, {
      ...options,
      region: "local",
    });
    expect(markdown).toContain("region: local");
    expect(markdown).toContain("`00:01` Offline.");
  });
});

describe("JSON exports and filenames", () => {
  test("JSON preserves raw chunk responses, nullable costs and global evidence without temporary paths", () => {
    const chunks = [
      transcript(1, 600.125, {
        cost: null,
        language: "sv",
        segments: [
          {
            end: 1.375,
            speaker: 0,
            start: 0.125,
            text: " Raw text, untouched. ",
          },
        ],
        text: " Raw text, untouched. ",
        words: [{ end: 0.375, speaker: 0, start: 0.125, word: " Raw " }],
      }),
    ];
    const original = JSON.stringify(chunks);
    const output = renderOutput("json", info, chunks, {
      ...options,
      language: undefined,
      region: "local",
    });
    const parsed = JSON.parse(output);
    expect(parsed.version).toBe(1);
    expect(parsed.metadata.region).toBe("local");
    expect(parsed.metadata.language).toBe("sv");
    expect(parsed.metadata.transcribedAt).toBe("2026-10-03T10:00:00.000Z");
    expect(parsed.chunks[0].transcription).toEqual(
      structuredClone(chunks[0]?.transcription)
    );
    expect(parsed.evidence[0].start).toBe(600.25);
    expect(parsed.evidence[0].end).toBe(601.5);
    expect(output).not.toContain("/temporary/");
    expect(parsed.chunks[0].chunk).not.toHaveProperty("path");
    expect(parsed.metadata).not.toHaveProperty("audioPath");
    expect(JSON.stringify(chunks)).toBe(original);
  });

  test("normal filenames retain readable title and source identity", () => {
    expect(
      outputStem({ ...info, id: "AbC_123-4", title: "Å recording: Hello!" })
    ).toBe("a-recording-hello-AbC_123-4");
  });

  test("untrusted source IDs cannot introduce directory traversal and remain deterministic", () => {
    const malicious = { ...info, id: "../../outside/file", title: "../../" };
    const stem = outputStem(malicious);
    expect(stem).toMatch(/^video-[a-f0-9]{16}$/u);
    expect(outputStem(malicious)).toBe(stem);
    expect(stem).not.toContain("/");
    expect(stem).not.toContain("..");
    expect(outputStem({ ...malicious, id: "../../outside/other" })).not.toBe(
      stem
    );
  });

  test("oversized and non-ASCII inputs still produce bounded safe filenames", () => {
    expect(
      outputStem({ ...info, id: "字".repeat(500), title: "字".repeat(500) })
    ).toMatch(/^video-[a-f0-9]{16}$/u);
    expect(
      outputStem({ ...info, id: "b".repeat(500), title: "a".repeat(500) })
        .length
    ).toBeLessThanOrEqual(161);
  });
});
