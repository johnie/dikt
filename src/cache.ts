import { Database } from "bun:sqlite";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { z } from "zod";

export const digest = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

export const fingerprint = async (
  file: string,
  signal?: AbortSignal
): Promise<string> => {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = createReadStream(file, { signal });
  for await (const bytes of stream) {
    hasher.update(bytes);
  }
  return hasher.digest("hex");
};

export const atomicWrite = async (
  file: string,
  content: string
): Promise<void> => {
  await mkdir(path.dirname(file), { mode: 0o700, recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporary, content, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
};

export const readCheckpoint = async <T>(
  file: string,
  schema: z.ZodType<T>
): Promise<T | undefined> => {
  try {
    return schema.parse(JSON.parse(await Bun.file(file).text()));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(`Invalid checkpoint ${file}; use --force to replace it`, {
      cause: error,
    });
  }
};

export const lockJob = async (dir: string): Promise<() => Promise<void>> => {
  await mkdir(dir, { mode: 0o700, recursive: true });
  const database = new Database(path.join(dir, "lock.sqlite"), {
    create: true,
  });
  try {
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
  } catch (error) {
    database.close();
    throw new Error(`Cannot lock job (another run may be active): ${dir}`, {
      cause: error,
    });
  }
  // SQLite releases the transaction lock even after SIGKILL or process crashes.
  return () => {
    database.exec("ROLLBACK");
    database.close();
    return Promise.resolve();
  };
};
