// Pocket Watch: word-level transcription (Groq Whisper) for tools like the Reel editor.
// POST raw audio (m4a / mp3 / wav, <= 25 MB), optional ?language=he
//   -> { text, duration, words: [{ word, start, end }] }
//
// Same contract as ingest: 401 for a bad x-pocket-key, 405 for non-POST, otherwise 200 and expected
// failures come back as { error, code, message_he }. Counts one call against the daily cap.
//
// Secrets: GROQ_API_KEY (required), POCKET_SHARED_KEY. Optional: TRANSCRIBE_WORDS_MODEL (default whisper-large-v3).

import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
// Fail closed: with no secret (or a short one) every request is rejected instead of an empty header matching.
const POCKET_KEY = Deno.env.get("POCKET_SHARED_KEY") ?? "";
// Strip whitespace / invisible marks that sneak in when a key is pasted from a browser.
const clean = (v: string) => v.replace(/[\s\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "");
const GROQ_KEY = clean(Deno.env.get("GROQ_API_KEY") ?? "");
const MODEL = Deno.env.get("TRANSCRIBE_WORDS_MODEL") ?? "whisper-large-v3";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_CALLS_PER_DAY = Number(Deno.env.get("MAX_CALLS_PER_DAY") ?? 150);
const MAX_CHARS_PER_DAY = Number(Deno.env.get("MAX_CHARS_PER_DAY") ?? 300_000);

type ErrorCode = "empty" | "too_long" | "no_transcriber" | "rate_limited" | "upstream" | "internal";
const MESSAGE_HE: Record<ErrorCode, string> = {
  empty: "לא התקבל אודיו.",
  too_long: "הקובץ גדול מדי (עד 25MB).",
  no_transcriber: "תמלול לא מוגדר בשרת (GROQ_API_KEY).",
  rate_limited: "הגעת למכסה היומית.",
  upstream: "שירות התמלול לא זמין כרגע.",
  internal: "שגיאה פנימית.",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function fail(code: ErrorCode, detail: string): Response {
  return json({ error: detail, code, message_he: MESSAGE_HE[code] }, 200);
}
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  let diff = ab.byteLength ^ bb.byteLength;
  for (let i = 0; i < Math.max(ab.byteLength, bb.byteLength); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// Groq infers the audio format from the file name, so derive one from the content type.
function fileNameFor(contentType: string): string {
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "audio.mp3";
  if (contentType.includes("wav")) return "audio.wav";
  if (contentType.includes("webm")) return "audio.webm";
  if (contentType.includes("ogg")) return "audio.ogg";
  return "audio.m4a";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (POCKET_KEY.length < 16 || !safeEqual(req.headers.get("x-pocket-key") ?? "", POCKET_KEY)) return json({ error: "unauthorized" }, 401);

  try {
    if (!GROQ_KEY || !/^[\x21-\x7E]+$/.test(GROQ_KEY)) return fail("no_transcriber", "GROQ_API_KEY missing or invalid");

    const contentType = req.headers.get("content-type") ?? "audio/mp4";
    const audio = new Uint8Array(await req.arrayBuffer());
    if (audio.byteLength === 0) return fail("empty", "empty body");
    if (audio.byteLength > MAX_AUDIO_BYTES) return fail("too_long", `${Math.round(audio.byteLength / 1e6)} MB > 25 MB`);

    const { data: allowed, error: usageError } = await supabase.rpc("pocket_consume", {
      p_chars: 0,
      p_max_calls: MAX_CALLS_PER_DAY,
      p_max_chars: MAX_CHARS_PER_DAY,
    });
    if (usageError) return fail("internal", `usage: ${usageError.message}`);
    if (!allowed) return fail("rate_limited", "daily cap reached");

    const form = new FormData();
    form.append("file", new Blob([audio as BlobPart], { type: contentType }), fileNameFor(contentType));
    form.append("model", MODEL);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("temperature", "0");
    const language = new URL(req.url).searchParams.get("language");
    if (language && /^[a-z]{2,3}$/.test(language)) form.append("language", language);

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_KEY}` },
      body: form,
    });
    if (!res.ok) return fail("upstream", `transcription ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const data = await res.json() as {
      text?: string;
      duration?: number;
      words?: { word: string; start: number; end: number }[];
    };
    return json({
      text: (data.text ?? "").trim(),
      duration: data.duration ?? null,
      words: (data.words ?? []).map((w) => ({ word: w.word, start: w.start, end: w.end })),
    });
  } catch (err) {
    console.error(err);
    return fail("internal", err instanceof Error ? err.message : String(err));
  }
});
