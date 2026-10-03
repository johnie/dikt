import { expect, test } from "bun:test";

import type { z } from "zod";

import type { VideoInfo } from "./download.ts";
import type { TranscriptEvidence } from "./exports.ts";
import type { Fetch, usageSchema } from "./http.ts";
import type { ModelInfo } from "./models.ts";
import {
  estimateNotesCost,
  generateNotes,
  parseNotesResult,
  notesResultSchema,
  renderNotes,
} from "./notes.ts";

const info: VideoInfo = {
  audioPath: "ephemeral.mp3",
  channel: undefined,
  chapters: [],
  duration: 20,
  id: "video",
  isYouTube: true,
  title: "A meeting",
  uploadDate: undefined,
  url: "https://www.youtube.com/watch?v=video",
};
const evidence: TranscriptEvidence[] = [
  {
    chunkIndex: 0,
    end: 5,
    id: "c1-s1",
    start: 2.5,
    text: "We should invest in better tools.",
  },
  { chunkIndex: 1, id: "c2-p1", text: "Keep learning every day." },
];
const structured: z.input<typeof notesResultSchema> = {
  keyPoints: [{ evidenceIds: ["c1-s1"], text: "Tools merit investment." }],
  quotes: [{ evidenceId: "c1-s1", text: "invest in better tools" }],
  takeaways: [{ evidenceIds: ["c2-p1"], text: "Keep learning." }],
};
const model = {
  architecture: { output_modalities: ["text"] },
  context_length: 32_768,
  id: "provider/notes",
  name: "Notes",
  pricing: { completion: "0.000002", prompt: "0.000001" },
};
interface CompletionFixture {
  choices?: {
    finish_reason: string;
    message: { content: string; refusal?: string };
  }[];
  usage?: z.input<typeof usageSchema>;
}
const response = (
  content: Partial<z.input<typeof notesResultSchema>> = structured,
  usage?: z.input<typeof usageSchema>,
  finishReason = "stop"
): CompletionFixture => ({
  choices: [
    {
      finish_reason: finishReason,
      message: { content: JSON.stringify(content) },
    },
  ],
  usage,
});
const fetchFor =
  (completion: CompletionFixture): Fetch =>
  (url) =>
    Promise.resolve(
      Response.json(
        String(url).includes("/models?") ? { data: [model] } : completion
      )
    );
const unknownContext: Fetch = () =>
  Promise.resolve(Response.json({ data: [{ ...model, context_length: 0 }] }));
test("notes validate real references, nonempty citations and exact quotes", () => {
  expect(
    parseNotesResult(structured, evidence, "provider/notes", null).cost
  ).toBeNull();
  for (const bad of [
    { ...structured, keyPoints: [{ evidenceIds: [], text: "Claim" }] },
    {
      ...structured,
      takeaways: [{ evidenceIds: ["invented"], text: "Claim" }],
    },
    {
      ...structured,
      quotes: [{ evidenceId: "c1-s1", text: "invest in excellent tools" }],
    },
    {
      ...structured,
      quotes: [{ evidenceId: "c2-p1", text: "invest in better tools" }],
    },
    {
      ...structured,
      quotes: [{ evidenceId: "invented", text: "invest in better tools" }],
    },
    { ...structured, timestamps: [30] },
  ]) {
    expect(() =>
      parseNotesResult(
        notesResultSchema.parse(bad),
        evidence,
        "provider/notes",
        null
      )
    ).toThrow();
  }
  const cached = parseNotesResult(structured, evidence, "provider/notes", 0.1);
  expect(parseNotesResult(cached, evidence, "provider/notes", 0.1)).toEqual(
    cached
  );
  expect(() =>
    parseNotesResult(cached, evidence, "other/model", 0.1)
  ).toThrow();
});

test("notes boundary rejects malformed fields and corrupted cache metadata", () => {
  for (const value of [
    { ...structured, cost: "0.1" },
    { ...structured, model: 42 },
    { ...structured, keyPoints: null },
    {
      ...structured,
      quotes: [
        { evidenceId: "c1-s1", extra: true, text: "invest in better tools" },
      ],
    },
    {
      ...structured,
      takeaways: [{ evidenceIds: ["c2-p1", "c2-p1"], text: "Keep learning." }],
    },
    { ...structured, keyPoints: [{ evidenceIds: ["c1-s1"], text: " " }] },
  ]) {
    expect(() => notesResultSchema.parse(value)).toThrow();
  }
  expect(notesResultSchema.parse(structured)).toEqual(structured);
  expect(() =>
    parseNotesResult({ ...structured, cost: 0.1 }, evidence, model.id, null)
  ).toThrow();
  expect(() =>
    parseNotesResult(
      structured,
      [{ chunkIndex: 0, end: 1, id: "c1-s1", start: -1, text: "Original" }],
      model.id,
      null
    )
  ).toThrow();
});

test("unknown notes cost stays unknown; malformed or truncated completion never emits partial notes", async () => {
  const result = await generateNotes(info, evidence, {
    apiKey: "test",
    fetch: fetchFor(response()),
    model: model.id,
    region: "eu",
  });
  expect(result.cost).toBeNull();
  const bodies: CompletionFixture[] = [
    {},
    response(structured, undefined, "length"),
    response({ keyPoints: [] }),
    { choices: [{ finish_reason: "stop", message: { content: "not json" } }] },
    {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify(structured),
            refusal: "Not allowed",
          },
        },
      ],
    },
    response({
      ...structured,
      quotes: [{ evidenceId: "c1-s1", text: "invented quote" }],
    }),
  ];
  await Promise.all(
    bodies.map(async (body) => {
      await expect(
        generateNotes(info, evidence, {
          apiKey: "test",
          fetch: fetchFor(body),
          model: model.id,
          region: "eu",
        })
      ).rejects.toThrow();
    })
  );
});

test("context and output caps reject before generation and never truncate input", async () => {
  let generations = 0;
  const fetch: Fetch = (url) => {
    if (!String(url).includes("/models?")) {
      generations += 1;
    }
    return Promise.resolve(
      Response.json({ data: [{ ...model, context_length: 9000 }] })
    );
  };
  await expect(
    generateNotes(info, evidence, {
      apiKey: "test",
      fetch,
      model: model.id,
      region: "eu",
    })
  ).rejects.toThrow();
  await expect(
    generateNotes(info, evidence, {
      apiKey: "test",
      fetch,
      maxTokens: 20_000,
      model: model.id,
      region: "eu",
    })
  ).rejects.toThrow();
  await expect(
    generateNotes(info, evidence, {
      apiKey: "test",
      fetch: unknownContext,
      model: model.id,
      region: "eu",
    })
  ).rejects.toThrow();
  expect(generations).toBe(0);
});

test("notes rendering preserves exact extracts and links to real source evidence", () => {
  const result = parseNotesResult(structured, evidence, model.id, null);
  const rendered = renderNotes(info, evidence, result);
  expect(rendered).toContain("> invest in better tools");
  expect(rendered).toContain("#evidence-c1-s1");
  expect(rendered).toContain("t=2");
  expect(rendered).not.toContain("ephemeral.mp3");
});

test("estimated admission cost is conservative and unknown prices block estimation", () => {
  const rates: ModelInfo = {
    completionPrice: 0.000002,
    contextLength: 32_768,
    diarization: null,
    id: model.id,
    languages: null,
    name: "Notes",
    pricePerSecond: null,
    promptPrice: 0.000001,
    timestamps: null,
    vocabulary: null,
  };
  expect(estimateNotesCost(evidence, rates, 2048)).toBe(
    (Buffer.byteLength(JSON.stringify(evidence), "utf-8") + 8192) * 0.000001 +
      2048 * 0.000002
  );
  expect(
    estimateNotesCost(evidence, { ...rates, promptPrice: null })
  ).toBeNull();
});
