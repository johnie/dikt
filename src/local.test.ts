import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseWhisperJson, validateLocal } from "./local.ts";

const whisperResult = {
  result: { language: "en" },
  transcription: [
    {
      offsets: { from: 0, to: 1234 },
      text: " Hello",
      tokens: [{ text: " Hel" }, { text: "lo" }],
    },
    { offsets: { from: 1234, to: 2500 }, text: " world." },
  ],
};

test("whisper full JSON converts milliseconds without pretending tokens are words", () => {
  const result = parseWhisperJson(whisperResult);
  expect(result).toEqual({
    cost: 0,
    language: "en",
    segments: [
      { end: 1.234, start: 0, text: " Hello" },
      { end: 2.5, start: 1.234, text: " world." },
    ],
    text: "Hello world.",
    words: undefined,
  });
});

test("whisper timestamp strings support comma/dot milliseconds and long hours", () => {
  const result = parseWhisperJson({
    result: { language: "sv" },
    transcription: [
      {
        text: "Hej",
        timestamps: { from: "100:59:59,999", to: "101:00:00.001" },
      },
    ],
  });
  expect(result.segments).toEqual([
    { end: 363_600.001, start: 363_599.999, text: "Hej" },
  ]);
  expect(
    parseWhisperJson({ result: { language: "en" }, transcription: [] }).text
  ).toBe("");
});

test("whisper parser rejects missing text, invented and invalid timestamp bounds", () => {
  for (const transcription of [
    [{ offsets: { from: 0, to: 1 } }],
    [{ text: "a" }],
    [{ offsets: { from: "0", to: 1 }, text: "a" }],
    [{ offsets: { from: -1, to: 1 }, text: "a" }],
    [{ offsets: { from: 2, to: 1 }, text: "a" }],
    [{ offsets: { from: 0, to: Number.POSITIVE_INFINITY }, text: "a" }],
    [{ text: "a", timestamps: { from: "00:60:00.000", to: "01:01:00.000" } }],
    [{ offsets: null, text: "a" }],
    [{ offsets: { from: null, to: 1 }, text: "a" }],
    [{ offsets: { from: 0, to: 1 }, text: null }],
    [{ text: "a", timestamps: { from: "00:00:00.000", to: null } }],
    [
      {
        text: "a",
        timestamps: { from: "01:00:00.000", to: "00:00:00.000" },
      },
    ],
  ]) {
    expect(() =>
      parseWhisperJson({ result: { language: "en" }, transcription })
    ).toThrow();
  }
  for (const output of [
    {},
    { result: {}, transcription: [] },
    { result: { language: " " }, transcription: [] },
    { result: { language: null }, transcription: [] },
    { result: { language: "en" }, transcription: null },
  ]) {
    expect(() => parseWhisperJson(output)).toThrow();
  }
});

test("whisper prefers real numeric offsets and allows timestamp-only segments", () => {
  const result = parseWhisperJson({
    result: { language: "sv" },
    transcription: [
      {
        offsets: { from: 125, to: 375 },
        text: " One ",
        timestamps: { from: "00:00:00.000", to: "00:00:01.000" },
      },
      {
        offsets: null,
        text: " ",
        timestamps: { from: "00:00:00.375", to: "00:00:00.375" },
      },
      {
        text: "Two.",
        timestamps: { from: "00:00:00.400", to: "00:00:01.001" },
      },
    ],
  });
  expect(result.segments).toEqual([
    { end: 0.375, start: 0.125, text: " One " },
    { end: 0.375, start: 0.375, text: " " },
    { end: 1.001, start: 0.4, text: "Two." },
  ]);
  expect(result.text).toBe("One Two.");
});

test("offline preflight rejects unsupported language before inspecting files", async () => {
  await expect(
    validateLocal({
      executable: "not-found",
      language: "xx",
      modelPath: "not-found",
    })
  ).rejects.toThrow("Unsupported whisper.cpp language");
  await expect(
    validateLocal({ language: "constructor", modelPath: "not-found" })
  ).rejects.toThrow("Unsupported whisper.cpp language");
  await expect(
    validateLocal({
      executable: "dikt-no-such-whisper-executable",
      modelPath: "not-found",
    })
  ).rejects.toThrow("executable not found");
});

test("offline preflight validates GGML and actual English-only model vocabulary", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dikt-local-validation-"));
  try {
    const executable = path.join(dir, "whisper cli with spaces");
    await Bun.write(
      executable,
      "#!/usr/bin/env bun\nconsole.log('--output-json-full');\n"
    );
    await chmod(executable, 0o755);
    const modelPath = path.join(dir, "model with spaces.bin");
    const header = Buffer.alloc(48);
    header.writeUInt32LE(0x67_67_6d_6c, 0);
    header.writeInt32LE(51_864, 4);
    await Bun.write(modelPath, header);
    await expect(
      validateLocal({ executable, language: "sv", modelPath })
    ).rejects.toThrow("English-only");
    await Bun.write(modelPath, Buffer.alloc(48));
    await expect(validateLocal({ executable, modelPath })).rejects.toThrow(
      "expected a GGML"
    );
    await Bun.write(modelPath, "short");
    await expect(validateLocal({ executable, modelPath })).rejects.toThrow(
      "GGML model file"
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
