/**
 * Sunbird AI client.
 *
 * Sunbird provides Ugandan-language translation, STT and TTS. We use it for:
 *   - Multilingual ballot rendering (translate question + option labels).
 *   - Voice IVR voting (transcribe recorded caller audio to text).
 *
 * If no credentials are configured we fall back to a passthrough dev stub:
 *   - translate() returns "[lang] <original>".
 *   - transcribe() returns a fixed placeholder transcript.
 * This keeps local demos working without a Sunbird account.
 */

import { config } from "./config.js";

const BASE = config.sunbird.baseUrl.replace(/\/$/, "");

// ISO 639-3 codes Sunbird accepts. Kept intentionally small — these are the
// languages we surface in the ballot picker. Sunbird's translate endpoint
// itself supports 32+ languages, but for UX we want a curated list.
export const SUPPORTED_LANGS = [
  { code: "eng", label: "English" },
  { code: "lug", label: "Luganda" },
  { code: "ach", label: "Acholi" },
  { code: "nyn", label: "Runyankole" },
  { code: "teo", label: "Ateso" },
  { code: "lgg", label: "Lugbara" },
  { code: "swa", label: "Swahili" },
] as const;

export type LangCode = (typeof SUPPORTED_LANGS)[number]["code"];

export function isSupportedLang(code: string): code is LangCode {
  return SUPPORTED_LANGS.some((l) => l.code === code);
}

// -------- auth --------

interface TokenState {
  token: string;
  expiresAt: number; // ms epoch
}
let cachedToken: TokenState | null = null;

/**
 * Whether Sunbird has any credential configured. When false we run a
 * dev stub so ballots and voice still respond.
 */
export function isConfigured(): boolean {
  return Boolean(
    config.sunbird.token ||
      (config.sunbird.username && config.sunbird.password),
  );
}

async function getToken(): Promise<string> {
  // Long-lived token wins.
  if (config.sunbird.token) return config.sunbird.token;
  // Otherwise use OAuth2 password grant (Sunbird tokens last 7 days).
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.token;
  }
  const body = new URLSearchParams({
    username: config.sunbird.username,
    password: config.sunbird.password,
  });
  const res = await fetch(`${BASE}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`sunbird auth ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as { access_token: string };
  cachedToken = {
    token: j.access_token,
    // Sunbird docs say 7-day TTL. Use 6 days to leave slack.
    expiresAt: now + 6 * 24 * 60 * 60 * 1000,
  };
  return cachedToken.token;
}

// -------- translation --------

export interface TranslateInput {
  text: string;
  target: LangCode;
  source?: LangCode; // optional; Sunbird auto-detects when omitted
}

/**
 * Translate a single string. Returns the translated text.
 * Passthrough dev stub when Sunbird is not configured.
 */
export async function translate(input: TranslateInput): Promise<string> {
  const { text, target, source } = input;
  if (!text.trim()) return text;
  if (source === target) return text;

  if (!isConfigured()) {
    // Dev stub: prefix so the UI can visibly show "translation happened".
    return `[${target}] ${text}`;
  }

  const token = await getToken();
  const res = await fetch(`${BASE}/tasks/translate`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      target_language: target,
      ...(source ? { source_language: source } : {}),
      text,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`sunbird translate ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as {
    output?: { translated_text?: string };
    translated_text?: string;
    text?: string;
  };
  // Response shape has shifted between API versions; try known keys.
  return (
    j.output?.translated_text ??
    j.translated_text ??
    j.text ??
    text
  );
}

/**
 * Translate an array of strings. Sequential to keep it simple and avoid
 * hitting rate limits — ballots are small (question + a handful of options).
 */
export async function translateBatch(
  items: string[],
  target: LangCode,
  source?: LangCode,
): Promise<string[]> {
  const out: string[] = [];
  for (const t of items) {
    out.push(await translate({ text: t, target, source }));
  }
  return out;
}

// -------- speech-to-text --------

export interface TranscribeInput {
  audio: Buffer;
  filename?: string;
  contentType?: string;
  language: LangCode; // required by Sunbird STT
}

export interface TranscribeResult {
  text: string;
  language: string;
}

/**
 * Transcribe an audio buffer via Sunbird STT. Uses multipart form-data.
 * Dev stub returns a fixed placeholder so voice-IVR routes can be exercised
 * without credentials.
 */
export async function transcribe(
  input: TranscribeInput,
): Promise<TranscribeResult> {
  if (!isConfigured()) {
    return { text: "one", language: input.language };
  }
  const token = await getToken();
  const form = new FormData();
  const filename = input.filename ?? "audio.wav";
  const contentType = input.contentType ?? "audio/wav";
  const blob = new Blob([new Uint8Array(input.audio)], { type: contentType });
  form.append("audio", blob, filename);
  form.append("language", input.language);
  const res = await fetch(`${BASE}/tasks/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`sunbird stt ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as {
    text?: string;
    transcript?: string;
    audio_transcription?: string;
    language?: string;
  };
  const text =
    j.text ?? j.transcript ?? j.audio_transcription ?? "";
  return { text, language: j.language ?? input.language };
}
