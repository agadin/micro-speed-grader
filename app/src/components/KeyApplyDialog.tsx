import { useMemo, useState } from "react";
import type { Session } from "../lib/types";
import { useStore } from "../lib/store";
import { applyPlan, emptyKey, planKey, type KeyLevel, type KeyPlan } from "../lib/answerKey";
import { Modal } from "./Modal";

/** the choices, least reach first, in two groups */
const CHOICES: { level: KeyLevel; group: "keep" | "change"; title: string; detail: string }[] = [
  { level: 0, group: "keep", title: "Only new submissions", detail: "Change nothing now. Pins added later with Rescan submissions are graded by the key." },
  { level: 1, group: "keep", title: "Ungraded pins", detail: "Grade pins nobody has graded yet, and new submissions." },
  { level: 2, group: "change", title: "…and the key's earlier grades", detail: "Also redo pins the key graded before, e.g. after moving or deleting an area." },
  { level: 3, group: "change", title: "…and other graders' grades, but keep mine", detail: "Also replace grades from hand-off graders. Grades you gave yourself stay." },
  { level: 4, group: "change", title: "Everything, including my own grades", detail: "The key is the final word on every pin in an area." },
];

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/** After the key is created or changed: what should it apply to? */
export function KeyApplyDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const applyGrades = useStore((s) => s.applyGrades);
  const setKey = useStore((s) => s.setKey);
  const key = session.key ?? emptyKey();
  const plans = useMemo(() => CHOICES.map((c) => planKey(session, key, c.level)), [session, key]);
  // default: the smallest choice that does something now
  const [level, setLevel] = useState<KeyLevel>(plans[1].grade.length || plans[1].clear.length ? 1 : 0);
  const suggestOnly = key.mode === "suggest";

  const describe = (p: KeyPlan, lv: KeyLevel) => {
    if (lv === 0) return "nothing now";
    const changes = p.grade.length + p.clear.length;
    if (!changes) return "no changes";
    const parts = [n(p.grade.length, "pin")];
    if (p.replaces) parts.push(`replaces ${n(p.replaces, "grade")}`);
    if (p.clear.length) parts.push(`ungrades ${p.clear.length}`);
    return parts.join(" · ");
  };

  const apply = () => {
    setKey({ ...key, autoNew: true });
    if (level > 0) applyGrades(applyPlan(session, plans[level]));
    onClose();
  };

  const right = plans[level].grade.filter((x) => x.mark.kind === "correct").length;
  const wrong = plans[level].grade.length - right;

  return (
    <Modal className="key-apply-modal" help="answer-key/apply-the-key" onClose={onClose}>
      <h2>Apply the answer key</h2>
      {suggestOnly ? (
        <>
          <p className="muted">
            The key is set to <b>Suggest only</b>: nothing is graded automatically. While you grade, clusters that land in an
            area show what the key says, and <b>K</b> accepts it.
          </p>
          <div className="modal-actions">
            <div className="grow" />
            <button className="primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small">
            Pins that land in an area get its grade, shown as graded by <b>Answer key</b> in the ledger. Pins in no area, or in
            areas that disagree, are left for you. Applying is one step you can undo with ⌘Z.
          </p>
          {(["keep", "change"] as const).map((grp) => (
            <fieldset key={grp} className="ka-group">
              <legend>{grp === "keep" ? "Leave existing grades alone" : "Also change grades already given"}</legend>
              {CHOICES.filter((c) => c.group === grp).map((c) => (
                <label key={c.level} className={`ka-choice${level === c.level ? " on" : ""}`}>
                  <input type="radio" name="key-level" checked={level === c.level} onChange={() => setLevel(c.level)} />
                  <span className="ka-text">
                    <b>{c.title}</b>
                    <span className="muted small">{c.detail}</span>
                  </span>
                  <span className={`ka-count${plans[c.level].grade.length + plans[c.level].clear.length ? "" : " zero"}`}>{describe(plans[c.level], c.level)}</span>
                </label>
              ))}
            </fieldset>
          ))}
          <p className="ka-sum small">
            {level === 0
              ? "Nothing changes now."
              : `${n(plans[level].grade.length, "pin")} will be graded (${right} correct, ${wrong} wrong).`}{" "}
            {plans[1].unmatched > 0 && `${n(plans[1].unmatched, "ungraded pin")} land${plans[1].unmatched === 1 ? "s" : ""} in no area and stay${plans[1].unmatched === 1 ? "s" : ""} for you.`}{" "}
            {plans[level].conflicts > 0 && `${n(plans[level].conflicts, "pin")} in areas that disagree ${plans[level].conflicts === 1 ? "is" : "are"} left for you.`}
          </p>
          <div className="modal-actions">
            <button onClick={onClose}>Not now</button>
            <div className="grow" />
            <button className="primary" onClick={apply}>
              {level === 0 ? "Save for new submissions" : `Grade ${n(plans[level].grade.length + plans[level].clear.length, "pin")}`}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
