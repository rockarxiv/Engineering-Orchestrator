/**
 * Passages of an agent's instructions written for it answering a step
 * alone (EO-888), and what a team member is sent instead.
 *
 * A kind's prompt is written for the agent that answers the step: a
 * reviewer's says to read the whole change, every file in the diff, and
 * to give one verdict. A member of a team on that step answers one
 * assignment with a report, and those rules would have it do a whole
 * review's reading on every member. So a prompt marks them, each passage
 * between a line `<!-- alone -->` and a line `<!-- /alone -->`, and a
 * member is sent its instructions without the passages. The agent
 * answering the step alone is sent its instructions as they are, markers
 * and all, as every dispatch sends them: an HTML comment is the form the
 * prompt's own version line already takes.
 *
 * Keyed on the marker, never on a kind or a pack (invariant 13): any
 * agent's instructions may carry one, a person's own included, and
 * instructions with none are a member's whole.
 */

export const ALONE_START = "<!-- alone -->";
export const ALONE_END = "<!-- /alone -->";

/**
 * The instructions without every passage marked as for answering alone,
 * markers included. A start with no end after it marks nothing: only its
 * own line goes, so a marker a person left unclosed never takes the rest
 * of their instructions with it.
 */
export function withoutAnsweringAlone(instructions: string): string {
  const lines = instructions.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === ALONE_END) continue;
    if (line.trim() !== ALONE_START) {
      kept.push(line);
      continue;
    }
    const end = lines.findIndex((candidate, at) => at > index && candidate.trim() === ALONE_END);
    if (end !== -1) index = end;
  }
  return kept.join("\n");
}
