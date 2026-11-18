---
title: The ledger and undo
blurb: Review, edit and remove grades; undo and redo.
order: 5
---

# The ledger and undo

![The ledger](img/ledger.png)

The **Ledger** under the slide lists every grade on this image: one row per group of pins you graded together, with its reason and pin count. Tick **All images** to see the whole exam.

## What you can do with a row

- **✓ / ✗ badge**: click to switch the group between correct and wrong.
- **The reason**: click it to jump to that image and select those pins; double-click to edit the text (**↵** saves, **Esc** cancels). The pencil does the same.
- **Trash**: remove the grade. The pins become ungraded again.
- **Caret** (left): show one chip per student. Click a chip to show that pin and open that student's answers in the [student panel](students.md); its **×** removes just that student from the group.

Rows read *no reason* for wrong answers without one, and *Correct — note* for correct answers with a note.

The **AUTO** row lists students with more than one pin (see [Double pins](grading.md#double-pins)). It's a rule, not a grade, so it can't be edited. With **All images** ticked there's one AUTO row per image.

## Search and filter

On a big exam the ledger gets long. The controls in its header narrow it down:

- **Search** (*Reason or student*): type part of a reason or a student's name. Rows found by a student's name open with that student's chip highlighted.
- **All / Wrong only / Correct only**: show one kind of grade. AUTO rows count as wrong.
- **All graders**: pick one grader to see only their grades: *You*, each [other grader](handoff.md#who-graded-what) whose grades are in the session, or *AUTO (double pins)* for the rule rows.

Filters combine with each other and with **All images**. While a filter is on, the header reads *3 of 41 groups*; **Clear** shows everything again.

To see everything about one student instead, use [Look up a student](students.md).

## Undo and redo

- **⌘Z** undoes the last change; **⇧⌘Z** (or **⌘Y**) redoes it. The arrows in the top bar do the same.
- Everything that changes grades can be undone: grading, removing grades, ledger edits and merged hand-off results. Up to 200 steps are kept.
- Undo history is cleared when you open a session.
