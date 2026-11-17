import { COMMENT_KINDS, isCommentKind } from "@eo/core";
import type { ItemTypeEntry, PipelineStep } from "@eo/core";

/** One refusal of a declared brief, on the step that declares it. */
export interface BriefProblem {
  stepId: string;
  message: string;
}

/**
 * What is wrong with the briefs these steps declare (EO-827,
 * ARCHITECTURE.md, "The decision's brief"), each as a sentence naming the
 * step and the name it could not find.
 *
 * Data in, data out (invariant 2): the steps are the pipeline's own, and
 * the item types are the ones its project has, so a field is judged
 * against what an item here can carry. A step named by an output part has
 * to be one of these steps, and a comment kind one EO has. Only a `user`
 * step may declare a brief, since only a person's decision has a bar to
 * show it on.
 */
export function briefProblems(
  steps: readonly Pick<PipelineStep, "id" | "name" | "type" | "brief">[],
  itemTypes: ReadonlyMap<string, Pick<ItemTypeEntry, "specShape">>,
): BriefProblem[] {
  const ids = new Set(steps.map((step) => step.id));
  const problems: BriefProblem[] = [];
  for (const step of steps) {
    // Absent as well as null: a step built before briefs declares none.
    if (step.brief === null || step.brief === undefined || step.brief.length === 0) continue;
    const on = `The brief on "${step.name}"`;
    if (step.type !== "user") {
      problems.push({ stepId: step.id, message: `${on} cannot be shown: only a step a person decides on has a decision to brief.` });
      continue;
    }
    for (const part of step.brief) {
      if (part.show === "output" && !ids.has(part.step)) {
        problems.push({ stepId: step.id, message: `${on} shows the output of "${part.step}", a step this pipeline does not have.` });
      }
      if (part.show === "comment") {
        if (part.kind === undefined && part.role === undefined) {
          problems.push({ stepId: step.id, message: `${on} shows a comment without saying which kind or whose.` });
        } else if (part.kind !== undefined && !isCommentKind(part.kind)) {
          problems.push({ stepId: step.id, message: `${on} shows the newest "${part.kind}" comment, which is not a kind of comment: use one of ${COMMENT_KINDS.join(", ")}.` });
        }
      }
      // An own property only: `in` would also find `constructor` or `toString` on every object.
      if (part.show === "field" && ![...itemTypes.values()].some((type) => Object.hasOwn(type.specShape.properties, part.field))) {
        problems.push({ stepId: step.id, message: `${on} shows the field "${part.field}", which no item type on this project declares.` });
      }
    }
  }
  return problems;
}
