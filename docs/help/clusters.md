---
title: Clusters and navigation
blurb: How pins are grouped, moving between clusters and images, and zooming.
order: 4
---

# Clusters and navigation

## How clusters work

Pins that land near each other are grouped into a **cluster**. Two settings in the right panel's **Clusters** section control it:

- **Radius** (µm): how close pins must be to group together.
- **Min size** (pins): the smallest group that counts as a cluster. Smaller groups are **singles**.

The heading shows how many groups there are. Clusters come up biggest first, so the most common answers are graded first. The ranges in the panel cover typical slides; [Preferences ▸ Clusters & zoom](preferences.md#clusters--zoom) allows larger values.

### Clusters and singles

**Show** switches between **Clusters** and **Singles** (**S**). Once the clusters are done, switch to singles to grade the scattered one-off pins.

## Moving around

| Key | Moves to |
| --- | --- |
| **]** or **N** | Next cluster |
| **[** or **P** | Previous cluster |
| **⌘→** / **⌘←** | Next / previous image |
| **F** | Zoom to the selection or cluster |
| **H** | Whole slide |

The bottom toolbar shows where you are, such as *Cluster C · 23 pins, 3 of 96*, or *Nothing left on this image*. The **Whole slide / Cluster** switch beside it does the same as **H** and **F**.

Moving to the next cluster zooms to it automatically. Turn that off, or turn off the smooth animation, in [Preferences ▸ Clusters & zoom](preferences.md#clusters--zoom).

## Images

An **image** is one question on one slide. A question that uses two slides has two images, shown as *(1/2)* and *(2/2)*. Students may pin either slide; a pin on both counts as multiple pins.

Pick an image from the menu in the top bar, or use **Prev** and **Next image** in the **Progress** section.

## The minimap and scale

The minimap (top left, **M**) shows the whole slide with every pin as a coloured dot and a box for the current view. The top-right readout shows the slide ID and the resolution in µm per pixel, and the scale bar sits bottom right.

## Measure distances and areas

Press **R** (or click **Ruler** in the bottom toolbar) to switch the ruler on. While it's on, the button you select with measures instead of selecting; the other button still pans.

- **Distance**: drag from one point to another. The line shows its length, for example *245 µm* (lengths over 1,000 µm show in mm).
- **Area**: click the corners of an outline, then close it by clicking the first corner, double-clicking, or pressing **↵**. It shows the area (µm² or mm²) and the perimeter. While drawing, **⌫** removes the last corner and **Esc** cancels.

Measurements are numbered and stay on the slide until you clear them, so you can compare several. **⌫** removes the last one, and **Esc** (or **Clear** in the toolbar) removes them all; **Esc** with nothing to clear, or **R** again, switches the ruler off. Measurements aren't saved and don't affect grades; changing image clears them.
