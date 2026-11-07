# Version A — Apple Watch Shortcut

Talk to the watch → backend structures it with Claude → note in Apple Notes + reminders for every task.
Cost: Apple dictation is free, Supabase free tier, Claude Haiku ≈ a fraction of a cent per note.
Secrets on the function: `ANTHROPIC_API_KEY` + `POCKET_SHARED_KEY`. Recording-based shortcuts (Pocket Meeting) also need `GROQ_API_KEY` (or `OPENAI_API_KEY`).
The Pocket Meeting and Pocket Notes Sync shortcuts are experimental: they have not been verified on a device yet.

## Build it

Generate the shortcuts from the repo and import them. The project ref and key come from `Secrets.xcconfig`, or pass `--project-ref`.

```bash
python3 shortcut/build_shortcut.py
for n in Pocket "Pocket Meeting" "Pocket Ask" "Pocket Notes Sync"; do shortcuts sign --mode anyone --input "shortcut/$n-unsigned.shortcut" --output "shortcut/$n.shortcut"; done
```

| Shortcut | Runs on | What it does |
|---|---|---|
| **Pocket** | watch + iPhone | dictate a short note → dated reminders + notification |
| **Pocket Meeting** | iPhone | Record Audio until you tap Stop → `ingest` transcribes (needs `GROQ_API_KEY` or `OPENAI_API_KEY`) → Apple Note with summary + transcript, dated reminders |
| **Pocket Ask** | watch + iPhone | dictate a question → `ask` answers from your last 90 days of notes |
| **Pocket Notes Sync** | iPhone | copies notes recorded on the watch into **Apple Notes** (one Apple Note per note: title, summary, tasks, transcript) |

Open `Pocket.shortcut` on the Mac or iPhone → Add Shortcut → replace `PASTE-POCKET-KEY-HERE` in the
`x-pocket-key` header with your key (or build with `--key "$POCKET_SHARED_KEY"`; never commit the output).
Rename it **Pocket**, turn on **Show on Apple Watch** (ⓘ).

What the generated shortcut does, in order:

1. **Dictate Text** (Hebrew, stop After Pause)
2. **Current Date → Format Date (ISO 8601 + time)** — so the server knows your local time and offset
3. **Get Contents of URL** — POST JSON `{text, recorded_at}` with header `x-pocket-key`
4. **If `error` has any value** (the function returns 200 with `error` + `message_he` on expected failures):
   reminder `Pocket (לא נשמר): <dictated text>` + notification with the Hebrew message
5. **Otherwise:** get `title`, `wrist`, `action_items`
   - for each item: get `task` and `due`; if `due` has a value → **Get Dates from Input** → **Add New Reminder**
     with an alert at that time; otherwise a plain reminder
   - **Show Notification** `title` / `wrist` (one line, ≤ 60 chars, fits the watch)

Start it from the watch: Shortcuts complication, Siri ("Pocket"), or the Action Button on an Ultra.

## Apple Notes sync

Apple has **no public API** for writing to Apple Notes (Apple DTS says so in the developer forums); the only route is the
Shortcuts action *Create Note* on the iPhone. So the watch app cannot write to Notes by itself. Instead:

- the server remembers which notes were already copied (`notes.synced_to_notes_at`);
- `POST /notes {"mode":"unsynced"}` returns the new ones, oldest first, each with a ready Hebrew `body`
  (first line = title, then summary, tasks, transcript, recording time);
- **Pocket Notes Sync** loops over them, runs *Create Note*, then `POST /notes {"ack_id": id}` so a note is never copied twice.

Set it up once on the iPhone (Shortcuts app):
1. Import `Pocket Notes Sync.shortcut`, paste the key in both `x-pocket-key` headers.
2. **Run it by hand once** after recording a note on the watch, and check that a new note appears in Notes.
3. Automate it: Automation tab → **+** → **App** → choose **Notes** → *Is Opened* → **Run Immediately** → action *Run Shortcut* → Pocket Notes Sync.
   Opening Notes then pulls everything recorded since. Optionally add a *Time of Day* automation (e.g. every evening).

UNVERIFIED on a device: the *Create Note* action's
parameter keys in the generated plist (`WFCreateNoteInput`, `ShowWhenRun`); if the action imports empty, rebuild it by hand
in the editor.

## Check before filming

- **Some actions may not run on the watch itself** (Create Note is the one to check). If it fails on the
  watch, keep steps 1–4 + 7–8 on the watch and let the note get created when the shortcut runs on iPhone,
  or swap Create Note for a reminder with the summary in its notes field.
- Dictation stops on silence — this version is for short notes (under ~1 min), not whole meetings. That's version B.
- Test the backend first with curl:

```bash
curl -X POST https://YOUR-PROJECT-REF.supabase.co/functions/v1/ingest \
  -H "x-pocket-key: YOUR_POCKET_SHARED_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"Call Kim tomorrow about the Q1 budget, and send Morgan the booking engine spec by Friday"}'
```

## Keep costs capped

Two layers:
1. **Server-side (automatic):** the function counts calls per UTC day in the `usage` table and answers
   `code: rate_limited` after 150 notes / 300k chars. One note is capped at 4,000 chars.
   Override with secrets `MAX_CALLS_PER_DAY`, `MAX_CHARS_PER_DAY`, `MAX_TEXT_CHARS`.
2. **Anthropic Console → Limits → monthly spend limit** (e.g. $5) as the backstop.

Every response (and every row in `notes`) carries `input_tokens`, `output_tokens`, `cost_usd`,
`cost_agorot`, `latency_ms`. A Hebrew note with three tasks costs about 0.13 agorot.

## Ask (`/functions/v1/ask`)

POST `{question, recorded_at?}` → `{answer (≤300 chars), confidence, note_ids, notes_searched}`. Loads up to 200 notes
from the last 90 days (status ok), transcripts capped at 600 chars each, one Haiku call (~3.7k input tokens, ~0.1 agorot).
No pgvector yet; that is the upgrade once there are thousands of notes.

## Response contract

- `200` + `{title, summary, wrist, language, action_items[{task, owner, due, due_text}], people, now_local, cost_agorot, ...}` on success.
  `due` is ISO-8601 with the Israel offset (`2026-11-08T19:00:00+02:00`), resolved from `recorded_at`
  with Hebrew rules (week starts Sunday, "חמישי הקרוב" is strictly after today, "בערב" = 19:00, day-only = 09:00).
- `200` + `{error, code, message_he}` on expected failures (`empty`, `too_long`, `rate_limited`, `upstream`,
  `bad_model_output`, `db`). The dictated text is parked in `notes` with `status = 'failed'`.
- `401` only for a wrong key.
