import type { Check, GuestPack, Handoff } from "./handoff";
import type { AnswerKey } from "./answerKey";
import type { TimeEvent } from "./timing";
export interface Question {
  num: number;
  /** Slide ids (e.g. "VMS146") the student may answer on. */
  slides: string[];
  prompt: string;
  include: boolean;
}

export interface Student {
  id: string;
  name: string;
  folder: string;
}

export interface Pin {
  id: string;
  studentId: string;
  /** Slide id, e.g. "VMS146" */
  slide: string;
  rawTitle: string;
  details: string;
  /** Question this pin was matched to from its title (or inferred), null if ambiguous. */
  q: number | null;
  /** When q is null: questions on this slide it could belong to. */
  candidates: number[];
  /** True if the question number was not read cleanly from the title. */
  titleGuessed: boolean;
  /** Position in nanometres, in NDP.view slide coordinates (relative to slide centre). */
  xNm: number;
  yNm: number;
  annotationType: string;
  /** brought back from Changed submissions after it left the files: kept even though the files no longer have it */
  restored?: boolean;
}

/**
 * A pin that is no longer in the student's files (found by Rescan submissions). It doesn't count as
 * the student's answer any more, but it keeps the grade it had, so the grade can be carried over to
 * the student's new pin, or the pin restored.
 */
export interface RetiredPin {
  pin: Pin;
  /** the question it answered (from its title, inference or a grader's assignment) */
  q: number | null;
  /** its grade when it was retired */
  grade?: { taskId: string; status: GradeStatus; text: string; by?: string; createdAt: number };
  retiredAt: number;
  /** the student's new pin for the same question that came in when this one went */
  replacedBy?: string;
  /** still waiting in Changed submissions */
  review?: boolean;
}

export type GradeStatus = "correct" | "wrong";

/** One ledger entry: a set of pins graded together with one status + text. */
export interface Group {
  id: string;
  taskId: string;
  status: GradeStatus;
  text: string;
  pinIds: string[];
  createdAt: number;
  /** who gave this grade: a hand-off grader's name, or several joined with " & " when they agreed; absent = you */
  by?: string;
}

export interface GradeState {
  groups: Record<string, Group>;
  pinGroup: Record<string, string>;
  /** Ambiguous pins that the grader assigned to a question by grading them. */
  assign: Record<string, number>;
  /** pins graded twice (hand-off overlap): each grader's verdict and whether they agree */
  checks?: Record<string, Check>;
}

export interface SlideRef {
  id: string;
  path: string;
}

export interface Session {
  version: 1;
  name: string;
  createdAt: number;
  savedAt: number;
  sessionPath: string;
  submissionsDir: string;
  slidesDir: string;
  questions: Question[];
  students: Student[];
  pins: Pin[];
  slides: SlideRef[];
  grades: GradeState;
  taskIndex: number;
  /** host: packs of work sent to other graders */
  handoffs?: Handoff[];
  /** guest: this session was opened from a hand-off pack */
  guestPack?: GuestPack;
  /** files whose slide the instructor chose in "Things to check" (path in the submissions folder → slide ID) */
  fileSlides?: Record<string, string>;
  /** how pin titles were matched to questions when the submissions were read (default DEFAULT_READING_RULES) */
  readingRules?: ReadingRules;
  /** "Things to check" the instructor acknowledged (problemKey), so a rescan only shows new ones */
  scanAck?: string[];
  /** time spent grading: one entry per grading action (shown only on export) */
  timeLog?: TimeEvent[];
  /** the instructor's answer key: painted areas that grade (or suggest) matching pins */
  key?: AnswerKey;
  /** pins that left the submission files (Rescan submissions), with the grades they had */
  retired?: RetiredPin[];
}

export interface Task {
  id: string;
  q: number;
  slide: string;
  slideIndex: number;
  slideCount: number;
}

export interface SlideInfo {
  id: number;
  path: string;
  width: number;
  height: number;
  mppX: number;
  mppY: number;
  xOffsetNm: number;
  yOffsetNm: number;
  tileSize: number;
  maxLevel: number;
}

export const emptyGrades = (): GradeState => ({ groups: {}, pinGroup: {}, assign: {} });

/** How the submissions are read into answers (Preferences ▸ Reading submissions; saved with each session). */
export interface ReadingRules {
  /** which NDP.view annotations count as an answer: pins only, pins and area shapes (circle, rectangle,
   *  outline), or everything (rulers, arrows and text notes too); a shape counts at its centre */
  count: "pins" | "shapes" | "all";
  /** a title that is just a number, or has one number that's a question on the slide ("3", "#3"), counts as that question */
  bareNumbers: boolean;
  /** a pin whose title names a question its slide isn't for: place it by the slide as usual, or leave it out */
  otherQuestion: "slide" | "omit";
  /** an unlabelled pin on a shared slide goes to the student's one remaining question there */
  leftover: boolean;
  /** a pin on a slide several questions use, whose title doesn't say which (after the leftover rule): show it
   *  on all of them (?), give it to the lowest-numbered one, or leave it out */
  unlabelled: "all" | "first" | "omit";
  /** a student with more than one pin for a question: marked wrong automatically, or left for the grader */
  multiple: "wrong" | "grade";
}
export const DEFAULT_READING_RULES: ReadingRules = { count: "shapes", bareNumbers: true, otherQuestion: "slide", leftover: true, unlabelled: "all", multiple: "wrong" };
/** sessions made before these settings existed read every annotation, so a rescan reads them as before */
export const LEGACY_READING_RULES: ReadingRules = { ...DEFAULT_READING_RULES, count: "all" };
export const sessionRules = (s: { readingRules?: Partial<ReadingRules> }): ReadingRules => ({ ...LEGACY_READING_RULES, ...(s.readingRules ?? {}) });
export const sameReadingRules = (a: ReadingRules, b: ReadingRules) =>
  (Object.keys(DEFAULT_READING_RULES) as (keyof ReadingRules)[]).every((k) => a[k] === b[k]);
/** a student's several pins for one question are marked wrong without the grader (the default) */
export const autoWrongDoubles = (s: { readingRules?: Partial<ReadingRules> }) => sessionRules(s).multiple !== "grade";
