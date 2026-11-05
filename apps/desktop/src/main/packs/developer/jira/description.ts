import { acceptanceCriteriaOf, type Item } from "@eo/core";

/**
 * How an item's text looks in Jira, and how to read it back.
 *
 * Both directions live here because they have to agree, and they did
 * not. `pushStories` appends a story's acceptance criteria to the
 * description it creates; the pull compared that description against
 * `item.body`, which never had them. So every sync saw a description
 * "edited in Jira" and copied the whole thing into the body — where the
 * item screen then showed the criteria twice, once as prose and once
 * as the acceptance-criteria list they were rendered from.
 */

const HEADING = "Acceptance criteria:";

/** Jira's line endings are not EO's, and a `\r` is not an edit. */
function normalise(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** An item's body and criteria as the single description EO writes into Jira. */
export function toJiraDescription(item: Item): string {
  const body = normalise(item.body ?? "").trim();
  const criteria = acceptanceCriteriaOf(item);
  const listed = criteria.length > 0 ? `\n\n${HEADING}\n${criteria.map((line) => `- ${line}`).join("\n")}` : "";
  return `${body}${listed}`.trim();
}

export interface SplitDescription {
  /** The description with the criteria block taken back off. */
  body: string;
  /** What that block listed — empty when there was no block to read. */
  criteria: string[];
}

/**
 * A Jira description split back into the two things EO put in it.
 *
 * Conservative on purpose: only a block EO would have written comes off
 * — the heading alone on a line, at the very end, followed by nothing
 * but `- ` items. A description where someone discusses acceptance
 * criteria in a paragraph comes back untouched, because guessing wrong
 * here means eating what they wrote.
 */
export function splitJiraDescription(description: string): SplitDescription {
  const text = normalise(description);
  const whole: SplitDescription = { body: text.trim(), criteria: [] };

  const lines = text.split("\n");
  let heading = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.trim() === HEADING) {
      heading = index;
      break;
    }
  }
  if (heading === -1) return whole;

  const criteria: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    // Prose under the heading means this is someone's own section, not
    // the list EO rendered. Leave the description whole.
    if (!trimmed.startsWith("- ")) return whole;
    criteria.push(trimmed.slice(2).trim());
  }
  // A bare heading with nothing under it is not a block EO wrote either.
  if (criteria.length === 0) return whole;

  return { body: lines.slice(0, heading).join("\n").trim(), criteria };
}
