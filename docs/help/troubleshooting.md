---
title: Troubleshooting
blurb: Missing slides, questions not found, save problems and updates.
order: 11
---

# Troubleshooting

## Setting up a session

**"No questions like “Q1. Using VMS123, …” were found in that file."**
The exam's questions must start like `Q1. Using VMS109, …`. If the PDF is a scan (an image with no text), make a JSON exam file instead:

```
{ "name": "Practical 1",
  "questions": [
    { "num": 1, "slides": ["VMS109"], "prompt": "Place a pin on an eccrine sweat gland" }
  ] }
```

**A question's slide shows "missing".**
The slides folder has no file whose name contains that slide ID. Check the file name, or choose the right folder. You can also fix the slide ID in the question table.

**Start grading → stays grey.**
The line next to it says what's still needed: the exam, a folder, the save location, or at least one ticked question.

**"⚠ N things to check" under the submissions folder.**
Some student files couldn't be used as they are, such as a file with no slide ID in its name or a student with nothing to grade. Click **Review** for what each one means and what to do. See [Things to check](getting-started.md#things-to-check).

**A student's pins are missing.**
Each student needs their own folder inside the submissions folder, and the `.ndpa` file name must contain the slide ID (`VMS109`). Pins whose title names another question appear on that question instead. Start a new session and look at **Things to check**: it lists files the app had to leave out.

## While grading

**"No gradeable images"**
None of the included questions has its slide in the slides folder. Go **Back** and check the slides folder.

**"Could not open slide"**
The slide file is damaged or in a format the app can't read, or the drive it's on is no longer connected. Copy the slides to a local folder and choose that folder.

**"Save failed" in the top bar**
Hover over it to see why. Usually the session file's folder was moved, is read-only, or was on a drive that's been disconnected. Your grades are still in the app: fix the folder, and the next change saves again.

**A session file won't open.**
The app falls back to the automatic backup (`yoursession.msgrade.bak`). If both are damaged, check your Time Machine or cloud copy.

## Updates

**The update banner doesn't appear.** Choose **Micro Speed Grader ▸ Check for Updates…**. Updates come from the project's GitHub releases and need an internet connection.

## Still stuck?

Report a problem on the [project page](https://github.com/agadin/micro-speed-grader/issues). Don't attach student files: describe what happened instead.
