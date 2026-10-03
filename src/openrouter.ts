/** In-Region Routing: regional hosts only route to in-region provider endpoints and fail closed. */
export const BASE_URLS = {
  eu: "https://eu.openrouter.ai",
  global: "https://openrouter.ai",
} as const;

export type Region = keyof typeof BASE_URLS;

export const DEFAULT_REGION: Region = "eu";

/** The only speech-to-text model OpenRouter serves in the EU (Mistral, `mistral/eu` endpoint). */
export const DEFAULT_MODEL = "mistralai/voxtral-mini-transcribe";

export interface Segment {
  start: number;
  end: number;
  text: string;
  speaker?: number;
}

export interface Word {
  start: number;
  end: number;
  word: string;
  speaker?: number;
}

export interface Transcription {
  text: string;
  language: string | undefined;
  /** Absent when the model cannot return timestamps. */
  segments: Segment[] | undefined;
  words: Word[] | undefined;
  cost: number;
}

export interface TranscribeOptions {
  apiKey: string;
  model: string;
  region: Region;
  /** ISO-639-1 code; auto-detected when omitted. */
  language: string | undefined;
  diarize: boolean;
  timestamps: boolean;
}

export class OpenRouterError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`OpenRouter ${status}: ${message}`);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

interface TranscriptionResponse {
  text?: string;
  language?: string;
  segments?: Segment[];
  words?: Word[];
  usage?: { cost?: number };
  error?: { message?: string };
}

export const transcribe = async (
  audioPath: string,
  options: TranscribeOptions
): Promise<Transcription> => {
  const data = Buffer.from(await Bun.file(audioPath).bytes()).toString(
    "base64"
  );

  const response = await fetch(
    `${BASE_URLS[options.region]}/api/v1/audio/transcriptions`,
    {
      body: JSON.stringify({
        input_audio: { data, format: "mp3" },
        language: options.language,
        model: options.model,
        // Options are keyed by endpoint tag and only forwarded to the one serving the request.
        provider: options.diarize
          ? {
              options: {
                azure: { diarization: { enabled: true } },
                deepgram: { diarize: true },
                mistral: { diarize: true },
                "mistral/eu": { diarize: true },
              },
            }
          : undefined,
        response_format: options.timestamps ? "verbose_json" : "json",
        // Some models (e.g. google/gemini-3.5-transcribe) return one segment per request; words allow finer paragraphs.
        timestamp_granularities: options.timestamps
          ? ["segment", "word"]
          : undefined,
      }),
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "dikt",
      },
      method: "POST",
    }
  );

  // SAFETY: OpenRouter returns this JSON shape (or an error object); unparseable bodies become {}.
  const body = (await response
    .json()
    .catch(() => ({}))) as TranscriptionResponse;
  if (!response.ok) {
    throw new OpenRouterError(
      response.status,
      body.error?.message ?? response.statusText
    );
  }

  return {
    cost: body.usage?.cost ?? 0,
    language: body.language,
    segments: body.segments?.length ? body.segments : undefined,
    text: body.text ?? "",
    words: body.words?.length ? body.words : undefined,
  };
};
