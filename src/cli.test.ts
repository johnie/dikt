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
