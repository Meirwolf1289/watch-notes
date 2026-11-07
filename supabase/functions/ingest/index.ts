// Pocket Watch ingest function
// POST JSON {text, recorded_at?} (Shortcut dictation) -> structure with Claude -> save -> JSON
// POST raw audio (m4a)                                -> store -> transcribe -> same pipeline
//
// Required secrets:
//   ANTHROPIC_API_KEY, POCKET_SHARED_KEY
//   Audio path: GROQ_API_KEY (preferred, ~$0.11/h) or OPENAI_API_KEY (whisper-1, $0.36/h). Any
//   OpenAI-compatible /audio/transcriptions endpoint works via TRANSCRIBE_BASE_URL + TRANSCRIBE_API_KEY.
// Optional:
//   CLAUDE_MODEL (default "claude-haiku-5-5"), TRANSCRIBE_MODEL (default whisper-large-v3 on Groq, whisper-1 on OpenAI),
//   POCKET_TZ (default "Asia/Jerusalem"), MAX_TEXT_CHARS, MAX_CALLS_PER_DAY, MAX_CHARS_PER_DAY,
//   PRICE_IN_PER_M, PRICE_OUT_PER_M, ILS_PER_USD
//
// Deploy with: supabase functions deploy ingest --no-verify-jwt
// (auth is the x-pocket-key header instead of a Supabase JWT)
//
// HTTP status contract (the Shortcut depends on it):
//   401  bad x-pocket-key    -> Shortcut aborts (correct: nothing to save)
//   405  not POST, 413 body > 64 KB
//   200  everything else, INCLUDING expected failures. Shortcuts' "Get Contents of URL" aborts the
//        whole run on any non-2xx before an If can fire, so failures come back in the body as
//        { error, code, message_he } and the success body never contains an "error" key.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { DEFAULT_TZ, localContext, type LocalContext, normalizeDue } from "./dates.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
// Fail closed: with no secret (or a short one) every request is rejected instead of an empty header matching.
const POCKET_KEY = Deno.env.get("POCKET_SHARED_KEY") ?? "";

// ---- transcription provider (OpenAI-compatible multipart API) ------------------------------
// Picked from whichever secret exists: explicit TRANSCRIBE_* > Groq > OpenAI.
// Strip whitespace and invisible / RTL marks that sneak in when a key is pasted from a browser.
const clean = (v: string) => v.replace(/[\s\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "");
const GROQ_KEY = clean(Deno.env.get("GROQ_API_KEY") ?? "");
const OPENAI_KEY = clean(Deno.env.get("OPENAI_API_KEY") ?? "");
const TRANSCRIBE_KEY = clean(Deno.env.get("TRANSCRIBE_API_KEY") ?? "") || GROQ_KEY || OPENAI_KEY; // `||`: empty strings must fall through
// An HTTP header value must be Latin-1; anything outside printable ASCII means the secret was pasted wrong.
const TRANSCRIBE_KEY_OK = /^[\x21-\x7E]*$/.test(TRANSCRIBE_KEY);
const TRANSCRIBE_BASE_URL = (Deno.env.get("TRANSCRIBE_BASE_URL") ??
  (GROQ_KEY && !Deno.env.get("TRANSCRIBE_API_KEY") ? "https://api.groq.com/openai/v1" : "https://api.openai.com/v1"))
  .replace(/\/$/, "");
const TRANSCRIBE_MODEL = Deno.env.get("TRANSCRIBE_MODEL") ??
  (TRANSCRIBE_BASE_URL.includes("groq.com") ? "whisper-large-v3" : "whisper-1");
// Haiku = cheapest; plenty for turning a short note into JSON
const CLAUDE_MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-haiku-5-5";
const POCKET_TZ = Deno.env.get("POCKET_TZ") ?? DEFAULT_TZ;

// ---- spend guardrails ---------------------------------------------------------------------
// A 45-minute Hebrew meeting is ~25k chars; Haiku handles that for well under one agora.
const MAX_TEXT_CHARS = Number(Deno.env.get("MAX_TEXT_CHARS") ?? 30_000); // one note / meeting
const MAX_BODY_BYTES = 64 * 1024; // raw JSON body
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // OpenAI transcription limit
const MAX_CALLS_PER_DAY = Number(Deno.env.get("MAX_CALLS_PER_DAY") ?? 150);
const MAX_CHARS_PER_DAY = Number(Deno.env.get("MAX_CHARS_PER_DAY") ?? 300_000);
// USD per 1M tokens, claude-haiku-5-5 list price. Change these if CLAUDE_MODEL changes.
const PRICE_IN_PER_M = Number(Deno.env.get("PRICE_IN_PER_M") ?? 0.10);
const PRICE_OUT_PER_M = Number(Deno.env.get("PRICE_OUT_PER_M") ?? 0.50);
const ILS_PER_USD = Number(Deno.env.get("ILS_PER_USD") ?? 3.16);

// Shortcuts gives "Get Contents of URL" ~60 s. Two Claude attempts + pause must stay well under it.
const CLAUDE_TIMEOUT_MS = 15_000;
const CLAUDE_RETRY_AFTER_MS = 1_500;
const CLAUDE_RETRY_STATUSES = new Set([429, 500, 502, 503, 529]);
const WRIST_MAX = 60;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// ---- types --------------------------------------------------------------------------------
type ActionItem = {
  task: string;
  owner: string | null;
  due: string | null; // ISO-8601 with offset, e.g. 2026-11-08T19:00:00+02:00
  due_text: string | null; // how it was said: "מחר 19:00", "חמישי הקרוב"
};
type NoteLanguage = "he" | "en" | "mixed" | "other";
type NoteResult = {
  title: string;
  summary: string;
  wrist: string; // one line for the watch notification
  language: NoteLanguage;
  action_items: ActionItem[];
  people: string[];
};
type Usage = { input_tokens: number; output_tokens: number };
type Structured = { result: NoteResult; usage: Usage; latency_ms: number };

// Minimal shape of the Messages API response (raw fetch, no SDK in Deno here).
type TextBlock = { type: "text"; text: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type OtherBlock = { type: string };
type ContentBlock = TextBlock | ToolUseBlock | OtherBlock;
type MessagesResponse = {
  stop_reason: string;
  content: ContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
};

// Expected failures. Each one is a 200 with this code + a Hebrew line the watch can show.
type ErrorCode =
  | "empty"
  | "no_transcriber"
  | "bad_transcriber_key"
  | "too_long"
  | "rate_limited"
  | "bad_request"
  | "upstream"
  | "bad_model_output"
  | "db"
  | "internal";

const MESSAGE_HE: Record<ErrorCode, string> = {
  empty: "לא נקלט דיבור. נסה שוב.",
  no_transcriber: "תמלול עוד לא מוגדר: צריך GROQ_API_KEY או OPENAI_API_KEY בשרת.",
  bad_transcriber_key: "מפתח התמלול בשרת מכיל תווים לא תקינים. הדבק אותו מחדש.",
  too_long: `ההערה ארוכה מדי (עד ${MAX_TEXT_CHARS} תווים). הטקסט נשמר כתזכורת.`,
  rate_limited: "הגעת למכסה היומית. נסה מחר.",
  bad_request: "הבקשה לא תקינה.",
  upstream: "Claude לא זמין כרגע. הטקסט נשמר כתזכורת.",
  bad_model_output: "התשובה מהמודל לא תקינה. הטקסט נשמר כתזכורת.",
  db: "השמירה במסד הנתונים נכשלה. הטקסט נשמר כתזכורת.",
  internal: "שגיאה פנימית. הטקסט נשמר כתזכורת.",
};

class PocketError extends Error {
  constructor(readonly code: ErrorCode, detail: string) {
    super(detail);
  }
}

// ---- the output contract: a tool schema, not "reply with only JSON" ----------------------
// strict:true => every property listed in `required`, additionalProperties:false, nullable via ["string","null"].
const SAVE_NOTE_TOOL = {
  name: "save_note",
  description: "Save the structured version of a voice note. Call this exactly once with every field filled.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "summary", "wrist", "language", "action_items", "people"],
    properties: {
      title: { type: "string", description: "Short title, max 6 words, same language as the transcript." },
      summary: {
        type: "string",
        description:
          "Same language as the transcript. For a short note: 2-3 sentences. For a meeting or long conversation: " +
          "4-8 short lines, one per topic, each starting with '• ', decisions first, then open questions.",
      },
      wrist: {
        type: "string",
        description:
          `ONE line for an Apple Watch notification, max ${WRIST_MAX} characters, no line breaks, no trailing period. ` +
          "Same language as the transcript. Lead with the single most important action, who, and when " +
          "(e.g. Hebrew: 'להתקשר לקים מחר על תקציב Q1'). Never a generic phrase like 'note saved'.",
      },
      language: {
        type: "string",
        enum: ["he", "en", "mixed", "other"],
        description: "Dominant language of the transcript. 'mixed' only when Hebrew and English are both substantial.",
      },
      action_items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["task", "owner", "due", "due_text"],
          properties: {
            task: { type: "string", description: "Imperative, specific, same language as the transcript." },
            owner: { type: ["string", "null"], description: "Person responsible, or null if the speaker." },
            due: {
              type: ["string", "null"],
              description: "ISO-8601 with the UTC offset from now_local, e.g. 2026-11-08T19:00:00+02:00, or null.",
            },
            due_text: {
              type: ["string", "null"],
              description: "The time phrase as the speaker said it, e.g. 'מחר 19:00' / 'חמישי הקרוב', or null.",
            },
          },
        },
      },
      people: { type: "array", items: { type: "string" }, description: "Names mentioned. Empty array if none." },
    },
  },
} as const;

const SYSTEM_PROMPT = `You turn a voice-note transcript into structured notes by calling the save_note tool.
Write every field in the same language as the transcript (Hebrew in, Hebrew out). Keep names as spoken.
If there are no action items or people, use empty arrays. Do not write anything outside the tool call.
For a meeting or conversation transcript: list every commitment anyone made as an action item with its owner
(the speaker is "me"), keep decisions in the summary, and ignore small talk.

DATE RULES. The user lives in Israel. You are given now_local: the local date, weekday and
UTC offset at the moment of recording. Resolve every relative date against now_local, never
against UTC, and put the same offset in "due".
- The week starts on Sunday: ראשון=Sunday, שני=Monday, שלישי=Tuesday, רביעי=Wednesday,
  חמישי=Thursday, שישי=Friday, שבת=Saturday.
- "ביום X" / "X הקרוב" = the next X strictly AFTER today (if today is Thursday, "חמישי" is next week).
  "X הבא" / "בשבוע הבא ביום X" = the X of next week (after the coming Saturday).
- "מחר" = calendar day after now_local, even at 01:00 at night. "מחרתיים" = +2 days.
- סופ"ש / סוף השבוע = the coming Friday. מוצ"ש = the coming Saturday at 20:00.
- Times of day without a number: בבוקר 09:00, בצהריים 13:00, אחה"צ 16:00, בערב 19:00, בלילה 21:00.
  "בשבע בערב" = 19:00, "בשבע בבוקר" = 07:00. A bare "בשבע" after 12:00 means 19:00.
- If only a day is named and no time, use 09:00.
- If the resolved moment is already in the past relative to now_local, move it to the next matching day.
- If the task has no date at all, due and due_text are null. Never invent dates.`;

// ---- helpers ------------------------------------------------------------------------------
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// 200 on purpose: see the status contract at the top of the file.
function fail(code: ErrorCode, detail: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: detail, code, message_he: MESSAGE_HE[code], ...extra }, 200);
}

// Constant-time compare: a plain `!==` returns early on the first mismatching byte.
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.byteLength ^ bb.byteLength;
  const n = Math.max(ab.byteLength, bb.byteLength);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function costUsd(u: Usage): number {
  return (u.input_tokens * PRICE_IN_PER_M + u.output_tokens * PRICE_OUT_PER_M) / 1_000_000;
}

// Type predicate: narrows ContentBlock -> ToolUseBlock so .find() returns the right type.
function isToolUse(b: ContentBlock): b is ToolUseBlock {
  return b.type === "tool_use";
}

// strict mode guarantees shape, but a model can still hand back 80 chars when asked for 60.
function clampWrist(wrist: string, title: string): string {
  const oneLine = wrist.replace(/\s+/g, " ").trim().replace(/[.。]$/, "");
  const base = oneLine || title;
  const chars = Array.from(base); // code points, so Hebrew/emoji never split mid-glyph
  return chars.length <= WRIST_MAX ? base : chars.slice(0, WRIST_MAX - 1).join("").trimEnd() + "…";
}

function normalizeResult(input: unknown, offset: string): NoteResult {
  if (!input || typeof input !== "object") throw new PocketError("bad_model_output", "tool input is not an object");
  const p = input as Record<string, unknown>;
  const rawItems: unknown[] = Array.isArray(p.action_items) ? p.action_items : [];
  const action_items: ActionItem[] = rawItems
    .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
    .map((it) => ({
      task: String(it.task ?? "").trim(),
      owner: typeof it.owner === "string" && it.owner ? it.owner : null,
      due: normalizeDue(it.due, offset),
      due_text: typeof it.due_text === "string" && it.due_text ? it.due_text : null,
    }))
    .filter((it) => it.task.length > 0);
  const title = String(p.title ?? "").trim() || "Untitled note";
  const lang = p.language;
  return {
    title,
    summary: String(p.summary ?? ""),
    wrist: clampWrist(String(p.wrist ?? ""), title),
    language: lang === "he" || lang === "en" || lang === "mixed" ? lang : "other",
    action_items,
    people: Array.isArray(p.people) ? p.people.map(String) : [],
  };
}

async function transcribe(audio: Uint8Array, contentType: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([audio as BlobPart], { type: contentType }), "audio.m4a");
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", "json");
  // Language is auto-detected: notes mix Hebrew with English names and terms.

  const res = await fetch(`${TRANSCRIBE_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TRANSCRIBE_KEY}` },
    body: form,
  });
  if (!res.ok) throw new PocketError("upstream", `transcription failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { text: string };
  return data.text.trim();
}

function callClaude(body: string): Promise<Response> {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
  });
}

async function structure(transcript: string, now: LocalContext): Promise<Structured> {
  const t0 = performance.now();
  const body = JSON.stringify({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: [SAVE_NOTE_TOOL],
    // Forcing the tool skips any thinking and guarantees a tool_use block.
    tool_choice: { type: "tool", name: SAVE_NOTE_TOOL.name },
    messages: [{
      role: "user",
      content: `now_local: ${now.iso} (${now.weekday}; ${now.hebrew}; timezone ${now.tz})\n\ntranscript:\n${transcript}`,
    }],
  });

  let res: Response;
  try {
    res = await callClaude(body);
    if (CLAUDE_RETRY_STATUSES.has(res.status)) {
      // One retry covers the common 529 "overloaded" blip without blowing the Shortcut's timeout.
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, CLAUDE_RETRY_AFTER_MS));
      res = await callClaude(body);
    }
  } catch (e) {
    throw new PocketError("upstream", `claude unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new PocketError("upstream", `claude ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = await res.json() as MessagesResponse;
  if (data.stop_reason === "refusal") throw new PocketError("bad_model_output", "claude refused the transcript");
  if (data.stop_reason === "max_tokens") throw new PocketError("bad_model_output", "claude output truncated");

  const toolUse = data.content.find(isToolUse);
  if (!toolUse) throw new PocketError("bad_model_output", "model returned no save_note call");

  return {
    result: normalizeResult(toolUse.input, now.offset),
    usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 },
    latency_ms: Math.round(performance.now() - t0),
  };
}

// "Never lose the dictated text": on any failure after we have a transcript, park it server-side
// with status='failed' so it can be re-processed later. Returns the row id or null.
async function parkFailedNote(
  transcript: string,
  recordedAt: string,
  audioPath: string | null,
  code: ErrorCode,
): Promise<string | null> {
  if (!transcript) return null;
  const { data, error } = await supabase
    .from("notes")
    .insert({ recorded_at: recordedAt, audio_path: audioPath, transcript, status: "failed", error_code: code })
    .select("id")
    .single();
  if (error) {
    console.error(`park failed (${code}): ${error.message}`);
    return null;
  }
  return data.id;
}

// ---- handler ------------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (POCKET_KEY.length < 16 || !safeEqual(req.headers.get("x-pocket-key") ?? "", POCKET_KEY)) return json({ error: "unauthorized" }, 401);

  // Hoisted so the catch block can park the transcript.
  let transcript = "";
  let recordedAt = new Date().toISOString();
  let audioPath: string | null = null;

  try {
    const contentType = req.headers.get("content-type") ?? "audio/m4a";

    if (contentType.includes("application/json")) {
      // Version A: Apple already transcribed it (Shortcut dictation) -> free, no OpenAI
      const raw = await req.text();
      if (raw.length > MAX_BODY_BYTES) return json({ error: "body too large" }, 413);
      let body: { text?: unknown; recorded_at?: unknown };
      try {
        body = JSON.parse(raw);
      } catch {
        return fail("bad_request", "body is not valid JSON");
      }
      transcript = String(body.text ?? "").trim();
      if (typeof body.recorded_at === "string" && body.recorded_at) recordedAt = body.recorded_at;
    } else {
      // Version B: raw audio from the watch app
      if (!TRANSCRIBE_KEY) return fail("no_transcriber", "no GROQ_API_KEY / OPENAI_API_KEY set; audio notes need one");
      if (!TRANSCRIBE_KEY_OK) {
        return fail("bad_transcriber_key", `transcription key has ${TRANSCRIBE_KEY.length} chars incl. non-ASCII ones; re-paste the secret`);
      }
      const audio = new Uint8Array(await req.arrayBuffer());
      if (audio.byteLength === 0) return fail("empty", "empty body");
      if (audio.byteLength > MAX_AUDIO_BYTES) {
        return fail("too_long", `audio is ${Math.round(audio.byteLength / 1e6)} MB, max 25 MB (~45 min)`);
      }
      recordedAt = req.headers.get("x-recorded-at") ?? recordedAt;
      audioPath = `${crypto.randomUUID()}.m4a`;

      const { error: uploadError } = await supabase.storage
        .from("recordings")
        .upload(audioPath, audio, { contentType });
      if (uploadError) throw new PocketError("internal", `storage: ${uploadError.message}`);

      transcript = await transcribe(audio, contentType);
    }

    if (!transcript) return fail("empty", "no speech detected");
    if (transcript.length > MAX_TEXT_CHARS) {
      const id = await parkFailedNote(transcript, recordedAt, audioPath, "too_long");
      return fail("too_long", `transcript is ${transcript.length} chars, max ${MAX_TEXT_CHARS}`, { id });
    }

    // Daily cap, counted BEFORE the Claude call so a leaked key stops costing money at the cap.
    const { data: allowed, error: usageError } = await supabase.rpc("pocket_consume", {
      p_chars: transcript.length,
      p_max_calls: MAX_CALLS_PER_DAY,
      p_max_chars: MAX_CHARS_PER_DAY,
    });
    if (usageError) throw new PocketError("db", `usage: ${usageError.message}`);
    if (!allowed) {
      const id = await parkFailedNote(transcript, recordedAt, audioPath, "rate_limited");
      return fail("rate_limited", "daily cap reached", { id });
    }

    // recordedAt may carry the phone's own offset (new Shortcut), be UTC (old Shortcut / watch
    // app), or be absent -> server now. All three resolve to Israel local time here.
    let now: LocalContext;
    try {
      now = localContext(recordedAt, POCKET_TZ);
    } catch {
      recordedAt = new Date().toISOString();
      now = localContext(recordedAt, POCKET_TZ);
    }

    const { result, usage, latency_ms } = await structure(transcript, now);
    const cost_usd = costUsd(usage);
    const cost_agorot = Math.round(cost_usd * ILS_PER_USD * 100 * 1000) / 1000;

    const { data, error } = await supabase
      .from("notes")
      .insert({
        recorded_at: recordedAt,
        audio_path: audioPath,
        transcript,
        title: result.title,
        summary: result.summary,
        wrist: result.wrist,
        language: result.language,
        action_items: result.action_items,
        people: result.people,
        status: "ok",
        model: CLAUDE_MODEL,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost_usd,
        latency_ms,
      })
      .select("id")
      .single();
    if (error) throw new PocketError("db", `db: ${error.message}`);

    // Success shape: the original keys (id, transcript, title, summary, action_items, people) are
    // unchanged and there is no "error" key, so the old Shortcut keeps working. New keys are additive.
    return json({
      id: data.id,
      transcript,
      ...result,
      now_local: now.iso,
      tz: now.tz,
      model: CLAUDE_MODEL,
      transcriber: audioPath ? `${TRANSCRIBE_BASE_URL.includes("groq.com") ? "groq" : "openai"}/${TRANSCRIBE_MODEL}` : null,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cost_usd,
      cost_agorot,
      latency_ms,
    });
  } catch (err) {
    console.error(err);
    const code: ErrorCode = err instanceof PocketError ? err.code : "internal";
    const detail = err instanceof Error ? err.message : String(err);
    const id = await parkFailedNote(transcript, recordedAt, audioPath, code);
    return fail(code, detail, { id, transcript });
  }
});
