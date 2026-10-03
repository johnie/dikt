import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { fingerprint, lockJob, readCheckpoint } from "./cache.ts";

const temporary = () => mkdtemp(path.join(tmpdir(), "dikt-checkpoint-test-"));

test("changed source bytes invalidate cache identity even at the same path", async () => {
  const dir = await temporary();
  try {
    const file = path.join(dir, "recording.wav");
    const copy = path.join(dir, "copy.wav");
    await Bun.write(file, "first recording");
    await Bun.write(copy, "first recording");
    const original = await fingerprint(file);
    expect(await fingerprint(copy)).toBe(original);
    await Bun.write(file, "different recording");
    expect(await fingerprint(file)).not.toBe(original);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("malformed checkpoints fail explicitly rather than triggering paid work silently", async () => {
  const dir = await temporary();
  try {
    const file = path.join(dir, "chunk.json");
    const schema = z.object({ text: z.string() });
    expect(await readCheckpoint(file, schema)).toBeUndefined();
    await Bun.write(file, "truncated {");
    await expect(readCheckpoint(file, schema)).rejects.toThrow(
      "Invalid checkpoint"
    );
    await Bun.write(file, JSON.stringify({ text: 42 }));
    await expect(readCheckpoint(file, schema)).rejects.toThrow(
      "Invalid checkpoint"
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("a live job blocks a second run until its lock is released", async () => {
  const dir = await temporary();
  try {
    const release = await lockJob(dir);
    try {
      await expect(lockJob(dir)).rejects.toThrow("Cannot lock job");
    } finally {
      await release();
    }
    const releaseAgain = await lockJob(dir);
    await releaseAgain();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("a killed process leaves no stale lock blocking resume", async () => {
  const dir = await temporary();
  const module = path.join(import.meta.dir, "cache.ts");
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import {lockJob} from ${JSON.stringify(module)}; import {createServer} from "node:net"; await lockJob(${JSON.stringify(dir)}); createServer().listen(0,"127.0.0.1",()=>console.log("locked"));`,
    ],
    { stderr: "pipe", stdout: "pipe" }
  );
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    reader.releaseLock();
    await expect(lockJob(dir)).rejects.toThrow("Cannot lock job");
    child.kill("SIGKILL");
    await child.exited;
    const release = await lockJob(dir);
    await release();
  } finally {
    child.kill();
    await child.exited;
    await rm(dir, { force: true, recursive: true });
  }
});
