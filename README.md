# dikt

Downloads a video's audio with [yt-dlp](https://github.com/yt-dlp/yt-dlp), transcribes it through the [OpenRouter speech-to-text API](https://openrouter.ai/docs/guides/overview/multimodal/stt) and writes a Markdown transcript to `transcripts/`.

## Setup

Requires `yt-dlp` and `ffmpeg` on `PATH` (`brew install yt-dlp ffmpeg`).

```bash
bun install
cp .env.example .env # then set OPENROUTER_API_KEY
```

## Usage

```bash
bun run dikt <url> [options]
```

| Option | Default | Description |
| --- | --- | --- |
| `-m, --model <slug>` | `mistralai/voxtral-mini-transcribe` | Any model from `GET /api/v1/models?output_modalities=transcription` (add `&region=eu` for EU-served ones) |
| `-r, --region <eu\|global>` | `eu` | `eu` sends requests to `https://eu.openrouter.ai`; `global` to `https://openrouter.ai` |
| `-l, --language <code>` | auto-detect | ISO-639-1 hint, e.g. `en`, `sv` |
| `-d, --diarize` | off | Speaker labels (models served by Azure, Deepgram or Mistral) |
| `-c, --chunk-minutes <n>` | `10` | Max audio per request |
| `-o, --out <dir>` | `transcripts/` | Output directory |

Example:

```bash
bun run dikt "https://www.youtube.com/watch?v=aircAruvnKk" --language en
# → transcripts/but-what-is-a-neural-network-deep-learning-chapter-1-aircAruvnKk.md
```

Swedish, or any non-EU model (audio is processed outside the EU):

```bash
bun run dikt "https://www.youtube.com/watch?v=VIDEO_ID" -m google/gemini-3.5-transcribe -r global -l sv
```

## EU data residency

By default, requests go to `https://eu.openrouter.ai` ([In-Region Routing](https://openrouter.ai/docs/guides/features/in-region-routing)). OpenRouter decrypts and processes them in the EU and only routes to provider endpoints it has approved for the EU. If a model has no EU endpoint, the request fails instead of being sent elsewhere.

- In-region routing requires an OpenRouter Business or Enterprise plan.
- The EU list of speech-to-text models currently has one entry: `mistralai/voxtral-mini-transcribe`, served by Mistral's `mistral/eu` endpoint. Models such as `google/gemini-3.5-transcribe` (Google AI Studio only) need `-r global`. Check the current list with `curl "https://eu.openrouter.ai/api/v1/models?output_modalities=transcription"`.
- Voxtral Mini Transcribe supports 13 languages: English, Chinese, Hindi, Spanish, Arabic, French, Portuguese, Russian, German, Japanese, Korean, Italian and Dutch. Any other `--language` code (e.g. `sv`) gets `OpenRouter 400: Provider returned 400`. Without a hint, Swedish speech comes out partly in Danish. Use `-m google/gemini-3.5-transcribe -r global` for Swedish.
- To block non-EU requests entirely, set `allowed_data_regions: ["europe"]` on the workspace or key guardrail. Requests to `openrouter.ai` then get a 403.

## How it works

1. `yt-dlp` downloads the best audio-only stream to `downloads/` (gitignored). Re-runs reuse the file.
2. `ffmpeg` re-encodes to mono 16 kHz MP3 and splits it into chunks, cutting at the nearest pause before each boundary. OpenRouter's upstream providers time out after about 60 s, so long audio can't go in one request.
3. Chunks are sent to `POST /api/v1/audio/transcriptions` three at a time with `response_format: "verbose_json"` to get segment timestamps. Models that reject `verbose_json` (e.g. `openai/gpt-4o-transcribe`) are retried without timestamps.
4. Segments are merged into paragraphs: a new paragraph starts on a speaker change, a pause over 2.5 s, a new chapter, or the first sentence end after 60 s. Each paragraph links to its timestamp on YouTube. YouTube chapters become `##` headings.

The default model, Voxtral Mini Transcribe 2 (`mistralai/voxtral-mini-transcribe-2602`), costs $0.000055 per audio second on the EU endpoint (about $0.20 per hour). The total cost is printed when the run finishes.

With `--diarize`, speaker numbers are assigned per chunk, so "Speaker 1" in one chunk can be a different person in the next. To keep labels consistent, raise `--chunk-minutes` so the audio fits in fewer chunks, as long as each request still finishes within the provider timeout.

## License

[MIT](LICENSE)
