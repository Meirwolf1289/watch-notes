// Local-time helpers for the ingest function.
// Everything the model needs to resolve "מחר", "חמישי הקרוב", "סופ"ש" correctly
// lives here so it can be unit-tested with `deno test`.

export const DEFAULT_TZ = "Asia/Jerusalem";

export type LocalContext = {
  iso: string; // 2026-11-07T23:30:00+02:00  (local wall clock + offset)
  weekday: string; // "Saturday"
  hebrew: string; // "שבת, 7 בנובמבר 2026 23:30"
  offset: string; // "+02:00" / "+03:00"
  tz: string;
};

function part(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

export function localContext(recordedAt: string, tz = DEFAULT_TZ): LocalContext {
  const d = new Date(recordedAt);
  if (Number.isNaN(d.getTime())) throw new Error(`bad recorded_at: ${recordedAt}`);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23", // never "24:xx" at midnight
    timeZoneName: "longOffset", // "GMT+02:00"
  }).formatToParts(d);

  const gmt = part(parts, "timeZoneName"); // "GMT+02:00" or "GMT" (UTC)
  const offset = gmt === "GMT" ? "+00:00" : gmt.replace("GMT", "");

  const hebrew = new Intl.DateTimeFormat("he-IL", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);

  return {
    iso: `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}` +
      `T${part(parts, "hour")}:${part(parts, "minute")}:00${offset}`,
    weekday: part(parts, "weekday"),
    hebrew,
    offset,
    tz,
  };
}

const ISO_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?([+-]\d{2}:\d{2}|Z)$/;
const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** UTC offset of `tz` ("+02:00") at the instant `ms`. */
function offsetAt(ms: number, tz: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  return name === "GMT" ? "+00:00" : name.replace("GMT", "");
}

function offsetMinutes(off: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(off)!;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** The offset `tz` has at a given LOCAL wall-clock time. It must be computed for the target date, not for
 *  "now": a reminder in April has +03:00 even when it is dictated in November (+02:00). */
export function offsetForWallTime(y: number, mo: number, d: number, h: number, mi: number, tz = DEFAULT_TZ): string {
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi);
  const instant = wallAsUtc - offsetMinutes(offsetAt(wallAsUtc, tz)) * 60_000;
  return offsetAt(instant, tz);
}

/** Model output -> an ISO-8601 string with the CORRECT offset for that date (so Apple Shortcuts'
 *  "Get Dates from Input" lands on the right local time), or null. `_nowOffset` is kept for callers. */
export function normalizeDue(due: unknown, _nowOffset: string, tz = DEFAULT_TZ): string | null {
  if (typeof due !== "string") return null;
  const s = due.trim();
  const iso = ISO_PARTS.exec(s);
  if (iso) {
    const [, y, mo, d, h, mi, sec, zone] = iso;
    if (zone === "Z") return `${y}-${mo}-${d}T${h}:${mi}:${sec ?? "00"}Z`; // genuine UTC instant: leave alone
    const off = offsetForWallTime(+y, +mo, +d, +h, +mi, tz);
    return `${y}-${mo}-${d}T${h}:${mi}:${sec ?? "00"}${off}`;
  }
  const bare = BARE_DATE.exec(s);
  if (bare) {
    const [, y, mo, d] = bare;
    return `${y}-${mo}-${d}T09:00:00${offsetForWallTime(+y, +mo, +d, 9, 0, tz)}`; // old "YYYY-MM-DD" style -> default 09:00
  }
  return null;
}
