import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { runMediaProcess } from "./audio.ts";
import type { VideoInfo } from "./download.ts";
import type { TranscriptEvidence } from "./exports.ts";
import {
  evidenceArraySchema,
  MAX_NOTES_INPUT_TOKENS,
  NOTES_INSTRUCTIONS,
  notesContentSchema,
  parseNotesResult,
} from "./notes.ts";
import type { NotesResult } from "./notes.ts";

export type AgentNotesProvider = "codex" | "omp" | "claude";
export type NotesProvider = "openrouter" | AgentNotesProvider;

export interface AgentNotesOptions {
  provider: AgentNotesProvider;
  model?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Selected CLI/model request, not a claim about the model the CLI resolved. */
export const agentNotesModel = (
  provider: AgentNotesProvider,
  model: string | undefined
): string => `${provider}:${model ?? "cli-default"}`;

// Claude Code's schema validator accepts Draft 7, not Zod's default Draft 2020-12.
const contentJsonSchema = JSON.stringify(
  z.toJSONSchema(notesContentSchema, { target: "draft-07" })
);
const claudeOutputSchema = z.object({
  is_error: z.literal(false),
  structured_output: notesContentSchema,
  subtype: z.literal("success").optional(),
});

/** Uses native CLI authentication without reading credentials or persisting sessions. */
export const generateAgentNotes = async (
  info: Pick<VideoInfo, "title">,
  evidence: TranscriptEvidence[],
  options: AgentNotesOptions
): Promise<NotesResult> => {
  const entries = evidenceArraySchema.parse(evidence);
  options.signal?.throwIfAborted();
  if (Buffer.byteLength(info.title, "utf-8") > 4096) {
    throw new Error(
      "Notes title exceeds the 4096-byte input cap; refusing silent truncation"
    );
  }
  const source = JSON.stringify({ evidence: entries, title: info.title });
  const inputTokenBound =
    Buffer.byteLength(JSON.stringify(entries), "utf-8") + 8192;
  if (inputTokenBound > MAX_NOTES_INPUT_TOKENS) {
    throw new Error(
      `Notes input upper bound ${inputTokenBound} tokens exceeds input cap (${MAX_NOTES_INPUT_TOKENS}); no evidence was truncated`
    );
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(
      "Agent notes timeout must be a positive integer in milliseconds"
    );
  }
  const executable = Bun.which(options.provider);
  if (!executable) {
    throw new Error(
      `Notes provider ${options.provider} executable was not found on PATH. Install ${options.provider} and sign in with its CLI before using --notes-provider ${options.provider}.`
    );
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ]);
  const directory = await mkdtemp(path.join(tmpdir(), "dikt-agent-notes-"));
  try {
    const modelArgs =
      options.model === undefined ? [] : ["--model", options.model];
    const outputPath = path.join(directory, "notes.json");
    let args: string[];
    let input: string;
    let env: NodeJS.ProcessEnv | undefined;
    switch (options.provider) {
      case "codex": {
        const schemaPath = path.join(directory, "schema.json");
        await Bun.write(schemaPath, contentJsonSchema, { mode: 0o600 });
        args = [
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--ignore-user-config",
          "--ignore-rules",
          "-c",
          "features.shell_tool=false",
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          "--color",
          "never",
          ...modelArgs,
          "-",
        ];
        input = `${NOTES_INSTRUCTIONS}\n\n${source}`;
        break;
      }
      case "claude": {
        args = [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          contentJsonSchema,
          "--tools",
          "",
          "--no-session-persistence",
          "--safe-mode",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--no-chrome",
          ...modelArgs,
        ];
        input = `${NOTES_INSTRUCTIONS}\n\n${source}`;
        // Only remove the nesting guard; retain native auth and model settings.
        env = { ...process.env };
        delete env.CLAUDECODE;
        break;
      }
      case "omp": {
        args = [
          "-p",
          "--mode",
          "text",
          "--no-session",
          "--no-tools",
          "--no-lsp",
          "--no-extensions",
          "--no-skills",
          "--no-rules",
          "--no-title",
          "--system-prompt",
          NOTES_INSTRUCTIONS,
          ...modelArgs,
        ];
        input = `Return only a JSON object matching this schema, without markdown fences:\n${contentJsonSchema}\n\n${source}`;
        break;
      }
      default: {
        throw new Error(
          `Unsupported agent notes provider: ${String(options.provider)}`
        );
      }
    }
    const result = await runMediaProcess(
      executable,
      args,
      signal,
      `${options.provider} notes`,
      { cwd: directory, env, input }
    );
    signal.throwIfAborted();
    let value: unknown;
    try {
      const text =
        options.provider === "codex"
          ? await Bun.file(outputPath).text()
          : result.stdout;
      value = JSON.parse(text);
      if (options.provider === "claude") {
        value = claudeOutputSchema.parse(value).structured_output;
      }
      const content = notesContentSchema.parse(value);
      return parseNotesResult(
        content,
        entries,
        agentNotesModel(options.provider, options.model),
        null
      );
    } catch (error) {
      throw new Error(
        `${options.provider} did not return valid source-grounded notes: ${error instanceof Error ? error.message : String(error)}${result.stderr.trim() ? `\n${result.stderr.trim()}` : ""}`,
        { cause: error }
      );
    }
  } finally {
    // The process runner settles after closure, including on timeout or cancellation.
    await rm(directory, { force: true, recursive: true });
  }
};
