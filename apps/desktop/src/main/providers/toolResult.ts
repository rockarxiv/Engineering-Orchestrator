/**
 * What a tool call returned, on its way into `run_events` (EO-169).
 *
 * Both adapters record a call. Only one of them used to record the
 * answer, so the same work read as a transcript you could reason about
 * or one you could not, depending on which agent happened to run it.
 * This file is the shared half of fixing that: the bound every backend's
 * result passes through, and the two decisions that bound exists inside
 * of. It is deliberately one file rather than a helper in each adapter —
 * a rule about what may enter the log, written twice, is a rule that
 * will be edited once.
 *
 * ── Decision 1: results are bounded, keeping the tail ──
 *
 * `run_events` is the biggest thing in the database and it is
 * append-only (invariant #3), so nothing recorded here can ever be
 * trimmed back out. Results are the largest thing a turn produces — a
 * recursive grep over this repository is thousands of lines and an agent
 * can make dozens of such calls in a turn — so recording them unbounded
 * would not add to the log's size, it would change its growth curve, in
 * the one table crash recovery depends on being able to read back.
 *
 * The tail is kept rather than the head, which is what EO already does
 * with the output of a check command (`process/runCommand.ts`) and for
 * the same reason: a failing suite prints what broke at the end, a
 * command prints its error last, and a search's last hits are no less
 * its answer than its first. The omission is marked in the same words,
 * so a person who has seen one recognises the other.
 *
 * On the size: the check-command cap is 20 000 characters and is spent a
 * handful of times per run. This one is spent per *call*, thousands of
 * times, so it is set an order of magnitude lower. At 4 000 a repository
 * intelligence answer, a listing, or the tail of a failing suite arrives
 * whole, while a runaway grep loses two orders of magnitude. The honest
 * worst case is ten thousand calls all at the cap, which is 40 MB; the
 * realistic case is a few hundred characters a call, because most tool
 * results are small. If the log grows faster than that reasoning
 * predicts, this constant is the dial.
 *
 * ── Decision 2: results are recorded whatever the tool was, including
 * ones that carry source ──
 *
 * Repository intelligence is built on "paths and counts, never bodies":
 * nothing a third-party tool printed may reach a log, an event payload
 * or an error message (`repositoryIntelligence/`, whose provider keeps
 * that rule, and `sayable.ts` for the guard that enforces it). A file
 * read's result *is* file content and a search's result is excerpts of
 * it, so this story had to answer that rule rather than walk past it. It
 * is answered, and the answer is that the rule is about EO's own voice:
 *
 *   - What that rule defends against, in its own words, is "a tool that
 *     quotes the line it choked on" putting that line "in a comment on
 *     somebody's item". Its subject is EO relaying somebody else's
 *     words as EO's own sentence, to a person who did not ask for them.
 *     A `tool_result` row asserts nothing and addresses nobody: it says
 *     what the agent was handed, which is the fact the transcript exists
 *     to hold.
 *   - The event log already carries source and always has. An agent's
 *     prose quotes files, diffs and greps in every run, and it is
 *     recorded verbatim as `output`; a `result` payload carries whatever
 *     the agent chose to return. A reading of the rule under which
 *     `run_events` may hold no source content was already false of every
 *     run EO has ever done, which is good evidence it was never the
 *     rule.
 *   - The alternative — record results only for tools that cannot return
 *     source — excludes precisely the call this story was written about.
 *     What cost a person an afternoon was not knowing what a *repository
 *     intelligence* query returned, and that answer is excerpts of
 *     source by construction. A rule that omits its own motivating case
 *     is the wrong rule.
 *
 * What does not change: the repository intelligence port still composes
 * its own sentences out of paths and counts, and `sayable()` still holds
 * the line for everything EO says on an item. This adds nothing to what
 * EO says. It adds what the agent was told.
 *
 * What this costs, said out loud rather than discovered later: an agent
 * that prints a secret into its own tool output now puts it in the log —
 * as it already does when it prints one into its prose. Nothing here
 * redacts, and nothing here pretends to; a guard claiming to recognise
 * somebody's source or somebody's key would be worse than none, which is
 * the argument `sayable.ts` already makes. EO's own key still reaches
 * the child's environment and nowhere else (EO-84): what an agent
 * chooses to print is the agent's doing, and the transcript's job is to
 * say so rather than to hide it.
 */

import type { ToolResultEvent } from "@eo/core";

/**
 * How much of one tool result is kept. See decision 1 above — this is
 * the dial that decision names.
 */
export const MAX_TOOL_RESULT_CHARS = 4_000;

/**
 * The tail of a result, and whether keeping it dropped anything.
 *
 * The marker is `runCommand.ts`'s, word for word, because it is the same
 * statement about the same kind of loss.
 */
export function boundToolOutput(text: string, maxChars: number = MAX_TOOL_RESULT_CHARS): { output: string; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return { output: trimmed, truncated: false };
  const omitted = trimmed.length - maxChars;
  return { output: `[... ${omitted} earlier characters omitted ...]\n${trimmed.slice(omitted)}`, truncated: true };
}

/**
 * A block of content as text, whoever sent it.
 *
 * Both backends hand results over in the same shape — the Model Context
 * Protocol's content blocks, which the Anthropic Messages API also uses
 * for a `tool_result` — so one reader serves both. Narrowed from
 * `unknown` rather than typed against either SDK: this is the one place
 * the two meet, and it should not have to pick whose declaration to
 * believe.
 *
 * A block that is not text is named rather than rendered. An image or an
 * embedded resource arrives base64-encoded and would be megabytes of
 * unreadable payload in a table this file exists to keep small, so the
 * log says which kind of thing the agent was shown and stops there.
 */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block): string => {
      if (typeof block === "string") return block;
      if (typeof block !== "object" || block === null) return "";
      const { type, text } = block as { type?: unknown; text?: unknown };
      if (typeof text === "string") return text;
      return typeof type === "string" ? `[${type}]` : "";
    })
    .filter((part) => part !== "")
    .join("\n");
}

/**
 * One result event, bounded.
 *
 * The single constructor both adapters go through, so that "recorded"
 * means the same thing on either backend rather than nearly the same
 * thing twice — which is the divergence this story is about, and it
 * would come back the first time one adapter was edited alone.
 */
export function toolResultEvent(fields: {
  name?: string;
  callId?: string;
  ok: boolean;
  output: string;
  status?: string;
  exitCode?: number;
}): ToolResultEvent {
  const { output, truncated } = boundToolOutput(fields.output);
  return {
    type: "tool_result",
    // Spread rather than assigned: an absent field and a field holding
    // `undefined` are the same to TypeScript and different to
    // `JSON.stringify`, and these are persisted as JSON.
    ...(fields.name === undefined ? {} : { name: fields.name }),
    ...(fields.callId === undefined ? {} : { callId: fields.callId }),
    ok: fields.ok,
    output,
    truncated,
    ...(fields.status === undefined ? {} : { status: fields.status }),
    ...(fields.exitCode === undefined ? {} : { exitCode: fields.exitCode }),
  };
}
