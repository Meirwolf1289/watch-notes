// Pocket Watch: notes for the watch app's list screen AND for the "Pocket Notes Sync" iPhone shortcut.
//
// POST {}                          -> { notes: [...] }  last N notes, newest first (watch list, no transcript)
// POST { id: "<uuid>" }            -> { note: {..., transcript} }  one full note (for the watch's Share button)
// POST { mode: "unsynced" }        -> { notes: [{ id, body, ... }] }  notes not yet copied to Apple Notes,
//                                     oldest first; `body` is plain text ready for Shortcuts' "Create Note"
// POST { ack_id: "<uuid>" }        -> { ok: true }  marks one note as copied (call after Create Note succeeds)
//
// Auth: x-pocket-key (401 on a bad key). Everything else is 200, failures as { error, code, message_he }.
// There is no public API to write to Apple Notes (Apple DTS says so); the shortcut is the only route.

import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
// Fail closed: with no secret (or a short one) every request is rejected instead of an empty header matching.
const POCKET_KEY = Deno.env.get("POCKET_SHARED_KEY") ?? "";
const MAX_LIMIT = 50;
const UNSYNCED_BATCH = 20;
const TZ = Deno.env.get("POCKET_TZ") ?? "Asia/Jerusalem";
const ILS_PER_USD = Number(Deno.env.get("ILS_PER_USD") ?? 3.16);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = "id, recorded_at, created_at, title, summary, wrist, action_items, people, cost_usd";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function dbError(message: string): Response {
  return json({ error: message, code: "db", message_he: "הקריאה ממסד הנתונים נכשלה." });
}
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  let diff = ab.byteLength ^ bb.byteLength;
  for (let i = 0; i < Math.max(ab.byteLength, bb.byteLength); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

type Row = {
  id: string; recorded_at: string | null; created_at: string; title: string | null; summary: string | null;
  wrist: string | null; action_items: { task: string; owner?: string | null; due_text?: string | null }[] | null;
  people: string[] | null; cost_usd: number | string | null; transcript?: string | null;
};

/** Plain text for Apple Notes. The first line becomes the note's title there. */
function formatBody(n: Row): string {
  const when = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, dateStyle: "full", timeStyle: "short" })
    .format(new Date(n.recorded_at ?? n.created_at));
  const tasks = (n.action_items ?? []).map((t) => `• ${t.task}${t.due_text ? ` (${t.due_text})` : ""}`);
  const parts = [n.title?.trim() || "הערה", n.summary?.trim() ?? ""];
  if (tasks.length) parts.push(`משימות:\n${tasks.join("\n")}`);
  if (n.transcript?.trim()) parts.push(`תמלול:\n${n.transcript.trim()}`);
  parts.push(`הוקלט: ${when}`);
  return parts.filter(Boolean).join("\n\n");
}

function toJson(n: Row, opts: { body?: boolean; transcript?: boolean } = {}) {
  return {
    id: n.id,
    recorded_at: n.recorded_at ?? n.created_at,
    title: n.title ?? "",
    summary: n.summary ?? "",
    wrist: n.wrist,
    action_items: n.action_items ?? [],
    people: n.people ?? [],
    cost_agorot: n.cost_usd == null ? null : Math.round(Number(n.cost_usd) * ILS_PER_USD * 100 * 1000) / 1000,
    ...(opts.transcript ? { transcript: n.transcript ?? "" } : {}),
    ...(opts.body ? { body: formatBody(n) } : {}),
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (POCKET_KEY.length < 16 || !safeEqual(req.headers.get("x-pocket-key") ?? "", POCKET_KEY)) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({})) as { limit?: unknown; mode?: unknown; ack_id?: unknown; id?: unknown };

  // Mark one note as copied to Apple Notes.
  if (typeof body.ack_id === "string") {
    if (!UUID.test(body.ack_id)) return json({ error: "bad id", code: "bad_request", message_he: "מזהה לא תקין." });
    const { error } = await supabase.from("notes")
      .update({ synced_to_notes_at: new Date().toISOString() })
      .eq("id", body.ack_id).is("synced_to_notes_at", null);
    return error ? dbError(error.message) : json({ ok: true });
  }

  // One full note, including the transcript (the watch's Share button).
  if (typeof body.id === "string") {
    if (!UUID.test(body.id)) return json({ error: "bad id", code: "bad_request", message_he: "מזהה לא תקין." });
    const { data, error } = await supabase.from("notes")
      .select(`${COLUMNS}, transcript`).eq("id", body.id).eq("status", "ok").maybeSingle();
    if (error) return dbError(error.message);
    if (!data) return json({ error: "not found", code: "not_found", message_he: "ההערה לא נמצאה." });
    return json({ note: toJson(data as unknown as Row, { transcript: true }) });
  }

  const unsynced = body.mode === "unsynced";
  let limit = unsynced ? UNSYNCED_BATCH : 20;
  if (!unsynced && typeof body.limit === "number") limit = Math.min(Math.max(1, Math.floor(body.limit)), MAX_LIMIT);

  let query = supabase
    .from("notes")
    .select(COLUMNS + (unsynced ? ", transcript" : ""))
    .eq("status", "ok")
    .order("created_at", { ascending: unsynced })
    .limit(limit);
  if (unsynced) query = query.is("synced_to_notes_at", null);

  const { data, error } = await query;
  if (error) return dbError(error.message);

  const rows = (data ?? []) as unknown as Row[];
  return json({ notes: rows.map((n) => toJson(n, { body: unsynced })) });
});
