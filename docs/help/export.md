---
title: Exporting grades
blurb: grades.csv, feedback files, choosing columns, and item statistics with KR-20.
order: 7
---

# Exporting grades

Click **Export** in the top bar (or **File ▸ Export Grades…**, **⌘E**). You can export at any time; ungraded answers are flagged.

![The Export window](img/export-csv.png)

The strip at the top summarises the class: students, questions, the mean score, KR-20 reliability, and how many answers are still ungraded.

## Grades CSV

Click **Export grades.csv** to write the file into the folder shown at the bottom (by default an `export` folder next to the session file; **Choose…** to change it).

### Choosing columns

Each column can be turned on or off, renamed, and dragged into a different order. You can also drag the column headers in the preview table. The **Columns** menu has two presets:

- **Item analysis**: UID, surname, first name, number correct, questions asked, the comment, and one 1/0 column per question.
- **Simple (Student, Grade, Comment)**.

| Column | Contains |
| --- | --- |
| UID | The student number from the folder name |
| Surname, First name | Split from the folder name |
| Student | The full folder name |
| Correct answers | Number right |
| Questions asked | Number of included questions |
| Grade | For example *4/5* |
| Percent | 0–100 |
| Comment | The student's feedback text ([What students see](feedback.md)) |
| Item scores | One column per question: 1 correct, 0 wrong |

Options:

- **UID**: the number from the folder name, or blank.
- **Ungraded items**: leave blank, or count as 0.
- **Also write feedback/<student>.txt**: one text file per student, ready to upload as feedback.

The layout is saved and also editable in [Preferences ▸ Export](preferences.md#export).

The CSV is UTF-8 and opens directly in Excel. Text that a spreadsheet could mistake for a formula is written safely.

## Statistics

![Item statistics](img/export-stats.png)

The **Statistics** tab shows how the exam performed:

- **KR-20**: the test's reliability (0–1), with a reading from *very low* to *good*.
- **Mean** and **SD** of the scores.
- For each question:
  - **Difficulty (p)**: the share of students who got it right.
  - **Point-biserial (corrected)**: how well the question separates strong from weak students. Below 0.2 is shown in red.
  - **KR-20 if deleted**: reliability without that question. Red when leaving it out would make the test more reliable.

If some answers are ungraded, choose **Leave those students out** or **Count ungraded as wrong**. At least two fully graded students are needed. **Save item-stats.csv** writes the table to the export folder.

## Time spent

The app quietly keeps track of how long grading takes. You never see it while grading; it shows up only here, as a **Time** tab in the Export window, once some grading has been done.

- **Grading time**: total active time. Each grading action counts the time since the previous one, or since the image was opened. Gaps longer than 2 minutes count as 2 minutes, so breaks don't inflate it.
- **By question**: time, pins, time per pin and per student for each question. Slow questions are often ambiguous ones.
- **By grader**: when you [handed work to other graders](handoff.md), their time comes back in their results file, so you can compare time per pin.
- **Pins graded twice**: for each pair of graders, their time per pin on the pins both graded, and the time spent on pins they agreed on versus pins they disagreed on. Disagreements graded much faster than agreements can mean rushed grading.
- **Students who took longest**: the students whose answers took most time to grade.

Pins the [answer key](answer-key.md) graded take no time and are counted separately. **Save time-stats.csv** writes all of these tables to the export folder.

An action's time is shared equally by the pins it graded, so a cluster of 30 graded with one key press gives each pin a thirtieth of that time. Undoing a grade doesn't remove its time, and sessions created before version 0.3.6 have no time recorded for earlier grading.
