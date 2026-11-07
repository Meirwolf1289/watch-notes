#!/usr/bin/env python3
"""Reel editor: a talking-head video in, a tight captioned 9:16 Reel out.

    python3 reel/edit.py my_take.mov -o reel.mp4            # edit
    python3 reel/edit.py my_take.mov --plan-only            # just show what would be cut

What it does (all free; speech goes to the Pocket backend's Groq Whisper, nothing else leaves the Mac):
  1. transcribes the audio with a timestamp for every word (Hebrew, English names are fine);
  2. cuts "אה/אמ/um" filler words, stutters and restarted phrases (keeps the LAST take), and shrinks
     dead pauses to a natural beat;
  3. cleans the audio (light denoise + loudness to -16 LUFS, the Instagram level);
  4. burns in Hebrew captions, word-by-word highlight, placed above Instagram's UI;
  5. crops to 1080x1920.
Every decision is written to <out>.plan.json so you can see exactly what was removed.

Not done here (step 2 of the roadmap): background replacement. Film in front of a clean wall for now.

Needs: ffmpeg, Pillow, and POCKET_SHARED_KEY (env var, or Secrets.xcconfig in the repo root).
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
import urllib.error
import urllib.request

def project_ref():
    """Supabase project ref: env POCKET_PROJECT_REF, else POCKET_PROJECT_REF in Secrets.xcconfig."""
    ref = os.environ.get("POCKET_PROJECT_REF", "").strip()
    if ref:
        return ref
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        for line in open(os.path.join(root, "Secrets.xcconfig")):
            m = re.match(r"\s*POCKET_PROJECT_REF\s*=\s*(\S+)", line)
            if m and m.group(1) != "YOUR-PROJECT-REF":
                return m.group(1)
    except OSError:
        pass
    sys.exit("No project ref: set POCKET_PROJECT_REF or fill Secrets.xcconfig")


def base_url():
    return f"https://{project_ref()}.supabase.co/functions/v1"

# Filler tokens (normalised). Real words that merely look like fillers ("נו") are NOT listed.
FILLERS = {
    "אה", "אהה", "אההה", "אהההה", "אמ", "אממ", "אמממ", "אמם", "אממם", "הממ", "המם", "הממם", "אההם",
    "um", "umm", "uh", "uhh", "uhm", "erm", "hmm", "mm", "mmm",
}

W_OUT, H_OUT = 1080, 1920
BAND_H = 380          # height of the caption layer
BAND_Y = 1200         # where the band sits (centre of text ~ 71% down, above Instagram's bottom UI)
CAPTION_FPS = 20


# ----------------------------------------------------------------------------- planning (pure)

def norm(word: str) -> str:
    """Lowercase, strip punctuation, niqqud and trailing noise so 'אה,' == 'אה'."""
    word = unicodedata.normalize("NFKD", word)
    word = "".join(c for c in word if not unicodedata.combining(c))
    return re.sub(r"[^\w]", "", word.lower())


def plan(words, duration, max_pause=0.35, pad=0.09, head=0.12, tail=0.30, drop_fillers=True):
    """Decide what to keep. Returns dict(kept, removed, segments, original, saved).

    segments are [start, end] pairs in source seconds, already padded, ordered, non-overlapping.
    """
    toks = [dict(w, n=norm(w["word"]), cut=None) for w in words]
    if drop_fillers:
        for t in toks:
            if t["n"] in FILLERS:
                t["cut"] = "filler"

    # Repeats / restarts: if an n-gram is immediately repeated, the first copy is a false start.
    live = [t for t in toks if not t["cut"]]
    for i in range(len(live)):
        if live[i]["cut"]:
            continue
        for n in range(6, 0, -1):
            a, b = live[i:i + n], live[i + n:i + 2 * n]
            if len(a) < n or len(b) < n or any(x["cut"] for x in a):
                continue
            if [x["n"] for x in a] == [x["n"] for x in b] and (n > 1 or len(a[0]["n"]) > 1):
                for x in a:
                    x["cut"] = "repeat"
                break

    # Build segments of consecutive kept words. A segment next to a removed word records a limit so the
    # padding below can never reach into the removed word (that leaked a sliver of the "אה" into the cut).
    segs, cur, prev = [], None, None
    removed_between, first_removed_start, last_removed_end = False, None, None
    for t in toks:
        if t["cut"]:
            if not removed_between:
                first_removed_start = t["start"]
            last_removed_end = t["end"]
            removed_between = True
            continue
        if cur is None:
            cur = {"s": t["start"], "e": t["end"], "lo": last_removed_end if removed_between else None, "hi": None}
        elif removed_between or t["start"] - prev["end"] > max_pause:
            cur["hi"] = first_removed_start if removed_between else None
            segs.append(cur)
            cur = {"s": t["start"], "e": t["end"], "lo": last_removed_end if removed_between else None, "hi": None}
        else:
            cur["e"] = t["end"]
        prev, removed_between = t, False
    if cur:
        cur["hi"] = first_removed_start if removed_between else None
        segs.append(cur)

    if not segs:
        segs = [[0.0, duration]]
    else:
        padded = []
        for i, g in enumerate(segs):
            s_ = max(0.0, g["s"] - (head if i == 0 else pad))
            e_ = min(duration, g["e"] + (tail if i == len(segs) - 1 else pad))
            if g["lo"] is not None:
                s_ = max(s_, min(g["lo"], g["s"]))      # never start inside the removed word before us
            if g["hi"] is not None:
                e_ = min(e_, max(g["hi"], g["e"]))      # never end inside the removed word after us
            if padded and s_ <= padded[-1][1]:       # padding closed the cut: no cut at all
                padded[-1][1] = max(padded[-1][1], e_)
            else:
                padded.append([s_, e_])
        segs = padded

    saved_len = sum(e - s for s, e in segs)
    return {
        "kept": [{k: v for k, v in t.items() if k not in ("n", "cut")} for t in toks if not t["cut"]],
        "removed": [{"word": t["word"], "start": t["start"], "end": t["end"], "why": t["cut"]} for t in toks if t["cut"]],
        "segments": segs,
        "original": duration,
        "saved": saved_len,
    }


def remap(words, segments):
    """Move source-time words onto the cut timeline. Words outside every segment are dropped."""
    out, offset = [], 0.0
    starts = []
    for s, e in segments:
        starts.append(offset)
        offset += e - s
    for w in words:
        for (s, e), o in zip(segments, starts):
            if s - 1e-3 <= w["start"] <= e + 1e-3:
                out.append({**w, "start": o + max(0.0, w["start"] - s), "end": o + min(w["end"], e + 0.2) - s})
                break
    return out


# ----------------------------------------------------------------------------- captions (pure + PIL)

def _cls(ch):
    b = unicodedata.bidirectional(ch)
    if b in ("R", "AL"):
        return "R"
    if b in ("L", "EN", "AN"):
        return "L"
    return "N"


def visual_word(word: str) -> str:
    """One word, logical order -> the string to draw left-to-right with no shaping engine (RTL base).
    Hebrew runs are reversed, Latin/digit runs keep their order, runs are laid out right-to-left."""
    classes = [_cls(c) for c in word]
    for i, c in enumerate(classes):             # neutrals join L only when squeezed between two L chars
        if c == "N":
            left = next((classes[j] for j in range(i - 1, -1, -1) if classes[j] != "N"), None)
            right = next((classes[j] for j in range(i + 1, len(classes)) if classes[j] != "N"), None)
            classes[i] = "L" if left == "L" and right == "L" else "R"
    runs = []
    for ch, c in zip(word, classes):
        if runs and runs[-1][0] == c:
            runs[-1][1] += ch
        else:
            runs.append([c, ch])
    return "".join(r[1] if r[0] == "L" else r[1][::-1] for r in reversed(runs))


def visual_line(words):
    """Words of one caption line (logical order) -> visual left-to-right order, each already shaped."""
    return [visual_word(w) for w in reversed(words)]


def group_lines(words, max_words=4, max_chars=24, max_gap=0.6):
    lines, cur = [], []
    for w in words:
        if cur and (len(cur) >= max_words
                    or sum(len(x["word"]) for x in cur) + len(w["word"]) > max_chars
                    or w["start"] - cur[-1]["end"] > max_gap):
            lines.append(cur)
            cur = []
        cur.append(w)
        if re.search(r"[.?!…]$", w["word"]):
            lines.append(cur)
            cur = []
    if cur:
        lines.append(cur)
    return lines


def caption_states(words):
    """[(start, end, line_index, active_word_index)] on the output timeline."""
    lines = group_lines(words)
    states = []
    for li, line in enumerate(lines):
        line_end = line[-1]["end"] + 0.15
        if li + 1 < len(lines):
            line_end = min(line_end, lines[li + 1][0]["start"])
        for wi, w in enumerate(line):
            end = line[wi + 1]["start"] if wi + 1 < len(line) else line_end
            states.append((w["start"], max(end, w["start"] + 0.05), li, wi))
    return lines, states


FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/ArialHB.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]


def render_band(line, active, font_path):
    """One RGBA frame of the caption layer, as raw bytes."""
    from PIL import Image, ImageDraw, ImageFont
    size = 96
    parts = visual_line([w["word"] for w in line])
    while True:
        font = ImageFont.truetype(font_path, size)
        space = font.getlength(" ")
        widths = [font.getlength(p) for p in parts]
        total = sum(widths) + space * (len(parts) - 1)
        if total <= W_OUT - 100 or size <= 40:
            break
        size -= 4
    img = Image.new("RGBA", (W_OUT, BAND_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    x = (W_OUT - total) / 2
    y = (BAND_H - size) / 2 - size * 0.12
    active_visual = len(line) - 1 - active                  # visual index of the active (logical) word
    for i, (p, w) in enumerate(zip(parts, widths)):
        fill = (255, 214, 0, 255) if i == active_visual else (255, 255, 255, 255)
        draw.text((x, y), p, font=font, fill=fill, stroke_width=max(6, size // 12), stroke_fill=(0, 0, 0, 255))
        x += w + space
    return img.tobytes()


# ----------------------------------------------------------------------------- I/O

def pocket_key():
    key = os.environ.get("POCKET_SHARED_KEY", "").strip()
    if key:
        return key
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        for line in open(os.path.join(root, "Secrets.xcconfig")):
            m = re.match(r"\s*POCKET_SHARED_KEY\s*=\s*(\S+)", line)
            if m and m.group(1) != "paste-your-key":
                return m.group(1)
    except OSError:
        pass
    sys.exit("No key: set POCKET_SHARED_KEY or fill Secrets.xcconfig")


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, **kw)


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height,duration",
         "-show_entries", "format=duration", "-of", "json", path],
        check=True, capture_output=True, text=True).stdout
    info = json.loads(out)
    kinds = [s["codec_type"] for s in info["streams"]]
    return float(info["format"]["duration"]), "audio" in kinds


def transcribe(audio_path, language):
    url = f"{base_url()}/transcribe" + (f"?language={language}" if language else "")
    req = urllib.request.Request(url, data=open(audio_path, "rb").read(), method="POST",
                                 headers={"x-pocket-key": pocket_key(), "Content-Type": "audio/mp4"})
    try:
        data = json.load(urllib.request.urlopen(req, timeout=300))
    except urllib.error.HTTPError as e:
        sys.exit(f"transcribe failed: HTTP {e.code}")
    if "error" in data:
        sys.exit(f"transcribe failed: {data.get('message_he') or data['error']}")
    return data["words"]


def build_graph(segments, caption_y):
    lines, ends = [], []
    for i, (s, e) in enumerate(segments):
        d = e - s
        fade = min(0.015, d / 4)
        lines.append(f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[v{i}];")
        lines.append(f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS,"
                     f"afade=t=in:st=0:d={fade:.3f},afade=t=out:st={d - fade:.3f}:d={fade:.3f}[a{i}];")
        ends.append(f"[v{i}][a{i}]")
    n = len(segments)
    lines.append(f"{''.join(ends)}concat=n={n}:v=1:a=1[vc][ac];")
    lines.append(f"[vc]fps=30,scale={W_OUT}:{H_OUT}:force_original_aspect_ratio=increase,crop={W_OUT}:{H_OUT},setsar=1[vb];")
    lines.append(f"[vb][1:v]overlay=0:{caption_y}:eof_action=repeat,format=yuv420p[vo];")
    lines.append("[ac]afftdn=nf=-30,loudnorm=I=-16:TP=-1.5:LRA=11[ao]")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("-o", "--out")
    ap.add_argument("--language", default="he", help="speech language hint, '' to auto-detect (default he)")
    ap.add_argument("--max-pause", type=float, default=0.35, help="pauses longer than this are cut (seconds)")
    ap.add_argument("--keep-fillers", action="store_true")
    ap.add_argument("--no-captions", action="store_true")
    ap.add_argument("--plan-only", action="store_true", help="transcribe and print the cut list, render nothing")
    args = ap.parse_args()

    duration, has_audio = probe(args.video)
    if not has_audio:
        sys.exit("The video has no audio track.")
    out = args.out or os.path.splitext(args.video)[0] + "_reel.mp4"

    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "speech.m4a")
        print("1/4 extracting audio…", file=sys.stderr)
        run(["ffmpeg", "-y", "-v", "error", "-i", args.video, "-vn", "-ac", "1", "-ar", "16000",
             "-c:a", "aac", "-b:a", "48k", wav])
        print("2/4 transcribing (word timestamps)…", file=sys.stderr)
        words = transcribe(wav, args.language)
        if not words:
            sys.exit("No speech detected.")

        p = plan(words, duration, max_pause=args.max_pause, drop_fillers=not args.keep_fillers)
        report = {
            "source_seconds": round(duration, 2), "output_seconds": round(p["saved"], 2),
            "removed_words": p["removed"], "cuts": len(p["segments"]) - 1,
            "segments": [[round(s, 2), round(e, 2)] for s, e in p["segments"]],
            "transcript_kept": " ".join(w["word"] for w in p["kept"]),
        }
        with open(os.path.splitext(out)[0] + ".plan.json", "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
        print(f"   {duration:.1f}s -> {p['saved']:.1f}s | {len(p['removed'])} words removed | "
              f"{len(p['segments']) - 1} cuts", file=sys.stderr)
        for r in p["removed"]:
            print(f"   - {r['why']:7} {r['start']:6.2f}s  {r['word']}", file=sys.stderr)
        if args.plan_only:
            return

        total = p["saved"]
        graph_path = os.path.join(tmp, "graph.txt")
        open(graph_path, "w").write(build_graph(p["segments"], BAND_Y))
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", args.video,
               "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{W_OUT}x{BAND_H}", "-framerate", str(CAPTION_FPS), "-i", "-",
               "-filter_complex_script", graph_path, "-map", "[vo]", "-map", "[ao]",
               "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "160k",
               "-movflags", "+faststart", "-t", f"{total:.3f}", out]

        print("3/4 captions + render…", file=sys.stderr)
        font_path = next((f for f in FONT_CANDIDATES if os.path.exists(f)), None)
        if not font_path and not args.no_captions:
            sys.exit("No Hebrew-capable font found; pass --no-captions or install Arial Unicode.")
        lines, states = ([], []) if args.no_captions else caption_states(remap(p["kept"], p["segments"]))
        empty = bytes(W_OUT * BAND_H * 4)
        cache = {}
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        try:
            idx = 0
            for frame in range(int(total * CAPTION_FPS) + 2):
                t = frame / CAPTION_FPS
                while idx < len(states) and states[idx][1] <= t:
                    idx += 1
                if idx < len(states) and states[idx][0] <= t:
                    _, _, li, wi = states[idx]
                    if (li, wi) not in cache:
                        cache[(li, wi)] = render_band(lines[li], wi, font_path)
                    proc.stdin.write(cache[(li, wi)])
                else:
                    proc.stdin.write(empty)
            proc.stdin.close()
        except BrokenPipeError:
            pass
        if proc.wait() != 0:
            sys.exit("ffmpeg failed")
    print(f"4/4 done -> {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
