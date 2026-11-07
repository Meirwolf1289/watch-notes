# האם יש ספק זול יותר (סיני?) לתמלול עברית

**שורה תחתונה:** אף ספק סיני לא תומך בעברית. הזול והפשוט ביותר שכן עובד בעברית הוא Groq (Whisper large-v3) — כ-30 אגורות לפגישה של 30 דקות; לאיכות עברית טובה יותר עם זיהוי דוברים, ElevenLabs Scribe v2.

## השוואה (ממוין לפי מחיר)

| ספק | מחיר לדקה | עברית | קלות חיבור | הערה |
|---|---|---|---|---|
| Cloudflare Workers AI (whisper-large-v3-turbo) | $0.0005 | דה-פקטו (Whisper) | בינונית | חינם ~3.5 שעות/יום; קובץ 45 דק׳ אולי דורש חיתוך ? |
| Groq (whisper-large-v3-turbo) | $0.00067 | דה-פקטו (Whisper) | קלה מאוד (תואם OpenAI) | חינם עד ~8 שעות/יום ?; turbo לפעמים הוזה בעברית |
| Groq (whisper-large-v3) | $0.00185 | דה-פקטו (Whisper) | קלה מאוד | WER ~33% ב-FLEURS עברית; בטוח יותר ל-turbo |
| Alibaba qwen3-asr-flash | $0.0021 | **לא** | קלה | הסיני הזול; עברית לא ברשימה |
| AssemblyAI Universal-2 | $0.0025 | כן (רשמי, 10–25% WER) | בינונית (העלאה + polling) | $50 קרדיט |
| OpenAI gpt-4o-mini-transcribe | $0.003 | כן | אפס שינוי | כבר deprecated, הסרה 2027-02 — גם whisper-1 הנוכחי |
| ElevenLabs Scribe v2 | $0.0037 | כן (רשמי, דף עברית) | קלה | כולל diarization; נתוני עברית מהספק בלבד ? |
| Deepgram Nova-3 | $0.0043 | כן (רשמי) | קלה | $200 קרדיט שלא פג; איכות עברית לא ידועה ? |

מקור לפניו: OpenAI whisper-1 = $0.006 לדקה.

## ההמלצה

1. **להתחיל עם Groq whisper-large-v3** — שינוי של URL + שם מודל ב-`supabase/functions/ingest/index.ts`, אותה משפחת Whisper שכבר עובדת לך. פגישה של 30 דקות: **~20 אג׳** (large-v3) או **~7 אג׳** (turbo). השתמש ב-signed URL מה-storage במקום upload כדי לא להיתקע על 25MB.
2. **במקביל לבדוק ElevenLabs Scribe v2** על 2–3 הקלטות אמיתיות — הספק היחיד שמפרסם רמת דיוק לעברית, ועם זיהוי שני דוברים מובנה. פגישה של 30 דקות: **~40 אג׳**. אם הדיוק טוב יותר מ-Groq, הפרש של 20 אגורות לא שווה דבר.
3. **Deepgram** כגיבוי חינמי לאורך זמן ($200 שלא פג, ~775 שעות), אבל אין שום עדות לאיכות עברית.
4. אם כולם מאכזבים בעברית: `ivrit-ai/whisper-large-v3-turbo` (18.7% WER, מאומן על עברית ישראלית) על GPU serverless — איכות הכי טובה, הכי הרבה תפעול.

לא לשכוח: whisper-1 הנוכחי נמחק מה-API ב-2027-02-26, אז מעבר נדרש ממילא.

## הספקים הסיניים

| ספק | מחיר | עברית |
|---|---|---|
| Alibaba qwen3-asr-flash (Singapore) | ~$0.13/שעה, 10 שעות חינם | לא — 30 שפות, בלי עברית |
| Alibaba paraformer-v2 | ~$0.04/שעה (Beijing בלבד, חשבון סיני) | לא — zh/en/ja/ko/de/fr/ru |
| ByteDance Doubao Seed-ASR 2.0 | ~$0.22/שעה, חיוב ב-CNY | לא ברשימה הרשמית (19 שפות) |
| Tencent Cloud ASR | ~$1.00/שעה (יקר מ-whisper) | לא — סינית ואנגלית; חתימת TC3-HMAC |
| iFlytek | לא פורסם | לא — 15 שפות; WebSocket + HMAC |
| SiliconFlow SenseVoice | חינם | לא — zh/en/yue/ja/ko |
| DeepSeek | — | אין בכלל מוצר תמלול |

סיכום: זול באמת (עד $0.04/שעה), אבל ללא עברית בשום מודל מתארח. לא רלוונטי לפרויקט אלא אם Alibaba תוסיף עברית.

## מקורות

- https://console.groq.com/docs/speech-to-text
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://elevenlabs.io/pricing/api ; https://elevenlabs.io/speech-to-text/hebrew
- https://deepgram.com/pricing ; https://developers.deepgram.com/docs/models-languages-overview
- https://www.assemblyai.com/pricing
- https://developers.openai.com/api/docs/pricing ; https://developers.openai.com/api/docs/deprecations
- https://www.alibabacloud.com/help/en/model-studio/model-pricing ; https://arxiv.org/html/2601.21337v1
- https://docs.volcengine.com/docs/lake-ai-service/speech-to-text-doubao-seed-2-0-lite-enhanced-version?lang=en
- https://www.tencentcloud.com/products/asr ; https://global.xfyun.cn/products/speech-to-text
- https://huggingface.co/ivrit-ai/whisper-large-v3-turbo

**צעד הבא:** להחליף את הקריאה ל-Groq whisper-large-v3 ב-`index.ts` ולהריץ הקלטת עברית אחת מהשעון.
