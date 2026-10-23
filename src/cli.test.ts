import { expect, test } from "bun:test";

import { parseCli } from "./cli.ts";

test("invalid chunk sizes cannot reach media preparation", () => {
  for (const value of ["0", "-1", "Infinity", "NaN", "1e308"]) {
    expect(() =>
      parseCli(["recording.wav", "--chunk-minutes", value])
    ).toThrow();
  }
});

test("retry and concurrency bounds are validated before cloud requests", () => {
  for (const [flag, value] of [
    ["--retries", "6"],
    ["--retries", "-1"],
    ["--concurrency", "0"],
    ["--encode-concurrency", "1.5"],
    ["--timeout-seconds", "Infinity"],
  ]) {
    if (!flag || !value) {
      throw new Error("Missing boundary fixture");
    }
    expect(() => parseCli(["recording.wav", flag, value])).toThrow();
  }
});

test("local notes cannot implicitly upload transcript text", () => {
  expect(() =>
    parseCli(["recording.wav", "--backend", "local", "--notes"])
  ).toThrow("stay offline");
  expect(() =>
    parseCli([
      "recording.wav",
      "--backend",
      "local",
      "--notes-model",
      "a/model",
    ])
  ).toThrow("stay offline");
  expect(() =>
    parseCli([
      "recording.wav",
      "--backend",
      "local",
      "--notes",
      "--allow-cloud-notes",
    ])
  ).toThrow("explicit --notes-model");
});

test("explicit offline notes consent preserves the selected data region", () => {
  const command = parseCli([
    "recording.wav",
    "--backend",
    "local",
    "--notes-model",
    "a/model",
    "--allow-cloud-notes",
    "--region",
    "eu",
  ]);
  if (command.kind !== "run") {
    throw new Error("Expected run command");
  }
  expect(command.options.notesModel).toBe("a/model");
  expect(command.options.region).toBe("eu");
  expect(() => parseCli(["recording.wav", "--region", "unknown"])).toThrow();
});

test("speaker names require diarization and positive chunk-scoped identities", () => {
  expect(() =>
    parseCli(["recording.wav", "--speaker-name", "1:1=Alice"])
  ).toThrow("requires --diarize");
  for (const key of ["1=Alice", "0:1=Alice", "1:0=Alice", "1:1= "]) {
    expect(() =>
      parseCli(["recording.wav", "--diarize", "--speaker-name", key])
    ).toThrow();
  }
});

test("duplicate scoped speaker assignments cannot silently overwrite an identity", () => {
  expect(() =>
    parseCli([
      "recording.wav",
      "--diarize",
      "--speaker-name",
      "1:1=Alice",
      "--speaker-name",
      "1:1=Bob",
    ])
  ).toThrow("Duplicate speaker name");
});

test("repeated hints and batch files preserve their order without consuming caller arguments", () => {
  const args = [
    "recording.wav",
    "--batch",
    "first.txt",
    "--batch",
    "second.txt",
    "--vocabulary",
    "Schibsted",
    "--vocabulary",
    "Fortnox",
    "--diarize",
    "--speaker-name",
    "1:1=Alice",
    "--speaker-name",
    "2:1=Bob",
  ];
  const original = [...args];
  const command = parseCli(args);
  if (command.kind !== "run") {
    throw new Error("Expected run command");
  }
  expect(command.inputs).toEqual(["recording.wav"]);
  expect(command.batchFiles).toEqual(["first.txt", "second.txt"]);
  expect(command.options.vocabulary).toEqual(["Schibsted", "Fortnox"]);
  expect(command.options.speakerNames).toEqual({
    "1:1": "Alice",
    "2:1": "Bob",
  });
  expect(args).toEqual(original);
});

test("end-of-options paths are inputs exactly once, not flags", () => {
  const command = parseCli(["first.wav", "--", "--second.wav", "-h"]);
  if (command.kind !== "run") {
    throw new Error("Expected run command");
  }
  expect(command.inputs).toEqual(["first.wav", "--second.wav", "-h"]);
});

test("missing option values and unknown flags cannot silently start a job", () => {
  for (const flag of ["--out", "-m", "--vocabulary", "--batch"]) {
    expect(() => parseCli(["recording.wav", flag])).toThrow("requires a value");
  }
  expect(() => parseCli(["recording.wav", "--typo"])).toThrow("Unknown option");
});

test("agent notes require consent before sending a local transcript", () => {
  for (const provider of ["codex", "omp", "claude"] as const) {
    expect(() =>
      parseCli([
        "meeting.wav",
        "--backend",
        "local",
        "--notes-provider",
        provider,
      ])
    ).toThrow("stay offline");
    const command = parseCli([
      "meeting.wav",
      "--backend",
      "local",
      "--notes-provider",
      provider,
      "--allow-cloud-notes",
    ]);
    if (command.kind !== "run") {
      throw new Error("Expected run command");
    }
    expect(command.options.notesProvider).toBe(provider);
    expect(command.options.notesEnabled).toBe(true);
    expect(command.options.notesModel).toBeUndefined();
  }
});

test("an agent model override stays separate from the transcription model", () => {
  const command = parseCli([
    "meeting.wav",
    "--notes-provider",
    "codex",
    "--notes-model",
    "agent/model",
    "--model",
    "transcription/model",
  ]);
  if (command.kind !== "run") {
    throw new Error("Expected run command");
  }
  expect(command.options.notesModel).toBe("agent/model");
  expect(command.options.model).toBe("transcription/model");
  expect(() =>
    parseCli(["meeting.wav", "--notes-provider", "unknown"])
  ).toThrow();
});
