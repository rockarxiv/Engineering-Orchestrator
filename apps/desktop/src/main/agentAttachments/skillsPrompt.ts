/**
 * The Skills section a turn that opens a thread starts with, on either
 * backend (EO-602).
 *
 * Codex had it from EO-207; Claude offered its skills only through the
 * Skill tool's list, under a long system prompt, and in EO-597 an
 * Implementer with a skill attached never once looked at it. So both
 * backends render the section here, with one choosing rule and one
 * wording, and differ only in the sentence saying how a skill is opened —
 * reading its file on Codex, the Skill tool on Claude.
 */

/** One skill as the model chooses it: the name it opens it by, and what it is for. */
export interface OfferedSkill {
  name: string;
  description: string;
}

/**
 * A description on one line.
 *
 * The prompt lists one skill per line, and a description is free text a
 * person typed — a newline in one would end the bullet and turn the rest
 * of it into prose the model reads as instructions rather than as a
 * choice. Collapsed rather than truncated: the whole description is what
 * the model decides on, and cutting it short is cutting the thing that
 * makes the choice possible.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The section, or an empty string when there is nothing to choose
 * between — no heading with nothing under it. The caller has already
 * left out every skill whose model invocation is disabled.
 *
 * `howToOpen` is the backend's own sentence, ending "and follow it;".
 */
export function skillsPromptSection(offered: readonly OfferedSkill[], howToOpen: string): string {
  if (offered.length === 0) return "";
  return [
    "## Skills",
    "",
    "EO has given you some skills.",
    "Here is what each one is for:",
    "",
    ...offered.map((skill) => `- \`${skill.name}\` — ${oneLine(skill.description)}`),
    "",
    `Pick from those descriptions. ${howToOpen}`,
    "it may point you at other files in the same folder, which you read as it asks for them.",
    "Skip this entirely when none of them applies — they are here to be used when they fit, not to be read through first.",
  ].join("\n");
}

/**
 * The prompt a turn that opens a thread sends: its context, then the
 * section when there is one. One function for both adapters and for
 * debug mode's record of what they sent, so the three cannot disagree.
 */
export function withSkillsSection(context: string, section: string): string {
  return section ? `${context}\n\n${section}` : context;
}
