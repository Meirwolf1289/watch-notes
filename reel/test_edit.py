"""Unit tests for the pure logic of edit.py (no network, no ffmpeg): python3 -m unittest reel/test_edit.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import edit  # noqa: E402


def W(word, start, end):
    return {"word": word, "start": start, "end": end}


class PlanTests(unittest.TestCase):
    def test_filler_words_are_cut_and_split_the_segment(self):
        words = [W("שלום", 0.0, 0.4), W("אה", 0.45, 0.9), W("עולם", 0.95, 1.4)]
        p = edit.plan(words, duration=2.0)
        self.assertEqual([w["word"] for w in p["removed"]], ["אה"])
        self.assertEqual(len(p["segments"]), 2)
        self.assertLess(p["segments"][0][1], 0.9)      # first segment ends before the filler
        self.assertGreater(p["segments"][1][0], 0.45)  # second starts after the filler began

    def test_immediate_repeat_keeps_the_last_take(self):
        words = [W("אני", 0, .2), W("בונה", .25, .6), W("אני", 1.0, 1.2), W("בונה", 1.25, 1.6), W("אפליקציה", 1.65, 2.2)]
        p = edit.plan(words, duration=3.0)
        self.assertEqual([w["start"] for w in p["removed"]], [0, .25])  # first "אני בונה" removed
        self.assertEqual([w["word"] for w in p["kept"]], ["אני", "בונה", "אפליקציה"])

    def test_single_word_stutter(self):
        words = [W("אני", 0, .2), W("אני", .25, .45), W("הולך", .5, .9)]
        p = edit.plan(words, duration=2.0)
        self.assertEqual(len(p["removed"]), 1)
        self.assertEqual(p["removed"][0]["start"], 0)

    def test_long_pause_is_cut_short_pause_is_kept(self):
        words = [W("א", 0, .3), W("ב", .5, .8), W("ג", 3.0, 3.3)]
        p = edit.plan(words, duration=5.0, max_pause=0.35)
        self.assertEqual(len(p["segments"]), 2)        # the 2.2 s pause split it, the 0.2 s gap did not
        self.assertLess(p["saved"], p["original"])

    def test_padding_never_reaches_into_a_removed_word(self):
        # filler "אה" starts 0.05 s after "שלום" ends; the 0.09 s pad must stop at the filler.
        words = [W("שלום", 0.0, 0.40), W("אה", 0.45, 0.90), W("עולם", 0.95, 1.40)]
        p = edit.plan(words, duration=2.0)
        self.assertLessEqual(p["segments"][0][1], 0.45 + 1e-9)
        self.assertGreaterEqual(p["segments"][1][0], 0.90 - 1e-9)

    def test_keep_fillers_flag(self):
        words = [W("שלום", 0, .4), W("אה", .45, .9), W("עולם", .95, 1.4)]
        p = edit.plan(words, duration=2.0, drop_fillers=False)
        self.assertEqual(p["removed"], [])

    def test_segments_never_overlap_and_stay_in_bounds(self):
        words = [W("א", 0.02, .3), W("אה", .31, .5), W("ב", .51, .8)]
        p = edit.plan(words, duration=1.0)
        prev_end = -1
        for s, e in p["segments"]:
            self.assertGreaterEqual(s, 0)
            self.assertLessEqual(e, 1.0)
            self.assertGreaterEqual(s, prev_end)
            prev_end = e

    def test_empty_words(self):
        p = edit.plan([], duration=3.0)
        self.assertEqual(p["segments"], [[0, 3.0]])


class OutputTimelineTests(unittest.TestCase):
    def test_words_are_remapped_onto_the_cut_timeline(self):
        words = [W("א", 0.0, 0.3), W("ב", 2.0, 2.3)]
        p = edit.plan(words, duration=3.0, max_pause=0.3)
        out = edit.remap(p["kept"], p["segments"])
        self.assertEqual(len(out), 2)
        self.assertLess(out[1]["start"], 1.0)   # the 1.7 s pause is gone
        self.assertGreater(out[1]["start"], out[0]["end"])


class BidiTests(unittest.TestCase):
    def test_hebrew_word_is_reversed_for_ltr_drawing(self):
        self.assertEqual(edit.visual_word("שלום"), "םולש")

    def test_latin_word_is_untouched(self):
        self.assertEqual(edit.visual_word("Claude"), "Claude")

    def test_digits_stay_ltr_inside_a_hebrew_word(self):
        self.assertEqual(edit.visual_word("ב-129"), "129-ב")

    def test_line_reverses_word_order(self):
        self.assertEqual(edit.visual_line(["שלום", "עולם"]), ["םלוע", "םולש"])

    def test_trailing_punctuation_goes_left(self):
        self.assertEqual(edit.visual_word("שלום."), ".םולש")


class LineGroupingTests(unittest.TestCase):
    def test_lines_break_on_sentence_end_and_length(self):
        words = [W("זה", 0, .2), W("עובד.", .25, .6), W("עכשיו", .65, 1.0), W("אנחנו", 1.05, 1.4)]
        lines = edit.group_lines(words)
        self.assertEqual([[w["word"] for w in l] for l in lines], [["זה", "עובד."], ["עכשיו", "אנחנו"]])


if __name__ == "__main__":
    unittest.main()
