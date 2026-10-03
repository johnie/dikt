import { expect, test } from "bun:test";
import { existsSync, watch } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import {
  chooseCuts,
  parseDuration,
  runMediaProcess,
  splitAudio,
} from "./audio.ts";

test("duration and chunk boundaries reject nonfinite and nonpositive values", async () => {
  expect(parseDuration(" 12.25\n")).toBe(12.25);
  for (const value of ["", " ", "0", "-1", "Infinity", "NaN", "N/A"]) {
    expect(() => parseDuration(value)).toThrow("finite and positive");
  }
  await Promise.all(
    [0, -1, Number.NaN, Number.POSITIVE_INFINITY].map(async (value) => {
      expect(() => chooseCuts(10, value, [])).toThrow("finite and positive");
      expect(() => chooseCuts(value, 10, [])).toThrow("finite and positive");
      await expect(
        splitAudio("does-not-exist", value, "unused")
      ).rejects.toThrow("finite and positive");
    })
  );
  await expect(
    splitAudio("does-not-exist", 10, "unused", { concurrency: 0 })
  ).rejects.toThrow("positive integer");
});

test("pause cuts ignore invalid markers, sort pauses and never exceed chunk limit", () => {
  expect(chooseCuts(120, 60, [55, 25, Number.NaN, -5, 119, 200])).toEqual([
    55, 115,
  ]);
  expect(chooseCuts(60, 60, [])).toEqual([]);
  expect(chooseCuts(61, 60, [])).toEqual([60]);
  expect(chooseCuts(125, 60, [55, 110])).toEqual([55, 110]);
});

test("aborted children fully settle before rejection", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dikt-abort-"));
  const ready = path.join(dir, "ready");
  const finished = path.join(dir, "finished");
  const controller = new AbortController();
  const { promise: readySignal, resolve: markReady } =
    Promise.withResolvers<boolean>();
  const watcher = watch(dir, () => {
    if (existsSync(ready)) {
      markReady(true);
    }
  });
  try {
    const code = `import {writeFileSync} from 'node:fs'; import {createServer} from 'node:net'; const server = createServer(); process.on('SIGTERM', () => server.close(() => {writeFileSync(${JSON.stringify(finished)}, 'closed'); process.exit(0)})); server.listen(0, '127.0.0.1', () => writeFileSync(${JSON.stringify(ready)}, 'ready'));`;
    const promise = runMediaProcess(
      process.execPath,
      ["-e", code],
      controller.signal
    );
    const outcome = (async () => {
      try {
        return { error: undefined, value: await promise };
      } catch (error) {
        return { error, value: undefined };
      }
    })();
    const readiness = await Promise.race([readySignal, outcome]);
    if (readiness !== true) {
      throw new Error("Child exited before signaling readiness", {
        cause: readiness,
      });
    }
    const reason = new Error("Cancelled by test");
    controller.abort(reason);
    const finishedOutcome = await outcome;
    expect(finishedOutcome.error).toBe(reason);
    expect(await Bun.file(finished).text()).toBe("closed");
  } finally {
    controller.abort();
    watcher.close();
    await rm(dir, { force: true, recursive: true });
  }
});

test("encoding obeys the configured process concurrency", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dikt-encoding-"));
  const events = path.join(dir, "events");
  try {
    const probe = path.join(dir, "ffprobe");
    const encoder = path.join(dir, "ffmpeg");
    await Bun.write(events, "");
    await Bun.write(probe, "#!/usr/bin/env bun\nconsole.log('5');\n");
    await Bun.write(
      encoder,
      `#!/usr/bin/env bun\nimport {appendFileSync, readFileSync, watch, writeFileSync} from 'node:fs'; import path from 'node:path'; if (!process.argv.includes('null')) { const output = process.argv.at(-1); const index = Number(path.basename(output).slice(6, 9)); const required = Math.min(5, (Math.floor(index / 2) + 1) * 2); const {promise, resolve} = Promise.withResolvers(); const check = () => { if (readFileSync(${JSON.stringify(events)}, 'utf8').split('\\n').filter(line => line === 'start').length >= required) resolve(); }; const watcher = watch(${JSON.stringify(events)}, check); appendFileSync(${JSON.stringify(events)}, 'start\\n'); check(); await promise; watcher.close(); writeFileSync(output, 'encoded'); appendFileSync(${JSON.stringify(events)}, 'end\\n'); }\n`
    );
    await chmod(probe, 0o755);
    await chmod(encoder, 0o755);
    const source = path.join(dir, "source with spaces.mp3");
    await Bun.write(source, "fixture");
    const modulePath = path.join(import.meta.dir, "audio.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import {splitAudio} from ${JSON.stringify(modulePath)}; const chunks = await splitAudio(${JSON.stringify(source)}, 1, ${JSON.stringify(path.join(dir, "chunks"))}, {concurrency: 2}); console.log(JSON.stringify(chunks));`,
      ],
      {
        env: {
          ...process.env,
          PATH: `${dir}:${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    const chunks = z
      .array(z.object({ end: z.number(), start: z.number() }))
      .parse(JSON.parse(stdout));
    expect(chunks).toHaveLength(5);
    let active = 0;
    let maximum = 0;
    const eventLog = await Bun.file(events).text();
    for (const event of eventLog.trim().split("\n")) {
      active += event === "start" ? 1 : -1;
      maximum = Math.max(maximum, active);
    }
    expect(active).toBe(0);
    expect(maximum).toBe(2);
    expect(chunks.every((chunk) => chunk.end - chunk.start <= 1)).toBe(true);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
