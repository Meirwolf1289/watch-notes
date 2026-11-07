# מדריך: משמיעים לשעון, מקבלים סיכום ומשימות (בלי לקנות Pocket)

המדריך מסביר איך להקים את אותה חוויה על Apple Watch שכבר יש לך: מקליטים בעברית, ותוך שניות מקבלים על היד **כותרת, סיכום ומשימות עם זמנים**. אפשר גם לשאול את ההערות שלך ("מה פתוח עם יוסי?").

זה פרויקט, לא מוצר. הוא עובד אצלי על שעון אמיתי (Apple Watch Series 7). צריך להקים אותו בעצמך, והוא לא עושה מה שהחומרה של מוצרים ייעודיים עושה.

## מה צריך

| דבר | הערה |
|---|---|
| Mac עם Xcode 26 | חינם מה-App Store |
| Apple Watch + iPhone מזווגים | watchOS 10 ומעלה. צריך כבל נתונים בין האייפון למק |
| Apple ID | חשבון חינמי מספיק. האפליקציה פגה אחרי 7 ימים ומתקינים מחדש בפקודה אחת |
| חשבון Supabase | המסלול החינמי מספיק |
| מפתח Anthropic | לסיכום (Claude Haiku). צריך טעינת קרדיט קטנה |
| מפתח Groq | לתמלול בעברית (whisper-large-v3). יש מסלול חינמי |

## כמה זה עולה

הקלטה קצרה בעברית עולה כמה עשיריות אגורה (הסיכום כ-0.12 אגורות, התמלול של 15 שניות כ-0.15). פגישה של חצי שעה עולה כ-20 עד 30 אגורות.
יש שני מגבילים מובנים: השרת עוצר ב-150 הקלטות ליום, ומומלץ להגדיר גם **תקרת הוצאה חודשית** במסוף של Anthropic (Limits).

## שלב 1. הורדת הקוד

```bash
git clone <כתובת המאגר>
cd pocket-watch
brew install supabase/tap/supabase xcodegen
```

## שלב 2. פרויקט Supabase

1. פתחו פרויקט חדש ב-supabase.com.
2. את ה-ref של הפרויקט תמצאו בכתובת הפרויקט: `https://<ref>.supabase.co`. תצטרכו אותו בהמשך.
3. התחברו מהטרמינל:

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase db push
```

`db push` יוצר את טבלת ההערות ואת תיקיית ההקלטות הפרטית.

## שלב 3. מפתחות

צרו מפתח סודי שמחבר את השעון לשרת שלכם. רק מי שמחזיק אותו יכול לקרוא לפונקציות:

```bash
openssl rand -hex 24
```

שמרו אותו בצד, הוא נקרא `POCKET_SHARED_KEY`. עכשיו הגדירו את הסודות בשרת, כל פקודה בנפרד:

```bash
supabase secrets set POCKET_SHARED_KEY=המפתח_שיצרתם
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set GROQ_API_KEY=gsk_...
```

אל תדביקו מפתחות בצ'אט, בסרטון או בקוד. הם נשארים רק ב-Supabase ובקובץ `Secrets.xcconfig` המקומי (הוא לא עולה לגיט).

## שלב 4. העלאת הפונקציות

```bash
supabase functions deploy ingest --no-verify-jwt
supabase functions deploy notes --no-verify-jwt
supabase functions deploy ask --no-verify-jwt
```

הדגל `--no-verify-jwt` נכון כאן: ההגנה היא המפתח `x-pocket-key`, שכל פונקציה בודקת.

## שלב 5. בדיקה מהמק (בלי שעון)

```bash
curl -X POST https://YOUR-PROJECT-REF.supabase.co/functions/v1/ingest \
  -H "x-pocket-key: המפתח_שיצרתם" \
  -H "Content-Type: application/json" \
  -d '{"text":"להתקשר לדנה מחר בבוקר לגבי התקציב, ולשלוח ליוסי את המצגת עד יום חמישי"}'
```

אמורה לחזור תשובה עם `title`, `summary` ו-`action_items`. כל משימה מקבלת זמן מדויק (`due`) לפי שעון ישראל.
אם חזרה תשובה עם `error`, הטקסט `message_he` אומר מה חסר. אם חזר `401`, המפתח בפקודה שונה מזה ששמתם בשרת.

## שלב 6. האפליקציה לשעון

```bash
cp Secrets.example.xcconfig Secrets.xcconfig
```

ערכו את `Secrets.xcconfig` (הקובץ הזה לא עולה לגיט):

```
POCKET_SHARED_KEY = המפתח_שיצרתם
POCKET_TEAM_ID = ה-Team-ID-שלכם
POCKET_PROJECT_REF = ה-ref-שלכם
```

ה-Team ID נמצא ב-Xcode: Settings, Accounts, בחרו את ה-Apple ID ואז Team (10 תווים). אם ה-Apple ID עוד לא מחובר ל-Xcode, חברו אותו שם קודם.

בדיקה בסימולטור, בלי שעון ובלי חתימה:

```bash
xcodegen generate
xcodebuild -project PocketWatch.xcodeproj -scheme PocketWatch \
  -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)' \
  -derivedDataPath build build CODE_SIGNING_ALLOWED=NO
```

## שלב 7. התקנה על השעון האמיתי

1. חברו את האייפון למק בכבל נתונים, פתחו אותו ולחצו Trust.
2. ב-Xcode: Window, Devices and Simulators. השעון אמור להופיע מתחת לאייפון (לפעמים לוקח כמה דקות, ל-Xcode יש להעתיק סמלים).
3. בשעון: Settings, Privacy & Security, Developer Mode. הוא מופיע רק אחרי ש-Xcode זיהה את השעון. מפעילים ומאתחלים.
4. הרצה:

```bash
scripts/install_watch.sh
```

השעון צריך להיות פתוח (לא נעול) כדי שהאפליקציה תיפתח לבד. בפעם הראשונה אשרו את המיקרופון.

## איך משתמשים

האפליקציה היא שלושה מסכים, מחליקים הצידה:
- **הקלטה:** לוחצים, מדברים, לוחצים שוב. אחרי שניות מופיעים כותרת, סיכום ומשימות.
- **הערות:** רשימת ההערות האחרונות.
- **שאל:** שאלה על ההערות ("מה פתוח עם יוסי?"). השרת עונה לפי ההערות מ-90 הימים האחרונים.

אם אין אינטרנט, ההקלטה נשמרת בשעון ונשלחת אוטומטית כשהחיבור חוזר.

## כשמשהו לא עובד

| תסמין | מה לבדוק |
|---|---|
| השעון לא מופיע ב-Xcode | כבל נתונים, האייפון פתוח ומאושר, והמתנה של כמה דקות |
| אין Developer Mode בשעון | הוא מופיע רק אחרי ש-Xcode זיהה את השעון |
| `Could not start recording` | באחד השעונים האמיתיים איכות הקלטה גבוהה נכשלה. האפליקציה מנסה איכות בינונית אוטומטית, ואם גם זה נכשל, הודעת השגיאה מציגה את הסיבה |
| אין תשובה, `no_transcriber` | חסר `GROQ_API_KEY` בשרת |
| `401` | המפתח באפליקציה שונה מהמפתח בשרת. הכניסו שוב ל-`Secrets.xcconfig` והתקינו מחדש |
| האפליקציה נעלמה אחרי שבוע | חשבון חינמי פג אחרי 7 ימים. מריצים שוב `scripts/install_watch.sh` |
| תמלול מעוות במשפט קצר או בשמות | התמלול טוב יותר במשפט של 8 עד 15 שניות. שמות פרטיים הכי חלשים |

## מה אפשר לעשות עם זה מעבר לסרטון

- לשנות את ההנחיה של Claude ב-`supabase/functions/ingest/index.ts` לסוג ההערות שלכם: משימות, רעיונות, פגישות.
- לשנות את אזור הזמן עם הסוד `POCKET_TZ` (ברירת המחדל: ישראל).
- להעתיק הערות ל-Apple Notes דרך קיצור דרך באייפון (`SHORTCUT.md`). אין ל-Apple ממשק לכתיבה ישירה ל-Notes.
- לערוך סרטונים בעברית עם הכלי ב-`reel/edit.py`.

## מגבלות שחשוב לדעת

- אפליקציה בשעון לא יכולה ליצור תזכורות ב-Apple Reminders (זו מגבלה של watchOS). לשם כך צריך אפליקציית אייפון נלווית.
- הקלטה ארוכה כשהיד למטה והמסך כבוי לא נבדקה.
- זה פרויקט למשתמש אחד. אין הרשמה, אין חשבונות, ומי שיש לו את המפתח יכול לקרוא את ההערות. אל תפרסמו את המפתח.
