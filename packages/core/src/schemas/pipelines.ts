import { z } from "zod";

/** How a result is drawn — the dot on its edge, and the button on the item. */
export const ResultToneSchema = z.enum(["success", "warning", "info", "danger"]);
export type ResultTone = z.infer<typeof ResultToneSchema>;

/**
 * One of the answers a person may give on a human step (EO-310, ARCHITECTURE.md, "A step").
 *
 * An agent step needs nothing like this: an agent's verdict is whatever
 * its prompt asks for, and a builtin or a module declares its results in
 * the registry or in its manifest. A person declares nothing anywhere —
 * so until this existed there was no such thing as a result *for* a
 * human, and the only gesture available was a drag, which bypasses
 * routing entirely (ARCHITECTURE.md, "Results and routes").
 *
 * The routes are still where a result *goes*. This says what a person is
 * being offered and how the offer reads, which a route cannot: a route
 * is an edge on a graph, and "Send back" needing the reason typed before
 * it can be taken is a property of the decision rather than of the edge.
 *
 * A schema rather than a bare interface for `StepInputs`' reason: the
 * column is JSON, so what comes back off a row is `unknown` until
 * something parses it, and a blob that is not a list of results is not a
 * decision EO can offer anybody.
 */
export const StepResultSchema = z.object({
  /** What `items:decide` is called with, and what a route out of this step names. */
  key: z.string().min(1),
  /** The button: "Approve", "Send back". */
  label: z.string().min(1),
  /** How the button is drawn, and the dot beside its route. */
  tone: ResultToneSchema.default("info"),
  /**
   * Refuse the decision unless the person says why (the original design).
   *
   * "A non-approving result requires a comment, which is how the reason
   * travels to the next step" (the original design). Data rather than a rule derived
   * from the tone, because which results need a reason is a decision the
   * person drawing the pipeline makes: an approval that has to be
   * justified is a legitimate thing to ask for, and a warning-toned
   * result that needs no words is one too.
   */
  requiresComment: z.boolean().default(false),
});

export type StepResult = z.infer<typeof StepResultSchema>;

/** The whole of a step's declared results, as the column stores them. */
export const StepResultsSchema = z.array(StepResultSchema);

/**
 * The names a pipeline's icon can carry (`pipelines.icon`).
 *
 * The glyphs both rails draw (`renderer/src/shared/layout/sidebar.ts`),
 * named here so a help-chat draft that changes a pipeline's icon (EO-520)
 * is held to a name the rail can draw, rather than one that falls back
 * to the pipeline's position without anybody saying so.
 */
export const PIPELINE_ICON_NAMES = ["square-stack", "boxes", "database", "monitor", "workflow"] as const;
export const PipelineIconSchema = z.enum(PIPELINE_ICON_NAMES);
export type PipelineIcon = z.infer<typeof PipelineIconSchema>;
