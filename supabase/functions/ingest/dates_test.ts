import { assertEquals } from "jsr:@std/assert@1";
import { localContext, normalizeDue, offsetForWallTime } from "./dates.ts";

Deno.test("23:00Z on Nov 7 is already Sunday Nov 8 01:00 in Israel", () => {
  const c = localContext("2026-11-07T23:00:00Z");
  assertEquals(c.iso, "2026-11-08T01:00:00+02:00");
  assertEquals(c.weekday, "Sunday");
  assertEquals(c.offset, "+02:00");
});

Deno.test("summer offset is +03:00", () => {
  assertEquals(localContext("2026-07-01T12:00:00Z").offset, "+03:00");
});

Deno.test("an input that already carries the local offset keeps its wall clock", () => {
  const c = localContext("2026-11-07T23:30:00+02:00");
  assertEquals(c.iso, "2026-11-07T23:30:00+02:00");
  assertEquals(c.weekday, "Saturday");
});

Deno.test("normalizeDue", () => {
  assertEquals(normalizeDue("2026-11-12", "+02:00"), "2026-11-12T09:00:00+02:00");
  assertEquals(normalizeDue("2026-11-12T19:00:00+02:00", "+02:00"), "2026-11-12T19:00:00+02:00");
  assertEquals(normalizeDue("2026-11-12T19:00+02:00", "+02:00"), "2026-11-12T19:00:00+02:00");
  assertEquals(normalizeDue("next Thursday", "+02:00"), null);
  assertEquals(normalizeDue(null, "+02:00"), null);
});

Deno.test("DST: the offset comes from the target date, not from today", () => {
  // dictated in November (+02:00), but April is on summer time (+03:00)
  assertEquals(normalizeDue("2027-04-01", "+02:00"), "2027-04-01T09:00:00+03:00");
  assertEquals(normalizeDue("2027-04-01T19:00:00+02:00", "+02:00"), "2027-04-01T19:00:00+03:00");
  // dictated in summer (+03:00), but December is winter time (+02:00)
  assertEquals(normalizeDue("2026-12-01T19:00:00+03:00", "+03:00"), "2026-12-01T19:00:00+02:00");
});

Deno.test("DST: the day before and the day after the March 2027 switch", () => {
  assertEquals(offsetForWallTime(2027, 3, 25, 12, 0), "+02:00");
  assertEquals(offsetForWallTime(2027, 3, 27, 12, 0), "+03:00");
});

Deno.test("a real UTC (Z) timestamp is left alone", () => {
  assertEquals(normalizeDue("2027-04-01T16:00:00Z", "+02:00"), "2027-04-01T16:00:00Z");
});
