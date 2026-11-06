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
}

export interface GradeState {
  groups: Record<string, Group>;
  pinGroup: Record<string, string>;
  /** Ambiguous pins that the grader assigned to a question by grading them. */
  assign: Record<string, number>;
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
