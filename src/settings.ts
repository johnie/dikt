/** Regional hosts fail closed; requests must never fall back to the global host. */
export const BASE_URLS = {
  eu: "https://eu.openrouter.ai",
  global: "https://openrouter.ai",
} as const;
export type Region = keyof typeof BASE_URLS;
export const DEFAULT_REGION: Region = "eu";
export const DEFAULT_MODEL = "mistralai/voxtral-mini-transcribe";
