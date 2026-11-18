# Grading with other people: hand-off packs

Split a grading session with one or more other graders. You (the **host**) keep the session. Each other grader (a **guest**) gets part of the remaining work as a file. They grade it on their own computer and send back a results file. You merge it in.

The same guide is built into the app: click **?** in the Hand off window.

There is no server and no account. The files travel however you like: email, Google Drive, a shared folder or a USB stick.

```
 host ── Exam - Jamie.msgpack ──▶ guest grades only that work
 host ◀── Exam - Jamie.msgresult ── guest
```

## Before you start

- Both people need Micro Speed Grader installed.
- The guest needs their own copy of the course slides folder (the same `.ndpi` files as the host). The pack holds the students' pins and answers, not the slide images, so it stays small.
- The guest does **not** need the exam file or the submissions folder. Everything they need is inside the pack.

## Host: split the work

1. Open your session and click **Hand off** in the top bar (next to Export).
2. Type the first grader's name. Click **+ Add grader** for each extra person (× removes one).
3. Choose who grades what. Each card is one image: a question on one slide. The number on a card is how many pins on it are still ungraded. Each person has a column with their pin total.
   - **Drag a card** to someone's column.
   - Or **click a card**: with one other grader it swaps sides; with more, a menu asks who should get it.
   - **Split evenly** shares the pins between everyone, you included. **Give all away** shares them only between the other graders. **Keep all** gives everything back to you.

   An image is never split, so every answer to a given image is marked by the same person. The coloured bar at the top shows how many pins each person will grade.
4. Click **Create pack…** (or **Create N packs…** for several graders). With one grader you choose where to save the file; with several, you choose a folder and get one `.msgpack` per person, named after them. Send each person their own file.

The handed-off pins are now **locked** in your session:

- They're drawn faint on the slide and can't be graded.
- The image list shows `→ name` beside images that are out.
- A banner on the image says how many pins are with the guest.

You can keep grading everything else, and you can hand off more later. Each pack only contains work that isn't already out.

## Guest: grade the pack

1. On the start screen, click **Got work from another grader?** and choose the `.msgpack` file.
2. Choose your slides folder. If slides the pack needs are missing, the app names them.
3. Choose where to save your work. This creates an ordinary session file (`.msgrade`) that auto-saves, so you can close the app and resume later from the start screen.
4. Grade as usual. You only see the images you were given. Pins that belong to the host are shown faint and can't be graded.
5. The top bar shows **Send results · done/total**. When you're finished (or whenever the host asks), click it and save the `.msgresult` file. Send that file back to the host.

You can send results more than once. Each file holds everything you've graded in the pack so far.

## Host: merge the results

1. Open **Hand off** and click **Import results…**, then choose the `.msgresult` file.
2. The guest's grades are merged into your session. The pack shows as *returned*, with the number of grades merged.

With several graders, import each person's results file as it arrives, in any order.

Merging is a single step you can undo with **⌘Z**.

Only pins that were in that pack are taken from the file. If you already graded one of those pins yourself (for example after a recall), **your grade is kept** and the guest's is skipped. The confirmation message says how many were skipped.

## Taking work back (recall)

Under **Packs** in the Hand off window, click **Recall** next to a pack that's still out. Its pins unlock in your session right away, so you can grade them or hand them to someone else.

If the guest sends results for a recalled pack later, you can still import them. Only pins you haven't graded since get merged.

## What's in the files

| File | Made by | Contains |
| --- | --- | --- |
| `.msgpack` | host | Session name, questions, students and their pins and answers, grades so far, and slide file names. No slide images. |
| `.msgresult` | guest | The guest's grades and feedback text, for pins in that pack only. |

Both files contain student answers, so share them the way you'd share any other grading material.

## Troubleshooting

- **"That folder is missing …"**: the guest picked a folder without the slides the pack uses. Choose the folder that has those `.ndpi` files.
- **"These results are for a pack that wasn't made from this session."**: the results file came from a pack made in a different session file. Open the session that created the pack, then import again.
- **"Give each grader a different name."**: two graders have the same name. Names are used for the file names and the pack list, so each must be unique.
- **"This isn't a Micro Speed Grader hand-off pack / results file."**: the wrong file was chosen, or it was changed after it was saved.
