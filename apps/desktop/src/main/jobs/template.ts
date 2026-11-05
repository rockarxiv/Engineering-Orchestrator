import { JOB_TEMPLATE_BLANKS } from "@eo/core";
import { formatDateKey } from "../dateUtils.js";

/**
 * What `{{date}}` and `{{job}}` expand to in a job's template (EO-304,
 * `ARCHITECTURE.md`, "Jobs").
 *
 * Two blanks and no expression language. A template is a title and a
 * body a person wrote, and the moment it can compute is the moment it
 * has to be sandboxed, diagnosed and explained when it goes wrong. What
 * a recurring item actually needs is to say *which* occurrence it is,
 * which is the date, and which job made it, which is the name.
 */

export interface TemplateBlanks {
  /** The occurrence this item is for — not the moment the item was written. */
  dueAt: number;
  /** The job's name. */
  job: string;
}

/**
 * Fills the blanks, leaving anything else exactly as it was typed.
 *
 * An unknown blank is *not* an error and is not emptied: `{{owner}}` in
 * a title stays `{{owner}}`, so a person who mistyped sees what they
 * typed on the item and can fix the template, rather than finding a
 * title with a hole in it and no way to tell what was meant.
 *
 * The date is the occurrence's local calendar day, from `formatDateKey`
 * — the same "YYYY-MM-DD" the cost screens use, so a person reading two
 * of EO's dates side by side reads one format. Time zone is the
 * schedule's question and is the next story's.
 */
export function fillTemplate(text: string, blanks: TemplateBlanks): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, blank: string) => {
    const fill = FILLERS[blank as JobTemplateBlank];
    return fill === undefined ? whole : fill(blanks);
  });
}

type JobTemplateBlank = (typeof JOB_TEMPLATE_BLANKS)[number];

/**
 * What each blank is worth, keyed by the same constant the Job page's
 * help text is drawn from — so a blank the screen offers and this table
 * does not stops compiling rather than expanding to itself.
 */
const FILLERS: Record<JobTemplateBlank, (blanks: TemplateBlanks) => string> = {
  date: (blanks) => formatDateKey(blanks.dueAt),
  job: (blanks) => blanks.job,
};
