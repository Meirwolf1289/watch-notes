"""Build the Pocket shortcuts as plists, then sign them with `shortcuts sign`.

    python3 shortcut/build_shortcut.py [--key "$POCKET_SHARED_KEY"] [--outdir shortcut]
    for n in Pocket "Pocket Meeting" "Pocket Ask" "Pocket Notes Sync"; do
      shortcuts sign --mode anyone --input "shortcut/$n-unsigned.shortcut" --output "shortcut/$n.shortcut"
    done

Three shortcuts:
  Pocket          watch + iPhone: dictate a short note -> dated reminders + notification
  Pocket Meeting  iPhone: record a whole conversation -> transcribe -> note in Apple Notes + reminders
  Pocket Ask      watch + iPhone: dictate a question -> answer from your notes
  Pocket Notes Sync  iPhone: copy new watch notes into Apple Notes (run it from an automation, see SHORTCUT.md)

Without --key the header holds a placeholder you replace in the Shortcuts editor.
Never commit a built .shortcut (they are git-ignored).
"""
import argparse
import os
import plistlib
import re
import uuid

BASE = "https://YOUR-PROJECT-REF.supabase.co/functions/v1"  # set in main() from --project-ref / POCKET_PROJECT_REF / Secrets.xcconfig


def project_ref(cli_value=None):
    """Supabase project ref: --project-ref, then env POCKET_PROJECT_REF, then Secrets.xcconfig."""
    ref = (cli_value or os.environ.get("POCKET_PROJECT_REF", "")).strip()
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
    raise SystemExit("No project ref: pass --project-ref, set POCKET_PROJECT_REF, or fill Secrets.xcconfig")
KEY_PLACEHOLDER = "PASTE-POCKET-KEY-HERE"
DICTATION_LOCALE = "he-IL"

# --- plist building blocks -----------------------------------------------------------------

def U():
    return str(uuid.uuid4()).upper()

def text(s):
    return {"Value": {"string": s, "attachmentsByRange": {}}, "WFSerializationType": "WFTextTokenString"}

def out_ref(uid, name):
    return {"Type": "ActionOutput", "OutputUUID": uid, "OutputName": name}

REPEAT_ITEM = {"Type": "Variable", "VariableName": "Repeat Item"}

def text_mixed(*parts):
    """Text with inline variables. parts: str literals or out_ref() dicts.
    Range offsets are UTF-16 units; Hebrew and U+FFFC are BMP so len() is right. No emoji in literals."""
    s, att = "", {}
    for p in parts:
        if isinstance(p, str):
            s += p
        else:
            att["{%d, 1}" % len(s)] = p
            s += "￼"
    return {"Value": {"string": s, "attachmentsByRange": att}, "WFSerializationType": "WFTextTokenString"}

def text_var(ref):
    return text_mixed(ref)

def attach(ref):
    return {"Value": ref, "WFSerializationType": "WFTextTokenAttachment"}

def dict_field(items):
    return {"Value": {"WFDictionaryFieldValueItems": [
        {"WFItemType": 0, "WFKey": text(k), "WFValue": v} for k, v in items]},
        "WFSerializationType": "WFDictionaryFieldValue"}

def act(ident, params):
    return {"WFWorkflowActionIdentifier": ident, "WFWorkflowActionParameters": params}

def get_key(uid, key, ref, name=None):
    p = {"UUID": uid, "WFDictionaryKey": key, "WFInput": attach(ref)}
    if name:
        p["CustomOutputName"] = name
    return act("is.workflow.actions.getvalueforkey", p)

# Control flow: an If block is three actions sharing one GroupingIdentifier.
# WFControlFlowMode 0 = If (carries the condition), 1 = Otherwise, 2 = End If.
# WFCondition 100 = "Has Any Value", 101 = "Does Not Have Any Value".
HAS_ANY_VALUE = 100

def if_open(group, ref, condition=HAS_ANY_VALUE):
    return act("is.workflow.actions.conditional", {
        "UUID": U(), "GroupingIdentifier": group, "WFControlFlowMode": 0,
        "WFCondition": condition,
        "WFInput": {"Type": "Variable", "Variable": attach(ref)},
    })

def if_else(group):
    return act("is.workflow.actions.conditional", {"GroupingIdentifier": group, "WFControlFlowMode": 1})

def if_end(group):
    return act("is.workflow.actions.conditional", {"GroupingIdentifier": group, "WFControlFlowMode": 2})

def repeat_open(group, ref):
    return act("is.workflow.actions.repeat.each",
               {"GroupingIdentifier": group, "WFControlFlowMode": 0, "WFInput": attach(ref)})

def repeat_end(group):
    return act("is.workflow.actions.repeat.each", {"GroupingIdentifier": group, "WFControlFlowMode": 2})

# Add New Reminder alert keys. Expected Apple plist keys; if a dated reminder imports without its
# alert, export a hand-made one and diff. Only these two constants should need to change.
ALERT_ENABLED_KEY = "WFAlertEnabled"
ALERT_TIME_KEY = "WFAlertCustomTime"

def reminder(title, alert_ref=None, notes=None):
    p = {"WFCalendarItemTitle": title}
    if notes is not None:
        p["WFCalendarItemNotes"] = notes
    if alert_ref is not None:
        p[ALERT_ENABLED_KEY] = True
        p[ALERT_TIME_KEY] = attach(alert_ref)
    return act("is.workflow.actions.addnewreminder", p)

def notification(title, body):
    return act("is.workflow.actions.notification",
               {"WFNotificationActionTitle": title, "WFNotificationActionBody": body})

def dictate(uid):
    return act("is.workflow.actions.dictatetext",
               {"UUID": uid, "WFDictateTextStopListening": "After Pause", "WFSpeechLanguage": DICTATION_LOCALE})

def local_time(now_id, fmt_id):
    """Current Date -> ISO 8601 with the device's own UTC offset (+02:00 / +03:00)."""
    return [
        act("is.workflow.actions.date", {"UUID": now_id, "WFDateActionMode": "Current Date"}),
        act("is.workflow.actions.format.date", {
            "UUID": fmt_id, "WFDateFormat": "ISO 8601", "WFISO8601IncludeTime": True,
            "WFInput": attach(out_ref(now_id, "Current Date"))}),
    ]

def post_json(uid, url, key, fields):
    return act("is.workflow.actions.downloadurl", {
        "UUID": uid, "WFURL": url, "WFHTTPMethod": "POST", "ShowHeaders": True,
        "WFHTTPHeaders": dict_field([("x-pocket-key", text(key))]),
        "WFHTTPBodyType": "JSON",
        "WFJSONValues": dict_field(fields),
    })

def post_file(uid, url, key, file_ref, recorded_at_ref):
    return act("is.workflow.actions.downloadurl", {
        "UUID": uid, "WFURL": url, "WFHTTPMethod": "POST", "ShowHeaders": True,
        "WFHTTPHeaders": dict_field([
            ("x-pocket-key", text(key)),
            ("x-recorded-at", text_var(recorded_at_ref)),
            ("Content-Type", text("audio/m4a")),
        ]),
        "WFHTTPBodyType": "File",
        "WFRequestVariable": attach(file_ref),
    })

# --- shared tail: error branch + reminders + notification -----------------------------------

def handle_ingest_response(response, source_text, create_note):
    """Everything after the POST. source_text is the dictated text (or a short label for audio)."""
    err_id, msg_id, title_id, sum_id, wrist_id, items_id, task_id, due_id, date_id, tr_id = (U() for _ in range(10))
    g_err, g_items, g_loop, g_due = U(), U(), U(), U()
    error_val = out_ref(err_id, "Error")
    message_he = out_ref(msg_id, "Message")
    items = out_ref(items_id, "Dictionary Value")
    task = out_ref(task_id, "Task")
    due = out_ref(due_id, "Due")
    title = out_ref(title_id, "Title")

    success = [
        get_key(title_id, "title", response, "Title"),
        get_key(wrist_id, "wrist", response, "Wrist"),
        get_key(items_id, "action_items", response),
        if_open(g_items, items),                                    # skip the loop when there are no tasks
            repeat_open(g_loop, items),
                get_key(task_id, "task", REPEAT_ITEM, "Task"),
                get_key(due_id, "due", REPEAT_ITEM, "Due"),
                if_open(g_due, due),                                # dated reminder
                    act("is.workflow.actions.detect.date", {"UUID": date_id, "WFInput": attach(due)}),
                    reminder(text_var(task), alert_ref=out_ref(date_id, "Dates")),
                if_else(g_due),                                     # plain reminder
                    reminder(text_var(task)),
                if_end(g_due),
            repeat_end(g_loop),
        if_end(g_items),
    ]
    if create_note:
        success += [
            get_key(sum_id, "summary", response, "Summary"),
            get_key(tr_id, "transcript", response, "Transcript"),
            # Apple Notes. iPhone only: the brief flags Create Note as the action most likely to abort on the watch.
            act("com.apple.mobilenotes.SharingExtension", {
                "WFCreateNoteInput": text_mixed(
                    title, "\n\n", out_ref(sum_id, "Summary"), "\n\nתמלול:\n", out_ref(tr_id, "Transcript")),
                "ShowWhenRun": False,
            }),
        ]
    success.append(notification(text_var(title), text_var(out_ref(wrist_id, "Wrist"))))

    return [
        # The function returns 200 even on expected failures; `error` is present only then.
        get_key(err_id, "error", response, "Error"),
        if_open(g_err, error_val),                                  # ---- error branch
            get_key(msg_id, "message_he", response, "Message"),
            reminder(text_mixed("Pocket (לא נשמר): ", source_text), notes=text_var(message_he)),
            notification(text("Pocket — לא נשמר"), text_var(message_he)),
        if_else(g_err),                                             # ---- success branch
            *success,
        if_end(g_err),
    ]

# --- the three shortcuts ---------------------------------------------------------------------

def build_pocket(key):
    dict_id, now_id, fmt_id, url_id = (U() for _ in range(4))
    dictated = out_ref(dict_id, "Dictated Text")
    return [
        dictate(dict_id),
        *local_time(now_id, fmt_id),
        post_json(url_id, f"{BASE}/ingest", key, [
            ("text", text_var(dictated)),
            ("recorded_at", text_var(out_ref(fmt_id, "Formatted Date"))),
        ]),
        *handle_ingest_response(out_ref(url_id, "Contents of URL"), dictated, create_note=False),
    ], ["Watch"]

def build_meeting(key):
    rec_id, now_id, fmt_id, url_id = (U() for _ in range(4))
    return [
        *local_time(now_id, fmt_id),
        # Records until you tap Stop. Runs on iPhone; the watch app (episode 2) covers the wrist.
        act("is.workflow.actions.recordaudio", {
            "UUID": rec_id, "WFRecordingCompression": "Normal",
            "WFRecordingStart": "Immediately", "WFRecordingEnd": "On Tap"}),
        post_file(url_id, f"{BASE}/ingest", key, out_ref(rec_id, "Recorded Audio"), out_ref(fmt_id, "Formatted Date")),
        *handle_ingest_response(out_ref(url_id, "Contents of URL"), "הקלטת פגישה", create_note=True),
    ], []

def build_ask(key):
    dict_id, now_id, fmt_id, url_id, err_id, msg_id, ans_id = (U() for _ in range(7))
    g_err = U()
    dictated = out_ref(dict_id, "Dictated Text")
    response = out_ref(url_id, "Contents of URL")
    answer = out_ref(ans_id, "Answer")
    message_he = out_ref(msg_id, "Message")
    return [
        dictate(dict_id),
        *local_time(now_id, fmt_id),
        post_json(url_id, f"{BASE}/ask", key, [
            ("question", text_var(dictated)),
            ("recorded_at", text_var(out_ref(fmt_id, "Formatted Date"))),
        ]),
        get_key(err_id, "error", response, "Error"),
        if_open(g_err, out_ref(err_id, "Error")),
            get_key(msg_id, "message_he", response, "Message"),
            notification(text("Pocket"), text_var(message_he)),
        if_else(g_err),
            get_key(ans_id, "answer", response, "Answer"),
            notification(text_var(dictated), text_var(answer)),
            act("is.workflow.actions.showresult", {"Text": text_var(answer)}),
        if_end(g_err),
    ], ["Watch"]

def build_notes_sync(key):
    """iPhone only. Copies notes recorded on the watch into Apple Notes (there is no API for that: the Create
    Note action is the only route). The server returns notes not yet copied, each with a ready-made Hebrew
    `body`; after each Create Note the shortcut acks the id so a note is never copied twice."""
    url_id, list_id, body_id, nid_id, ack_id, count_id = (U() for _ in range(6))
    g_has, g_loop = U(), U()
    response = out_ref(url_id, "Contents of URL")
    notes = out_ref(list_id, "Dictionary Value")
    return [
        post_json(url_id, f"{BASE}/notes", key, [("mode", text("unsynced"))]),
        get_key(list_id, "notes", response),
        if_open(g_has, notes),
            repeat_open(g_loop, notes),
                get_key(body_id, "body", REPEAT_ITEM, "Body"),
                get_key(nid_id, "id", REPEAT_ITEM, "Note ID"),
                # Share-extension action "Create Note": parameters are Body and Show Compose Sheet.
                act("com.apple.mobilenotes.SharingExtension", {
                    "WFCreateNoteInput": text_var(out_ref(body_id, "Body")), "ShowWhenRun": False}),
                post_json(ack_id, f"{BASE}/notes", key, [("ack_id", text_var(out_ref(nid_id, "Note ID")))]),
            repeat_end(g_loop),
            act("is.workflow.actions.count", {"UUID": count_id, "WFCountType": "Items", "Input": attach(notes)}),
            notification(text("Pocket"), text_mixed("הועתקו ", out_ref(count_id, "Count"), " הערות ל-Notes")),
        if_end(g_has),
    ], []

SHORTCUTS = {"Pocket": build_pocket, "Pocket Meeting": build_meeting, "Pocket Ask": build_ask,
             "Pocket Notes Sync": build_notes_sync}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default="shortcut")
    ap.add_argument("--key", default=KEY_PLACEHOLDER, help="POCKET_SHARED_KEY (never commit the output)")
    ap.add_argument("--only", choices=list(SHORTCUTS), help="build one shortcut")
    ap.add_argument("--project-ref", help="Supabase project ref (default: env POCKET_PROJECT_REF or Secrets.xcconfig)")
    args = ap.parse_args()
    global BASE
    BASE = f"https://{project_ref(args.project_ref)}.supabase.co/functions/v1"

    for name, builder in SHORTCUTS.items():
        if args.only and name != args.only:
            continue
        actions, types = builder(args.key)
        wf = {
            "WFWorkflowActions": actions,
            "WFWorkflowClientVersion": "2607.0.2",
            "WFWorkflowMinimumClientVersion": 900,
            "WFWorkflowMinimumClientVersionString": "900",
            "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4282601983, "WFWorkflowIconGlyphNumber": 59511},
            "WFWorkflowImportQuestions": [],
            "WFWorkflowInputContentItemClasses": [],
            "WFWorkflowOutputContentItemClasses": [],
            "WFWorkflowTypes": types,
            "WFWorkflowHasShortcutInputVariables": False,
        }
        out = os.path.join(args.outdir, f"{name}-unsigned.shortcut")
        with open(out, "wb") as f:
            plistlib.dump(wf, f, fmt=plistlib.FMT_BINARY)
        print(f"wrote {out} ({len(actions)} actions)")

if __name__ == "__main__":
    main()
