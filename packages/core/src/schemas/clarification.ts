import { z } from "zod";

/**
 * An agent saying it cannot proceed, and what it needs (KAN-29).
 *
 * Asking used to be an *action*: the agent posted a blocking comment
 * through the MCP tool and its run ended mid-turn. That made the agent
 * the one deciding when the conversation resumed, and EO's only trigger
 * was "a human replied to something on this item" — so three questions
 * answered once looked exactly like three questions answered.
 *
 * Asking is a *result* now. The run finishes normally, the engine posts
 * the questions, and nothing resumes until every one of them has an
 * answer. The agent no longer writes comments; the code does. Invariant
 * 4 is unchanged and more literal for it — comments are still the only
 * channel, and now the channel has one owner.
 */

export const ClarificationQuestionSchema = z.object({
  /**
   * The agent's own handle for this question.
   *
   * Not used to match answers — an answer is a reply, and the comment
   * tree already says what it replies to. It exists so a re-prompted or
   * resumed agent can refer to "the first question" and mean something
   * stable, and so a repeated question is recognisable as repeated.
   */
  id: z.string().min(1),
  /** What a human reads. One question — not three joined by "and". */
  question: z.string().min(1),
  /**
   * What this blocks.
   *
   * Required, because it is the field that makes a question answerable
   * by someone who is not already holding the agent's context, and
   * because an agent that cannot say why it is asking usually did not
   * need to.
   */
  why: z.string().min(1),
  /**
   * Suggested answers. `comments.options` already carries these end to
   * end and the UI already renders them, so a question with options is
   * a click rather than an essay.
   */
  options: z.array(z.string()).default([]),
  /** Whether an answer has to be one of `options`. Advisory to the UI, not enforced here. */
  allow_free_text: z.boolean().default(true),
});

/**
 * Questions go to a human. There is no field naming who to ask.
 *
 * The comment tool let an agent `@`-mention *another agent*, and
 * `MENTION_DEPTH_CAP` exists because A→B→A is a loop that spends money.
 * Dropped here deliberately, on the evidence: no prompt has ever asked
 * an agent to do it, and across every real run on this machine there is
 * exactly one agent-targeted mention — written by a human
 * (`@reviewer I don't see any PR or commit`).
 *
 * That direction is untouched. A human mentioning an agent goes through
 * `comments:post` from the UI, not through the tool, so it survives the
 * tool being turned off; `findPendingResponses` and the depth cap stay
 * exactly as they are to serve it.
 *
 * If agent-to-agent asking is ever wanted, it comes back as a field on a
 * question rather than as a capability smuggled in through a comment.
 */
export const ClarificationRequiredSchema = z.object({
  status: z.literal("clarification_required"),
  /** At least one: a result that says it is blocked and names nothing is not a question, it is a shrug. */
  questions: z.array(ClarificationQuestionSchema).min(1),
});

export type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>;
export type ClarificationRequired = z.infer<typeof ClarificationRequiredSchema>;

/**
 * The wrapper the schema asks for, unwrapped.
 *
 * `outputSchemaFor` nests the answer-or-question union under `outcome`,
 * because the API refuses a union at the top level of a tool's input
 * schema. That wrapper is a transport detail of one provider's
 * constrained generation, so it is removed here and nothing downstream
 * ever sees it.
 *
 * A result that arrives without the wrapper is passed through untouched:
 * a provider with no native structured output, or an older agent, still
 * returns the bare shape and is still right.
 */
export function unwrapOutcome(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  // Only when `outcome` is the whole of it. A result that happens to
  // carry an `outcome` field of its own alongside other keys is its own
  // answer, not a wrapper.
  return keys.length === 1 && keys[0] === "outcome" ? record["outcome"] : raw;
}

/**
 * A result that arrived as text rather than as an object.
 *
 * Not every action has a schema — invariant 7 means a pipeline can
 * define one this codebase never heard of, and `intake` is such an
 * action today. With no schema there is no constrained generation, so a
 * provider hands back the model's own text, and a model asked for JSON
 * returns it in a ```json fence.
 *
 * This is *not* the "never parse prose" line being crossed. Nothing here
 * reads meaning out of English: it attempts a strict JSON parse and then
 * strict schema validation, and if either fails the original value is
 * returned untouched and nothing happens. What it prevents is the
 * opposite failure, seen in a real run — a product owner returned five
 * well-formed questions in a fence, EO saw a string, called the run a
 * success, and advanced the item past the agent that was asking.
 *
 * The durable fix is for every action to have a schema, so generation is
 * constrained and this never arises. Until then this is the safety net.
 */
export function parseIfFenced(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;

  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
  if (!unfenced.startsWith("{")) return raw;

  try {
    return JSON.parse(unfenced);
  } catch {
    return raw; // not JSON after all, so it was only ever text
  }
}

/**
 * Is this result an agent asking rather than answering?
 *
 * Checked against the *raw* result and before the action's own schema,
 * because a clarification is deliberately nothing like the shape the
 * action would otherwise return — it would fail that validation, and
 * failing is not what it means.
 */
export function asClarification(raw: unknown): ClarificationRequired | null {
  const parsed = ClarificationRequiredSchema.safeParse(unwrapOutcome(parseIfFenced(raw)));
  return parsed.success ? parsed.data : null;
}
