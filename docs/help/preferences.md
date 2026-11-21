---
title: Preferences
blurb: Every setting: pins, selection tools, mouse and keys, clusters, grading text, export.
order: 9
---

# Preferences

Open Preferences with **⌘,** or the gear in the top bar. It opens in its own window; changes apply immediately. Type in the search field at the top of the sidebar to find a setting. **Restore defaults** resets everything.

## Pins

How student pins are drawn.

- **Marker**: flag, push-pin, dot or crosshair, and its size.
- **Pin text**: nothing, the pin title, or the student's name (also in the right panel's Display section).
- **Faded pins**: how strongly pins from other questions show.
- **Colours** for ungraded, selected, correct, wrong and double pins, the cluster outline and the painted area. Click the preview to try it on a different stain.

## Selection

Which selection tools are on. Each has a short demo. At least one of **Lasso**, **Paint brush** and **Polygon** stays on. Under **Crowded clusters**: **Paint with pins hidden**, **Pin by pin**, **Spotlight on hover**, **Small pins when zoomed** and **Click to add / remove**. See [Selecting pins](selecting.md). Under **Unsure pins**: **Not sure button**, and whether skipped pins come back at the end of the image or the exam. See [Not sure](grading.md#not-sure).

## Mouse & keys

- **Left pans** or **Left selects**: which mouse button selects.
- **Scroll zoom speed**, and whether double-click zooms in.
- The keys for **Show / hide pins** (Space) and **Show / hide minimap** (M): click **Change** and press a new key.

## Clusters & zoom

- **Cluster radius** and **Min pins per cluster** (also in the right panel).
- **Single-pin field**: how much slide to show around a lone pin.
- **Padding** around a cluster when zooming to it.
- **Next cluster: zoom to it automatically**, and **smooth zoom and pan**.

## Reading submissions

Which annotations count as answers, and how each is matched to a question (the rules are in [How student pins are read](getting-started.md#how-student-pins-are-read)):

- **Count as answers**: **Pins only**, **Pins and shapes** (the default: circles and outlines count at their centre), or **Every annotation** (rulers, arrows and text notes too).
- **Bare numbers**: on (the default), a title like *3* or *#3* counts as Q3 when Q3 uses that slide. Off: only titles that say *Q3* or *question 3* count.
- **Title names another question**, such as *Q9* on a slide only Q5 uses: **Use the pin for its slide's question** (the default), or **Leave the pin out**, so the student has no answer for it unless they have another pin. Either way it's listed in [Things to check](getting-started.md#things-to-check).
- **Leftover question**: on (the default), an unlabelled pin answers the student's one question left on that slide (they labelled Q3, so the other pin is Q13). Off: it stays unlabelled for you to decide.
- **Unlabelled pins**, on a slide several questions use, with a title that doesn't say which: **Show on each question, with a ?** (the default; grading it assigns it), **Give to the lowest-numbered question**, or **Leave them out**.
- **Several pins for one question**: **Mark them wrong automatically** (the default; see [Double pins](grading.md#double-pins)) or **Leave them for me to grade**. Either way, grading one of them yourself is what counts.

New sessions use these settings, and each session keeps the ones it was made with, so a later rescan reads it the same way. (Sessions made before version 0.3.8 count every annotation.) Changing a setting while a session is open reads its submissions again with the new rules. A copy of the session is saved first, next to it. Pins that now answer a different question lose the grade they had for the old one, and pins that are left out are set aside with their grades. **Several pins for one question** applies straight away without reading anything again.

## Grading text

The feedback students read, edited in place. See [What students see](feedback.md).

## Export

The column layout of `grades.csv`, shared with the Export window. See [Exporting grades](export.md#choosing-columns).

## About

The version you're running, links to this help and the project page, and **Check for Updates…**.
