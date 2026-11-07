// Pocket Watch "ask your memory"
// POST JSON {question, recorded_at?} -> load recent notes -> Claude answers from them -> JSON
//
// Secrets: ANTHROPIC_API_KEY, POCKET_SHARED_KEY (same as ingest). Optional: CLAUDE_MODEL, POCKET_TZ,
// ASK_MAX_NOTES (default 200), ASK_MAX_DAYS (default 90).
//
// Status contract: 401 bad key, 405 not POST, otherwise 200. Expected failures come back as
// { error, code, message_he } so the Shortcut can show them (same as ingest).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { DEFAULT_TZ, localContext } from "./dates.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
// Fail closed: with no secret (or a short one) every request is rejected instead of an empty header matching.
const POCKET_KEY = Deno.env.get("POCKET_SHARED_KEY") ?? "";
const CLAUDE_MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-haiku-5-5";
const POCKET_TZ = Deno.env.get("POCKET_TZ") ?? DEFAULT_TZ;
const ASK_MAX_NOTES = Number(Deno.env.get("ASK_MAX_NOTES") ?? 200);
const ASK_MAX_DAYS = Number(Deno.env.get("ASK_MAX_DAYS") ?? 90);
const ASK_MAX_QUESTION_CHARS = 1000;
const CLAUDE_TIMEOUT_MS = 20_000;
const ANSWER_MAX = 300;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

type NoteRow = {
  id: string;
  recorded_at: string | null;
  created_at: string;
  title: string | null;
  summary: string | null;
  action_items: { task: string; owner: string | null; due: string | null; due_text: string | null }[];
  people: string[];
  transcript: string;
};

type ErrorCode = "empty" | "no_notes" | "upstream" | "bad_model_output" | "db" | "bad_request" | "internal";
const MESSAGE_HE: Record<ErrorCode, string> = {
  empty: "לא נקלטה שאלה. נסה שוב.",
  no_notes: "עוד אין הערות בזיכרון.",
  upstream: "Claude לא זמין כרגע. נסה שוב.",
  bad_model_output: "התשובה מהמודל לא תקינה.",
  db: "הקריאה ממסד הנתונים נכשלה.",
  bad_request: "הבקשה לא תקינה.",
  internal: "שגיאה פנימית.",
};

class PocketError extends Error {
  constructor(readonly code: ErrorCode, detail: string) {
    super(detail);
  }
}

type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type ContentBlock = ToolUseBlock | { type: string };
type MessagesResponse = {
  stop_reason: string;
  content: ContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
};

const ANSWER_TOOL = {
  name: "answer",
  description: "Answer the user's question from their notes.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer", "note_ids", "confidence"],
    properties: {
      answer: {
        type: "string",
        description:
          `Direct answer, max ${ANSWER_MAX} characters, same language as the question. Lead with the fact, ` +
          "then when it was said (e.g. 'אמרת ביום שלישי ש...'). If the notes do not contain it, say so in one short sentence.",
      },
      note_ids: { type: "array", items: { type: "string" }, description: "ids of the notes the answer is based on." },
      confidence: { type: "string", enum: ["high", "medium", "low", "none"] },
    },
  },
} as const;

const SYSTEM_PROMPT = `You are the user's memory. You get their voice notes (newest first, each with an id, local date,
title, summary, open tasks, people, and the transcript) and one question. Answer ONLY from the notes.
Match Hebrew name variants loosely (דני/דניאל, מיכל/מיכאל are different people; דני/דנ' are the same).
"What is open with X" = tasks mentioning X or owned by X. "When did I say..." = quote the date of the note.
Never invent facts. If nothing matches, say so briefly. Call the answer tool exactly once.`;

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
function isToolUse(b: ContentBlock): b is ToolUseBlock {
  return b.type === "tool_use";
}

function renderNotes(notes: NoteRow[]): string {
  return notes.map((n) => {
    const when = localContext(n.recorded_at ?? n.created_at, POCKET_TZ);
    const tasks = (n.action_items ?? []).map((t) =>
      `  - ${t.task}${t.owner ? ` (${t.owner})` : ""}${t.due_text ? ` [${t.due_text}]` : t.due ? ` [${t.due}]` : ""}`
    ).join("\n");
    // Transcript is capped per note so 200 notes stay inside a cheap context.
    const transcript = n.transcript.length > 600 ? n.transcript.slice(0, 600) + "…" : n.transcript;
    return `### id: ${n.id}\ndate: ${when.hebrew} (${when.weekday})\ntitle: ${n.title ?? ""}\nsummary: ${n.summary ?? ""}\n` +
      `tasks:\n${tasks || "  (none)"}\npeople: ${(n.people ?? []).join(", ") || "(none)"}\ntranscript: ${transcript}`;
  }).join("\n\n");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (POCKET_KEY.length < 16 || !safeEqual(req.headers.get("x-pocket-key") ?? "", POCKET_KEY)) return json({ error: "unauthorized" }, 401);

  try {
    let body: { question?: unknown; recorded_at?: unknown };
    try {
      body = await req.json();
    } catch {
      return fail("bad_request", "body is not valid JSON");
    }
    const question = String(body.question ?? "").trim().slice(0, ASK_MAX_QUESTION_CHARS);
    if (!question) return fail("empty", "no question");
    const askedAt = typeof body.recorded_at === "string" && body.recorded_at ? body.recorded_at : new Date().toISOString();
    let now;
    try {
      now = localContext(askedAt, POCKET_TZ);
    } catch {
      now = localContext(new Date().toISOString(), POCKET_TZ);
    }

    const since = new Date(Date.now() - ASK_MAX_DAYS * 86_400_000).toISOString();
    const { data: notes, error } = await supabase
      .from("notes")
      .select("id, recorded_at, created_at, title, summary, action_items, people, transcript")
      .eq("status", "ok")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(ASK_MAX_NOTES);
    if (error) throw new PocketError("db", error.message);
    if (!notes || notes.length === 0) return fail("no_notes", "no notes yet");

    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        signal: AbortSignal.timeout(CLAUDE_TIMEOUT_MS),
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 512,
          system: SYSTEM_PROMPT,
          tools: [ANSWER_TOOL],
          tool_choice: { type: "tool", name: ANSWER_TOOL.name },
          messages: [{
            role: "user",
            content: `now_local: ${now.iso} (${now.weekday}; ${now.hebrew})\n\n## notes (${notes.length}, newest first)\n\n` +
              `${renderNotes(notes as NoteRow[])}\n\n## question\n${question}`,
          }],
        }),
      });
    } catch (e) {
      throw new PocketError("upstream", `claude unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new PocketError("upstream", `claude ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json() as MessagesResponse;
    const toolUse = data.content.find(isToolUse);
    if (!toolUse || !toolUse.input || typeof toolUse.input !== "object") {
      throw new PocketError("bad_model_output", "no answer tool call");
    }
    const out = toolUse.input as { answer?: unknown; note_ids?: unknown; confidence?: unknown };
    const answer = Array.from(String(out.answer ?? "").trim()).slice(0, ANSWER_MAX).join("");
    if (!answer) throw new PocketError("bad_model_output", "empty answer");

    return json({
      question,
      answer,
      confidence: typeof out.confidence === "string" ? out.confidence : "low",
      note_ids: Array.isArray(out.note_ids) ? out.note_ids.map(String) : [],
      notes_searched: notes.length,
      input_tokens: data.usage?.input_tokens ?? 0,
      output_tokens: data.usage?.output_tokens ?? 0,
      latency_ms: Math.round(performance.now() - t0),
    });
  } catch (err) {
    console.error(err);
    const code: ErrorCode = err instanceof PocketError ? err.code : "internal";
    return fail(code, err instanceof Error ? err.message : String(err));
  }
});
