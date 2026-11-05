import { z } from "zod";
import { DiscussionQuestionSchema } from "./discussion.js";
import { ModuleChangeSchema } from "./moduleChange.js";

/**
 * What the system agent returns from `scenario` — a turn of the chat a
 * module page's "+ Add scenario" opens (EO-356).
 *
 * The room is about one module. A person describes a scenario in their
 * own words, and the agent writes it as a test case, saves it and runs
 * the module's tests through `eo_admin` — so by the time a turn returns,
 * the case and the run already exist, and this shape is what the turn
 * *says* about them rather than a way of making them.
 *
 * Three things here are more than a message, and each is what lets EO
 * check or gate something rather than take the agent's prose for it:
 *
 *   * `testId` names the case the turn is reporting on, so EO can put
 *     that case's stored result and the module's coverage beside the
 *     reply — read from the run the agent made, not from its account of
 *     it (invariant #5).
 *   * `diagnosis` is the evidence for a failing case that EO cannot
 *     derive itself: which `ctx.exec` calls the case scripted and which
 *     the module made, and which lines of the module are involved. EO
 *     quotes those lines out of the module's own code, so a line number
 *     the agent got wrong shows the wrong line rather than an invented
 *     one.
 *   * `change` is a fix to the module, **proposed and never applied**.
 *     The agent cannot save one through this shape, and EO saves nothing
 *     until the person presses Apply on the card it becomes. It is the
 *     shape the help chat's change has too (`ModuleChangeSchema`,
 *     EO-418): the whole code, and the whole manifest when the fix needs
 *     one.
 *
 * A question and a change in one turn are refused for the reason every
 * other room refuses a proposal resting on an unanswered question.
 *
 * **Null rather than absent, on purpose (invariant #12).** Codex is held
 * to OpenAI's strict subset, where every property is required —
 * `strictCodexOutputSchema` makes it so — so an *optional* `change`
 * would be a change the model has to write on every turn, and an
 * optional `diagnosis` a diagnosis of a case that passed. Nullable with
 * a default says "none" in a way both backends can: Claude may leave the
 * key out, Codex writes `null`.
 */

/** One `ctx.exec` call written as a command line — `gh pr checks 12`. */
const ExecCallSchema = z.string().min(1);

/** A run of the module's lines, 1-based and inclusive, as the turn's prompt numbered them. */
export const ScenarioLineRangeSchema = z.object({
  from: z.number().int().min(1),
  to: z.number().int().min(1),
});

/** The evidence for a failing case that only the agent can gather. */
export const ScenarioDiagnosisSchema = z.object({
  /** Every call the case's `exec` fixture scripted, in the order it scripted them. */
  scripted: z.array(ExecCallSchema).max(40),
  /** Every call the module actually made during the case, in order. */
  made: z.array(ExecCallSchema).max(40),
  /** The lines of the module's code the failure involves. EO quotes them from the code itself. */
  lines: z.array(ScenarioLineRangeSchema).min(1).max(6),
});

/**
 * A fix to the module, for the person to apply or not: its code and,
 * when the fix needs it, its manifest. The one change shape both chats
 * share (EO-418), under the name this room has always called it by.
 */
export const ScenarioModuleChangeSchema = ModuleChangeSchema;

export const ScenarioOutputSchema = z
  .object({
    /** What the agent says back, in markdown. Always present. */
    message: z.string().min(1),
    /**
     * Decisions to put to the person, asked at once — the discussion's
     * card. "Is the test wrong or is the module wrong?" is the question
     * this room exists to ask after a failure.
     */
    questions: z.array(DiscussionQuestionSchema).max(6).default([]),
    /** The id of the test case this turn wrote, edited or ran and is reporting on. Null on a turn that only asked. */
    testId: z.string().min(1).nullable().default(null),
    /** The evidence, when that case failed. */
    diagnosis: ScenarioDiagnosisSchema.nullable().default(null),
    /** A fix to the module, only when the person asked for one. Shown, never saved. */
    change: ScenarioModuleChangeSchema.nullable().default(null),
  })
  .refine((output) => output.diagnosis === null || output.testId !== null, {
    message: "a diagnosis is about a test case, so name it in `testId`",
    path: ["testId"],
  })
  .refine((output) => output.questions.length === 0 || output.change === null, {
    message: "a turn either asks or proposes a change — a change built on unanswered questions is a guess with a button on it",
  });

export type ScenarioOutput = z.infer<typeof ScenarioOutputSchema>;
/** A `scenario` result as an agent may write it, before the defaults are filled in — a change with no `manifest` key included. */
export type ScenarioReply = z.input<typeof ScenarioOutputSchema>;
export type ScenarioDiagnosis = z.infer<typeof ScenarioDiagnosisSchema>;
export type ScenarioModuleChange = z.infer<typeof ScenarioModuleChangeSchema>;
