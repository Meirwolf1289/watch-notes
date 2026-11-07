# Watch Notes: voice notes with summary and tasks on your Apple Watch

> Step-by-step guide in Hebrew: [docs/GUIDE.md](docs/GUIDE.md)

Tap the watch → talk → get a title, summary and action items back on your wrist.

```
Apple Watch (SwiftUI)  ──m4a──▶  Supabase Edge Function "ingest"
                                   ├─ Storage: recordings/
                                   ├─ Groq / OpenAI transcription (Whisper)
                                   ├─ Claude → JSON (title, summary, todos, people)
                                   └─ Postgres: notes
                       ◀──JSON──
```

## 1. Backend (Supabase) — ~30 min

```bash
supabase link --project-ref YOUR-PROJECT-REF
supabase db push                                   # applies every file in supabase/migrations/

supabase secrets set POCKET_SHARED_KEY="$(openssl rand -hex 24)"   # note the value; the watch app needs it too
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set GROQ_API_KEY=gsk_...   # transcription (whisper-large-v3, free tier). Or OPENAI_API_KEY.

supabase functions deploy ingest --no-verify-jwt
supabase functions deploy notes --no-verify-jwt
supabase functions deploy ask --no-verify-jwt
```

Test it from your Mac before touching Xcode (record any short m4a with Voice Memos):

```bash
curl -X POST https://YOUR-PROJECT-REF.supabase.co/functions/v1/ingest \
  -H "x-pocket-key: YOUR_POCKET_SHARED_KEY" \
  -H "Content-Type: audio/m4a" \
  --data-binary @test.m4a
```

You should get back JSON with `title`, `summary`, `action_items`.

## 2. Watch app (Xcode) — ~30 min

The Xcode project is generated, not committed. Three screens: Record · Notes · Ask (swipe sideways).

```bash
brew install xcodegen                      # once
cp Secrets.example.xcconfig Secrets.xcconfig
# edit Secrets.xcconfig: POCKET_SHARED_KEY, POCKET_TEAM_ID (Apple Team ID), POCKET_PROJECT_REF (the part before .supabase.co)
xcodegen generate
open PocketWatch.xcodeproj
```

Build for the simulator from the terminal (no signing needed):

```bash
xcodebuild -project PocketWatch.xcodeproj -scheme PocketWatch -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)' -derivedDataPath build build CODE_SIGNING_ALLOWED=NO
```

On a real watch (one command once the iPhone is connected by a data cable and the watch shows up in Xcode):

```bash
scripts/install_watch.sh
```

By hand:
1. In Xcode → target PocketWatch → Signing & Capabilities → pick your Team (or set `POCKET_TEAM_ID` and regenerate).
   Free account = app expires after 7 days; fine for filming.
2. On the watch: Settings → Privacy & Security → **Developer Mode** on. Pair the watch in Xcode (Window → Devices and Simulators).
   This step is usually the annoying one — budget time.
3. Run on the watch. Recording needs `GROQ_API_KEY` (or `OPENAI_API_KEY`) set on the Supabase project; Notes and Ask work without it.

## 3. Known limits / next steps

- **Screen-off recording**: v1 records while the app is in front. For longer meetings, add the Background Modes → Audio capability and test whether recording survives wrist-down; if not, look at `WKExtendedRuntimeSession`.
- **Upload path**: the watch uploads directly (via iPhone, Wi-Fi or LTE). Long recordings over Bluetooth are slow — test with 1–5 min notes first.
- **Transcription file limit**: 25 MB ≈ 45+ min at these settings.
- **Edge Function timeout**: very long recordings may exceed it; then split into "upload" and "process" steps.
- **Episode 2 ideas**: "Ask your memory" (pgvector over `notes.transcript`), auto-create reminders from `action_items`, a complication / Action Button shortcut to start recording.

## Files

```
supabase/migrations/                   notes table, daily-cap table, private "recordings" bucket
supabase/functions/ingest/index.ts     text or audio -> transcript -> Claude -> saved note
supabase/functions/ask/index.ts        "ask your notes" over the last 90 days
supabase/functions/notes/index.ts      list, one note with transcript, Apple Notes sync feed
supabase/functions/transcribe/index.ts word timestamps (used by reel/edit.py)
PocketWatch/                           the watchOS app (record, notes, ask, offline queue)
project.yml                            xcodegen spec (the .xcodeproj is generated)
scripts/install_watch.sh               build + install on a connected Apple Watch
shortcut/build_shortcut.py             optional Apple Shortcuts versions
reel/edit.py                           optional video editor with Hebrew captions
docs/GUIDE.md                          step-by-step guide (Hebrew)
```
