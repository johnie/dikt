import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentNotesProvider } from "./agent-notes.ts";
import type { TranscriptEvidence } from "./exports.ts";
import { mapLimit } from "./pool.ts";

const timedEvidence: TranscriptEvidence = {
  chunkIndex: 0,
  end: 5.75,
  id: "c1-s1",
  speaker: 2,
  start: 2.5,
  text: "We should invest in better tools. $(never execute this)",
};
const evidence: TranscriptEvidence[] = [
  timedEvidence,
  { chunkIndex: 1, id: "c2-p1", text: "Keep learning every day." },
];
const content = {
  keyPoints: [{ evidenceIds: ["c1-s1"], text: "Tools merit investment." }],
  quotes: [{ evidenceId: "c1-s1", text: "invest in better tools" }],
  takeaways: [{ evidenceIds: ["c2-p1"], text: "Keep learning." }],
};
const modulePath = path.join(import.meta.dir, "agent-notes.ts");

interface Fixture {
  directory: string;
  capture: string;
  ready: string;
  closed: string;
  descendantClosed: string;
}

const withFixture = async (run: (fixture: Fixture) => Promise<void>) => {
  const directory = await mkdtemp(path.join(tmpdir(), "dikt-agent-test-"));
  const fixture = {
    capture: path.join(directory, "capture.json"),
    closed: path.join(directory, "closed.json"),
    descendantClosed: path.join(directory, "descendant-closed.json"),
    directory,
    ready: path.join(directory, "ready"),
  };
  try {
    const script = `#!${process.execPath}
import { existsSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
const args = process.argv.slice(2);
const provider = process.env.FIXTURE_PROVIDER;
const mode = process.env.FIXTURE_MODE;
if (mode === "early-exit") {
  process.stdin.destroy();
  console.error("subscription login expired");
  process.exit(7);
}
const input = await new Response(Bun.stdin.stream()).text();
writeFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify({args, cwd: process.cwd(), input, mode: statSync(process.cwd()).mode & 0o777}));
if (mode === "hang") {
  const descendant = spawn(process.execPath, ["-e", \`import {existsSync,writeFileSync} from 'node:fs'; import {createServer} from 'node:net'; process.on('SIGTERM', () => {writeFileSync(process.env.FIXTURE_DESCENDANT_CLOSED, JSON.stringify({cwdExists: existsSync(process.cwd())})); process.exit(0)}); createServer().listen(0, '127.0.0.1', () => writeFileSync(process.env.FIXTURE_READY, 'ready'));\`], {stdio: ["ignore", "inherit", "inherit"]});
  process.on("SIGTERM", () => {
    writeFileSync(process.env.FIXTURE_CLOSED, JSON.stringify({cwdExists: existsSync(process.cwd())}));
    descendant.once("exit", () => process.exit(0));
  });
  createServer().listen(0, "127.0.0.1");
} else {
  let value = JSON.parse(process.env.FIXTURE_CONTENT);
  let text = JSON.stringify(value);
  if (mode === "malformed") text = "not JSON";
  if (mode === "fenced") text = "\u0060\u0060\u0060json\\n" + text + "\\n\u0060\u0060\u0060";
  if (provider === "claude") {
    if (mode === "refusal") text = JSON.stringify({is_error: true, result: "Refused"});
    else if (mode === "missing-structured") text = JSON.stringify({is_error: false, result: text});
    else if (mode !== "malformed" && mode !== "fenced") text = JSON.stringify({is_error: false, subtype: "success", structured_output: value});
  }
  if (mode === "failure") {
    console.error("subscription login expired");
    process.exitCode = 7;
  } else if (provider === "codex") {
    console.log("progress output is not the final message");
    if (mode !== "missing-output") writeFileSync(args[args.indexOf("--output-last-message") + 1], text);
  } else {
    console.log(text);
  }
}
`;
    await Promise.all(
      ["codex", "omp", "claude"].map(async (provider) => {
        const executable = path.join(directory, provider);
        await Bun.write(executable, script);
        await chmod(executable, 0o755);
      })
    );
    await run(fixture);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

const invoke = async (
  fixture: Fixture,
  provider: AgentNotesProvider,
  options: {
    mode?: string;
    content?: unknown;
    source?: TranscriptEvidence[];
    title?: string;
    model?: string;
    timeoutMs?: number;
    cancel?: boolean;
    missing?: boolean;
  } = {}
): Promise<{ name?: string; error?: string; value?: unknown }> => {
  const sourcePath = path.join(fixture.directory, "source.json");
  await Bun.write(sourcePath, JSON.stringify(options.source ?? evidence));
  const source = `
import {generateAgentNotes} from ${JSON.stringify(modulePath)};
import {existsSync, watch} from "node:fs";
const controller = new AbortController();
let watcher;
if (${Boolean(options.cancel)}) {
  watcher = watch(${JSON.stringify(fixture.directory)}, () => {
    if (existsSync(${JSON.stringify(fixture.ready)})) controller.abort(new Error("Cancelled by caller"));
  });
}
try {
  const value = await generateAgentNotes(
    {title: ${JSON.stringify(options.title ?? "A meeting")}},
    JSON.parse(await Bun.file(${JSON.stringify(sourcePath)}).text()),
    {provider: ${JSON.stringify(provider)}, model: ${JSON.stringify(options.model)}, timeoutMs: ${options.timeoutMs ?? 10_000}, signal: controller.signal}
  );
  console.log(JSON.stringify({value}));
} catch (error) {
  console.log(JSON.stringify({name: error.name, error: error.message}));
} finally {
  watcher?.close();
}
`;
  const child = Bun.spawn([process.execPath, "-e", source], {
    env: {
      ...process.env,
      FIXTURE_CAPTURE: fixture.capture,
      FIXTURE_CLOSED: fixture.closed,
      FIXTURE_CONTENT: JSON.stringify(options.content ?? content),
      FIXTURE_DESCENDANT_CLOSED: fixture.descendantClosed,
      FIXTURE_MODE: options.mode ?? "success",
      FIXTURE_PROVIDER: provider,
      FIXTURE_READY: fixture.ready,
      PATH: options.missing ? "" : fixture.directory,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  return JSON.parse(stdout);
};

for (const provider of ["codex", "omp", "claude"] as const) {
  test(`${provider} rejects failed, malformed and ungrounded output without repair or fallback`, async () => {
    await withFixture(async (fixture) => {
      await mapLimit(
        ["failure", "malformed", "fenced", "early-exit"],
        1,
        async (mode) => {
          const result = await invoke(fixture, provider, {
            mode,
            source:
              mode === "early-exit"
                ? [{ ...timedEvidence, text: "x".repeat(100_000) }]
                : evidence,
          });
          expect(result.error).toBeDefined();
          expect(result.value).toBeUndefined();
          if (mode === "failure" || mode === "early-exit") {
            expect(result.error).toContain("subscription login expired");
          }
        }
      );
      await mapLimit(
        [
          { ...content, keyPoints: [{ evidenceIds: [], text: "Claim" }] },
          {
            ...content,
            takeaways: [{ evidenceIds: ["invented"], text: "Claim" }],
          },
          {
            ...content,
            quotes: [
              { evidenceId: "c1-s1", text: "invest in excellent tools" },
            ],
          },
          {
            ...content,
            quotes: [{ evidenceId: "c2-p1", text: "invest in better tools" }],
          },
          { ...content, model: "fabricated-model" },
          { ...content, refusal: "Cannot comply" },
        ],
        1,
        async (invalid) => {
          const result = await invoke(fixture, provider, { content: invalid });
          expect(result.error).toContain("valid source-grounded notes");
          expect(result.value).toBeUndefined();
        }
      );
    });
  }, 15_000);
}

test("Claude rejects successful exits with refusal or no structured result", async () => {
  await withFixture(async (fixture) => {
    await mapLimit(["refusal", "missing-structured"], 1, async (mode) => {
      const result = await invoke(fixture, "claude", { mode });
      expect(result.error).toContain("valid source-grounded notes");
    });
  });
});

test("Codex requires its final-message file rather than accepting progress stdout", async () => {
  await withFixture(async (fixture) => {
    const result = await invoke(fixture, "codex", { mode: "missing-output" });
    expect(result.error).toContain("valid source-grounded notes");
  });
});

test("missing executables report native CLI installation and login requirements", async () => {
  await withFixture(async (fixture) => {
    await mapLimit(["codex", "omp", "claude"] as const, 1, async (provider) => {
      const result = await invoke(fixture, provider, { missing: true });
      expect(result.error).toContain(
        `${provider} executable was not found on PATH`
      );
      expect(result.error).toContain("sign in");
    });
    expect(existsSync(fixture.capture)).toBe(false);
  });
});

test("invalid evidence and oversized input are rejected before launching a CLI", async () => {
  await withFixture(async (fixture) => {
    await mapLimit(
      [
        [],
        [timedEvidence, timedEvidence],
        [{ ...timedEvidence, end: 2, start: 10 }],
        [{ ...timedEvidence, text: "x".repeat(131_072) }],
      ],
      1,
      async (source) => {
        const result = await invoke(fixture, "omp", { source });
        expect(result.error).toBeDefined();
      }
    );
    const result = await invoke(fixture, "omp", { title: "x".repeat(4097) });
    expect(result.error).toContain("4096-byte input cap");
    expect(existsSync(fixture.capture)).toBe(false);
  });
});

for (const cancel of [true, false]) {
  test(`${cancel ? "caller cancellation" : "timeout"} closes the entire agent process group before removing its working directory`, async () => {
    await withFixture(async (fixture) => {
      const result = await invoke(fixture, "omp", {
        cancel,
        mode: "hang",
        // Exercise native AbortSignal.timeout across real child processes.
        timeoutMs: cancel ? 10_000 : 3000,
      });
      if (cancel) {
        expect(result.error).toBe("Cancelled by caller");
      } else {
        expect(result.name).toBe("TimeoutError");
      }
      expect(await Bun.file(fixture.closed).json()).toEqual({
        cwdExists: true,
      });
      expect(await Bun.file(fixture.descendantClosed).json()).toEqual({
        cwdExists: true,
      });
      const capture = await Bun.file(fixture.capture).json();
      expect(existsSync(capture.cwd)).toBe(false);
    });
  }, 15_000);
}
