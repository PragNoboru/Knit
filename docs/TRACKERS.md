# Knit: The example trackers

Four files in `fixtures/trackers/` are real examples supplied by Pragaman on 25 Sep 2026, for reference and testing only. A fifth, `Knit_Standard_Tracker_v1_example.xlsx`, is an example in the Knit Standard Tracker v1 layout (section 6): Pragaman's blank template with ten made-up rows, not a real tracker. Live trackers will be Google Sheets in the Knit folder. Each file has a ready-made registry config in `fixtures/trackers.config.json`, including the numbers the fixture tests must reproduce.

The point of this document: the four trackers differ in ways that break naive sync. Every difference below is handled by configuration, not by tracker-specific code.

These files show the shapes live trackers take; they are not the live trackers. Expect other layouts too: each new quirk is handled as a general case and gets its own fixture test. The exports also leave out tabs that the sheets reference (the `Lists` tab behind the Noboru and Sapiens dropdowns), so test copies must be made from the live Google Sheets, not converted from these files.

## At a glance

| | Filing Buddy Google Ads | Filing Buddy Meta Ads | Noboru CA Campaign | Sapiens Content Calendar |
| --- | --- | --- | --- | --- |
| Tab | Copy of Google | Copy of Meta | Tasks | Calendar |
| Data rows | 34 | 23 | 191 | 96 |
| Rows for Pragaman | 34 | 20 | 136 | 96 |
| Date column | `Date`, **text** without year ("Mon 28 Sep") | same | `Date`, real dates | `Date`, real dates |
| Date shapes | single, window "1-6 Oct", open "From 30 Oct" | same | single | single |
| Task text | `Task` | `Task` | `Task` | `Working title` (with `Asset ID`) |
| Status read | `Status` | `Status` | `Done` (Yes / No / Moved / Not needed) | `Status` (dropdown, 7 options) |
| Status write | `Status` | `Status` | `Done` | `Status` |
| Formula columns | none | none | `Day`, `Status` | none (`Day` is text) |
| Completed-on column | `Done on` | `Done on` | none | `Posted on` |
| Owner | `Owner`: Pragaman | `Owner`: P, "P + Agent", Creative, Sales | `Owner`: comma lists, 5 people | `Owner`: Pragaman |
| Own ID | `ID` (G01...) | `ID` (M01...) | none | `Asset ID` (REEL-01...) |
| Critical flag | `Blocks go-live?` = Yes | same | `Critical path` = Yes | none |
| Rows on off days | 0 | 0 | 22 | 32 |
| Knit phase | 1 | 2 | 2 | 2 |

## 1. Filing Buddy Google Ads (Phase 1 tracker)
**Columns:** ID, Date, Phase, Task, Details / done when, Owner, Blocks go-live?, Depends on, Status, Done on, Notes, Ref.

**Why it goes first.** One owner on every row, its own stable IDs for cross-checking, a plain status column with a completed-on column beside it, and no formulas. That makes it the simplest tracker for proving the risky parts (pull, write-back, day close). It also exercises the hardest date parsing early, which is pure logic with fixture tests.

**Quirks**
- Dates are text with no year: "Mon 28 Sep", "Tue 29 Sep", "Wed 30 Sep", "Mon 5 Oct", "Wed 14 Oct", "Fri 23 Oct". The weekday validates the inferred year (2026).
- "1-6 Oct" (G30 Daily watch) is a window: Ongoing from Thu 1 Oct, due Tue 6 Oct. Fri 2 Oct is a holiday and Sun 4 Oct is off; it simply stays in Ongoing on working days.
- "From 30 Oct" (G34 Offline conversions) is open-ended: Ongoing from Fri 30 Oct, never spills.
- Every row currently says "Not started". The export's Status dropdown is "Not started, In progress, Done, Blocked, Skipped". Pragaman standardises it in the sheet to: Not started, In progress, Blocked, Done, Cancelled (PRD Q4, resolved). Knit never edits dropdowns; "Skipped" is still read as Cancelled.
- `Depends on` references IDs, sometimes in other trackers (G21 is referenced by Meta M14) or outside Knit (T1 to T4). Shown as text in the drawer in v1.
- `Done on` is written as text in the tracker's own style ("Mon 28 Sep").

## 2. Filing Buddy Meta Ads (Phase 2)
Same columns and quirks as Google Ads. Differences:
- Owners include "P" (alias for Pragaman), "P + Agent" (split on `+`; Agent is a known non-user), "Creative" and "Sales" (known non-users). With `ownerFilter: mine`, 20 of 23 rows are Pragaman's; M01, M20 (Creative) and M05 (Sales) are synced but not on his Today.
- M14 depends on G21 across trackers.

## 3. Noboru CA Campaign (Phase 2)
**Columns:** Date, Day, Task, Owner, Type, Critical path, Done, Status, Notes.

**Quirks**
- `Status` is a formula computed from `Done` and `Date` (Done / Moved / Not needed / OVERDUE / Today / This week / Later). It is time-relative, not a task state. Knit must never write to it and must not read it as status. The real status input is the `Done` column (dropdown from `Lists!A2:A5`: Yes, No, Moved, Not needed).
- `Day` is also a formula. Both are `readOnlyColumns`.
- `Done` cannot express In Progress or Blocked. Their write-back is `null`: the Done cell is left unchanged and the Knit Note carries the state (PRD N8).
- "Moved" is mapped to Cancelled with reason "Moved in source" (PRD N5, to confirm).
- Owners are comma lists of up to three people: "Pragaman, Shlok", "Anjan, Shlok, Pragaman". Rows containing Pragaman are his (136). Shlok, Anjan and Aryan are known non-users until Stage 3.
- 22 rows fall on off days: 14 on weekday holidays (14 Sep, 2 Oct, 20 Oct), 6 on Sundays, 2 on the 5th Saturday 31 Oct. Under `previous_working_day`: 2 Oct becomes Thu 1 Oct, Sun 11 Oct becomes Fri 9 Oct, 20 Oct becomes Mon 19 Oct, Sat 31 Oct becomes Fri 30 Oct.
- Rows start 14 Sep 2026, before go-live. They are history only unless brought forward in the backlog review.
- Rows extend to 31 Jan 2027, so the calendar must cover 2027.

## 4. Sapiens Content Calendar (Phase 2)
**Columns:** Week, Date, Day, Platform, Format, Pillar, Asset ID, Working title, Hook (first line), Caption, CTA, Hashtag set, Canva / video link, Owner, Status, Posted on, Notes.

**Quirks**
- A content calendar: the date is the posting date, and posts land on Sundays and Saturdays. 32 rows fall on off days (24 Sundays, 3 on 2nd Saturdays, 3 on 4th Saturdays, 1 on the 5th Saturday 31 Oct, 1 on the 1 Jan holiday). Under `previous_working_day`, Sun 25 Oct is due Fri 23 Oct (Sat 24 Oct is a 4th Saturday), and Sun 8 Nov (Diwali) is due Sat 7 Nov (a 1st Saturday). This matches the real job: the post must be ready and scheduled before the posting day.
- Title is built from two columns: `{Asset ID} · {Working title}`, with subtitle `{Platform} · {Format}`, because working titles repeat ("Bring one neighbour" appears twice).
- Long text columns (Hook, Caption) are shown in the drawer, collapsed.
- The Status dropdown has 7 options from `Lists!A2:A8`; the export contains only "Not started" and "Copy ready". The wizard reads the full list from the live sheet's validation rule. "Copy ready" is mapped to In Progress. Which option means Done (for example Scheduled or Posted) is PRD Q3.
- `Posted on` is the completed-on column, written as a real date.
- Rows start 21 Oct 2026 (after the 20 Oct holiday) and run to 12 Jan 2027.

## 5. Auxman (arriving 2 or 3 Oct 2026)
Not yet seen. It is connected through the wizard in Phase 2. If it is one task per row with a date column, no code is needed. If it is a grid with dates across columns, that is a change request (SOW assumption 2).

## 6. Knit Standard Tracker v1 (from Phase 2 go-live, 13 Oct 2026)
From Phase 2 go-live every brand's tracker is a copy of Pragaman's blank template, the Knit Standard Tracker v1, made from the blank template and never from another live tracker (its hidden Knit IDs would come along). The wizard sets it up in one go with **Use the standard setup** (PRD 11.1, N68 to N70).

**Tabs:** Tasks (the only tab Knit reads), Summary (counts by formula), Lists (the dropdown options), Guide (the rules, for people).

**Columns (row 1, A to N, in this order):** Task ID, Date, End date, Task, Details / done when, Workstream, Owner, Priority, Status, Stage, Done on, Depends on, Link, Notes. Brand columns may follow Notes; Knit adds Knit Note and the hidden Knit ID after them on activation.

**How the standard setup maps it**

| Setting | Value |
| --- | --- |
| Date, End date | `Date`, `End date` (6.3.4) |
| Title, subtitle | `{Task}`; `{Task ID} · {Workstream} · {Stage}` |
| Status read and write | `Status` |
| Completed on | `Done on`, a real date |
| Owner | `Owner`, comma separated |
| Source ID | `Task ID` |
| Critical flag | `Priority` = High |
| Detail columns | Details / done when, Workstream, Stage, Priority, Depends on, Link, Notes |
| Statuses | Not started, In progress, Blocked, Done, Cancelled, and a blank cell as Yet to Start |

**Quirks**
- A multi-day task has its first day in Date and its last in End date; a blank End date is a one-day task. Ongoing work gets an End date too: the day it is reviewed. Knit shows the task under Ongoing until its last working day, when it is due. A window ending on an off day can fall due before it starts (PRD Q9, open).
- Text ranges ("1-6 Oct") in Date are not the template's way; with an End date filled they are refused as `start_not_single` (6.3.4).
- `Done on` is a real date, written by Knit when a task is marked done in Knit. A Done row with a blank Done on counts as done today in Knit (6.6).
- `Priority` High marks a task critical; Normal and Low still show in the drawer.
- `Task ID` (FBG-21...) is the source ID, used to recreate the Knit ID column (14).
- The Status dropdown reads `Lists!$A$2:$A$6`: the five words. Pipeline steps go in Stage, never in Status. A word typed outside the five is an unmapped status (6.8).
- The preset maps all 14 headers, so renaming, deleting or doubling any of them, even Link or Notes, pauses the tracker until restored. Never insert columns between the standard ones.

**The example file** (`Knit_Standard_Tracker_v1_example.xlsx`, tab Tasks, a brand column `Budget` after Notes): ten rows FBG-01 to FBG-10 with real dates from 28 Sep to 30 Nov 2026, using all five status words and one blank status. Expected with today 25 Sep 2026: 10 rows, 9 for Pragaman (FBG-08 belongs to Creative; FBG-06 also names Riya, who is not a Knit user), 6 single dates and 4 Date and End date windows, 2 rows on off days (FBG-06 ends Sun 18 Oct and is due Sat 17 Oct, a 3rd Saturday; FBG-07 ends Tue 20 Oct, Dussehra, and is due Mon 19 Oct), no formula columns, no unmapped statuses. It is made by `scripts/make-standard-fixture.ts` (dev only) from an .xlsx export of the blank template.

## Recommendations for keeping trackers Knit-friendly
These are optional; Knit copes without them, but each one removes a source of Needs Attention items.
1. Use the Knit Standard Tracker v1 for every new tracker (section 6).
2. Keep one header row and one task per row.
3. Prefer real date cells. Text dates work if they include the weekday or the year. A multi-day task uses End date rather than a text range.
4. Give every status column a dropdown, so the wizard can map every option once.
5. Keep a completed-on column where possible.
6. Use consistent owner names; add each spelling as an alias in Knit.
7. Never type in the Knit ID column; it is protected with a warning for this reason.
