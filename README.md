# dikt

Transcribe video URLs or local audio/video files through [OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/stt) or [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Export Markdown, JSON, SRT and VTT. Completed chunks resume from disk; optional notes contain source-linked key points, takeaways and exact transcript quotes.

## Setup

Install [Bun](https://bun.sh), `ffmpeg` and `yt-dlp`:

```bash
brew install ffmpeg yt-dlp
bun install
```

Cloud transcription and notes require an OpenRouter API key:

```bash
cp .env.example .env
# Set OPENROUTER_API_KEY in .env. Bun loads it without dotenv.
```

Local file transcription needs neither a key nor network access. URL inputs still require network access for download.

## Cloud transcription

```bash
bun run dikt "https://www.youtube.com/watch?v=aircAruvnKk" --language en
bun run dikt ./meeting.mp4 --language en --format md,json,srt,vtt
bun run dikt models --region eu
bun run dikt models --region global
```

The defaults are `mistralai/voxtral-mini-transcribe`, EU routing, ten-minute chunks and Markdown output under `transcripts/`. Model discovery uses the selected regional catalog and reports known languages, capabilities and pricing. Unknown capabilities and prices remain unknown.

Dikt checks model availability, known language restrictions and requested provider options before preparing media. The default Voxtral model does not support Swedish. For Swedish, use the local backend or select a compatible model from `models --region global` and pass `--region global --model <slug> --language sv`. Global processing may take place outside the EU.

Known models without timestamps cannot produce SRT/VTT. Some providers reject verbose timestamps at runtime; dikt retries without them only for an explicit unsupported-format response, and only when that fallback preserves requested diarization. Plain text remains exportable as Markdown or JSON.

## Offline transcription

Install whisper.cpp and obtain a compatible GGML model from its [model download instructions](https://github.com/ggml-org/whisper.cpp/tree/master/models):

```bash
brew install whisper-cpp
bun run dikt "./meeting recording.wav" \
  --backend local --local-model ./models/ggml-small.bin \
  --language sv --format md,json,srt,vtt
```

Use a multilingual model for Swedish; an English-only `.en` model cannot transcribe it. Dikt validates the model header, language and executable capabilities before starting. The executable must support `--output-json-full`; override its location with `--whisper-bin`.

Dikt converts chunks to mono 16 kHz PCM WAV for whisper.cpp and reads its actual segment timestamps. It does not turn raw subword tokens into fake word timings. Local transcription has zero API cost and does not support speaker diarization.

## Vocabulary and speakers

```bash
bun run dikt ./meeting.mp4 --language en --diarize \
  --vocabulary Fortnox --vocabulary Schibsted \
  --speaker-name '1:1=Alice' --speaker-name '2:1=Bob'
```

Repeat `--vocabulary` for expected terms. Voxtral uses Mistral's documented `context_bias` option; it does not accept free-form prompts. `--prompt` is available on providers with documented prompt support and on local whisper.cpp. Dikt rejects hints with unsupported or unknown provider support instead of dropping them.

Speaker names require `--diarize`. Keys use one-based `chunk:speaker` numbers. Labels include the chunk even after naming, such as `Alice (chunk 1)`. Speaker 1 in chunk 2 is a separate identity; dikt does not infer that it is Alice.

## Outputs

Use `--format md,json,srt,vtt` to publish all four transcript formats:

| Format | Content |
| --- | --- |
| `md` | Timestamp-linked paragraphs, chapter headings and scoped speakers |
| `json` | Versioned source/model metadata, global evidence IDs and original per-chunk response data |
| `srt` | Sequential millisecond subtitle cues and scoped speaker labels |
| `vtt` | WebVTT cues with millisecond precision and escaped cue markup |

File names combine a sanitized title with the source ID. Local source IDs include a path hash. JSON excludes temporary chunk paths and preserves reported costs as numbers or `null`.

Subtitles require real speech timestamps in every nonempty chunk. Dikt validates all requested transcript formats before publishing any of them. If a provider returns untimed text, rerun with `--format md,json` to reuse the saved response without another paid transcription request. Markdown can link untimed paragraphs to their chunk boundary; that link is not a claimed speech timestamp.

Presentation timestamps use recording-wide offsets and clamp segment ends to actual chunk boundaries. JSON retains the original provider timings as well. Dikt does not rewrite transcript text to make it grammatical or to match notes.

## Source-linked notes

List text models in the chosen region, then select one:

```bash
bun run dikt models --region eu --modality text
# Set NOTES_MODEL to an eligible model slug from the catalog.
bun run dikt ./meeting.mp4 --notes-model "$NOTES_MODEL" --max-cost 1
```

`--notes` enables notes with the default `google/gemini-2.5-flash` text model. Its availability depends on the selected regional catalog; use `--notes-model` to choose another model. Supplying `--notes-model` also enables notes.

Dikt writes a separate `.notes.md` file after publishing the raw transcript. Key points and takeaways are AI interpretations with evidence references. Quotes must be exact contiguous substrings of the cited transcript evidence. References lead to included original evidence and real source timestamps when available. Untimed evidence stays untimed.

Invalid references, invented quotations, refusals, truncated completions and malformed structured JSON fail the notes step. Existing raw transcript outputs remain available. Validation proves quote fidelity and reference existence, not the truth of an AI interpretation or the accuracy of speech recognition.

Notes send the recording title and complete transcript evidence to a text model in the same selected cloud region. Dikt uses a conservative UTF-8 byte bound, reserves 8192 tokens for prompt/schema overhead and limits generated output to 2048 tokens. Oversized or unknown-context requests fail without truncating evidence. Notes have separate cost reporting and their own checkpoint.

Local transcription does not imply permission to upload its text. To request cloud notes from a local run, provide both explicit consent and an explicit notes model:

```bash
bun run dikt ./meeting.wav --backend local \
  --local-model ./models/ggml-small.bin --language sv \
  --allow-cloud-notes --notes-model "$NOTES_MODEL"
```

This uploads transcript text and the title, not audio. It requires `OPENROUTER_API_KEY` and uses the selected `--region`.

## Resume and spending

```bash
bun run dikt ./meeting.mp4 --format md,json --max-cost 0.50
# Rerun the same command after an interruption to reuse completed chunks.
bun run dikt ./meeting.mp4 --format md,json,srt,vtt
bun run dikt ./meeting.mp4 --dry-run
bun run dikt ./meeting.mp4 --force
```

Dikt keeps encoded chunks, manifests and validated transcription responses under `.cache/dikt/`. Each completed chunk gets an atomic checkpoint. Job identity includes source content and transcription settings, including model/backend, region, language, chunk size and hints. Changing presentation formats or speaker names rerenders saved responses. Changing transcription settings creates another job. A per-job process lock prevents simultaneous runs from charging for the same unfinished job.

`--force` bypasses saved chunk and notes results and prepares chunks again. It can incur new charges. Corrupt checkpoints fail with recovery guidance rather than being treated as successful or silently repeated. Cloud reruns still need a key and catalog preflight even when all paid results are cached.

`--max-cost` limits estimated admission of **new requests across this run**, including batch inputs and notes. Cached results do not consume the new-request budget. Dikt uses known duration pricing for transcription and a conservative input/output estimate for notes. Unknown pricing blocks new budgeted requests; an unknown reported cost blocks later budgeted admissions. Notes admission happens once transcript evidence exists, so a notes budget failure can leave a completed raw transcript.

This is not a hard provider billing cap. Failed, retried or timed-out requests may be charged, and reported costs can exceed estimates. Missing costs and failed/invalid responses stay unknown rather than becoming zero. Use provider account/key spending limits for a billing boundary.

`--dry-run` downloads or probes inputs and prepares chunks, then prints cache status and the estimated new transcription cost. It makes no paid transcription or notes requests. It can still access public catalogs, download media and retain prepared audio.

Transient HTTP statuses 408, 429, 500, 502, 503 and 504 can retry within the configured limit and timeout. Dikt does not automatically repeat ambiguous POST transport failures. Unrelated 400 responses do not trigger timestamp fallbacks. Cancellation stops new work, aborts requests/processes and waits for active workers before releasing the job lock.

## Batch and playlists

```bash
bun run dikt ./first.wav ./second.mp4 --format md,json --max-cost 1
bun run dikt batch ./sources.txt --format md,json --max-cost 1
bun run dikt playlist "https://www.youtube.com/playlist?list=..." --max-cost 2
bun run dikt ./first.wav --batch ./more-sources.txt
```

List files contain one URL or path per line, without shell quotes or comments. Blank lines are ignored. Relative paths resolve from the list file's directory; spaces inside a path are preserved. Repeat `--batch` to add more lists.

Playlists expand only with the `playlist` command or `--playlist`. Ordinary URL inputs download one recording. Duplicate inputs are removed in encounter order. Recordings run sequentially, with bounded transcription and encoding workers within each recording.

A per-recording failure does not discard earlier checkpoints or prevent later inputs from being attempted. The final count reports completed inputs; any failed input produces a nonzero exit status. A shared budget can block later paid work after an unknown-cost failure.

## Options

Run `bun run dikt --help` for command syntax.

| Option | Default | Meaning |
| --- | --- | --- |
| `-m, --model <slug>` | `mistralai/voxtral-mini-transcribe` | Cloud transcription model |
| `-r, --region <eu\|global>` | `eu` | Cloud API host for transcription, catalog and notes |
| `-l, --language <code>` | auto | Two-letter language hint |
| `-d, --diarize` | off | Cloud chunk-local speaker labels |
| `-c, --chunk-minutes <n>` | `10` | Maximum audio per chunk |
| `-o, --out <dir>` | `<project>/transcripts` | Transcript and notes directory |
| `--format <list>` | `md` | Comma-separated `md,json,srt,vtt` |
| `--backend <name>` | `openrouter` | `openrouter` or `local` |
| `--local-model <file>` | none | Local whisper.cpp GGML model |
| `--whisper-bin <path>` | `whisper-cli` | Local executable |
| `--prompt <text>` | none | Supported provider or local context |
| `--vocabulary <term>` | none | Repeatable expected terms |
| `--speaker-name <chunk:speaker=name>` | none | Repeatable scoped names, requires diarization |
| `--notes` | off | Generate a separate notes file |
| `--notes-model <slug>` | `google/gemini-2.5-flash` for cloud notes | Select and enable notes |
| `--allow-cloud-notes` | off | Consent for notes from local transcription |
| `--batch <file>` | none | Repeatable additional list files |
| `--playlist` | off | Expand input URLs as playlists |
| `--concurrency <n>` | `3` cloud, `1` local | Transcription workers |
| `--encode-concurrency <n>` | `2` | Encoding workers |
| `--timeout-seconds <n>` | `90` | Per-cloud-request deadline, including retries |
| `--retries <n>` | `2` | Explicit transient HTTP retries, from 0 to 5 |
| `--max-cost <usd>` | none | Run-wide estimated new-request admission budget |
| `--dry-run` | off | Prepare and estimate without paid calls |
| `--force` | off | Bypass saved results |
| `--cache <dir>` | `<project>/.cache/dikt` | Persistent job cache |
| `--downloads <dir>` | `<project>/downloads` | Downloaded media |
| `-h, --help` |  | Show help |

For `models`, `--modality transcription|text` selects the catalog; the default is `transcription`.

## Privacy and retention

EU mode sends cloud requests only to `https://eu.openrouter.ai`. Dikt does not retry on the global host or follow API redirects. OpenRouter [in-region routing](https://openrouter.ai/docs/guides/features/in-region-routing) requires a Business or Enterprise plan. Catalog availability cannot prove that your key has that entitlement; an authorization failure explains the requirement without changing regions. Configure an OpenRouter account/key region guardrail as an additional boundary.

Local file transcription stays offline unless you request cloud notes with explicit consent. URL downloads contact the source site regardless of backend.

Downloads, encoded audio, transcript responses and notes can contain sensitive data. Dikt retains them for resume and does not encrypt them. New job directories use mode 700; atomic checkpoints and output files use mode 600. Git ignores the default download, output and cache directories. Custom paths are your responsibility. Remove retained media and caches after your required retention period, and review source paths and transcript contents before sharing outputs.

## Development

```bash
bun test
bun run typecheck
bun run check
bun run fix
```

Keep Oxc rules enabled. Fix violations without inline suppression comments or disabled rule overrides. Use the bounded worker pool for ordered work and `Promise.all` for independent operations.

The behavioral suite covers response validation, timing boundaries, scoped speakers, grounded quotes, retry/abort behavior, settled worker pools, cache locks and budget transitions. It makes no paid API requests. GitHub Actions installs Bun 1.4.2, ffmpeg and yt-dlp, then runs frozen-lockfile installation, typechecking, lint/format checks and tests.

## License

[MIT](LICENSE)
