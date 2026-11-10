/**
 * The YAML EO writes at the top of a `SKILL.md` (EO-105).
 *
 * Generated, never parsed as YAML: a skill's fields come out of SQLite,
 * and this turns them into the handful of lines the provider's binary
 * reads back. (`yamlUnquoted` reads back only a scalar this file wrote.) That direction is the whole reason a
 * YAML dependency is not wanted — writing this is ten lines, and
 * the design does not name one.
 *
 * The reason it cannot be a template string is that every value in it is
 * something a person typed. A display name with a colon in it ends the
 * key; one with a quote in it ends the scalar; one with a newline in it
 * ends the document and turns the rest of the name into a key of its
 * own. So every string is written as a double-quoted YAML scalar with
 * its escapes applied — one code path, no "does this one need quoting"
 * question to get wrong on the value that did.
 */

/**
 * A string as a double-quoted YAML scalar.
 *
 * Always quoted, even when nothing in it needs it. A rule that decides
 * per value is a rule with a wrong branch in it — `true`, `null`, `0755`
 * and `- ` are all strings that stop being strings unquoted — and the
 * cost of quoting a slug that never needed it is two characters.
 *
 * Double-quoted rather than single, because it is the only YAML style
 * with escapes: a single-quoted scalar cannot carry a newline as `\n`,
 * and a display name with one in it is exactly what this exists for.
 */
export function yamlQuoted(value: string): string {
  let quoted = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\\") quoted += "\\\\";
    else if (character === '"') quoted += '\\"';
    else if (character === "\n") quoted += "\\n";
    else if (character === "\r") quoted += "\\r";
    else if (character === "\t") quoted += "\\t";
    // The rest of C0, plus DEL. Legal in a YAML document only as an
    // escape, and unreadable either way — `\xNN` is what a reader can at
    // least recognise as something deliberate.
    else if (code < 0x20 || code === 0x7f) quoted += `\\x${code.toString(16).padStart(2, "0")}`;
    else quoted += character;
  }
  return `${quoted}"`;
}

/**
 * A scalar `yamlQuoted` wrote, read back, or null if it is not one.
 *
 * The one exception to "never parsed" above (EO-602): Claude's prompt
 * names each skill its generated directory holds, read off the files that
 * directory was built with, so it cannot name one the allowlist does not
 * offer. Only `yamlQuoted`'s own escapes are understood — this reads EO's
 * output, not YAML.
 */
export function yamlUnquoted(scalar: string): string | null {
  if (scalar.length < 2 || !scalar.startsWith('"') || !scalar.endsWith('"')) return null;
  const simple: Record<string, string> = { "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" };
  let text = "";
  for (let i = 1; i < scalar.length - 1; i++) {
    const character = scalar[i] ?? "";
    if (character === '"') return null;
    if (character !== "\\") {
      text += character;
      continue;
    }
    // An escape needs a character before the closing quote to escape.
    if (++i >= scalar.length - 1) return null;
    const escape = scalar[i] ?? "";
    if (escape === "x") {
      const hex = scalar.slice(i + 1, i + 3);
      if (!/^[0-9a-f]{2}$/i.test(hex)) return null;
      text += String.fromCharCode(Number.parseInt(hex, 16));
      i += 2;
    } else {
      const unescaped = simple[escape];
      if (unescaped === undefined) return null;
      text += unescaped;
    }
  }
  return text;
}

/** What the frontmatter of a skill is written from. */
export interface SkillFrontmatterInput {
  /** The identifier — see `skillFrontmatter` for why this is what `name:` gets. */
  slug: string;
  /** What a person calls it. Carried, never invoked. */
  name: string;
  description: string;
  disableModelInvocation: boolean;
  /**
   * The skill's id, written under `metadata` as `eo-skill-id` where the
   * delivery wants a read of the file to be recognisable by what it
   * shows (EO-715): Codex has no skill tool, so EO tells a load by the
   * id turning up in a command's output. Absent everywhere else.
   */
  skillIdMarker?: string;
}

/**
 * The `---` block at the top of a `SKILL.md`.
 *
 * `name` is the **slug**, and that is the load-bearing line. The name a
 * model is shown is the name it has to call, so listing a display name
 * there offers it something that does not resolve — multica shipped
 * exactly that and tracked it as MUL-5529, where a skill called "PR
 * review" was listed verbatim and could not be invoked.
 *
 * The display name still has to survive, because somebody opening the
 * generated file should recognise the skill they wrote. It goes under
 * `metadata`, which is the frontmatter's own place for what EO wants to
 * keep and the reader does not have to understand — and being under
 * there is what makes it inert rather than a second candidate for the
 * thing a model calls.
 *
 * `disable-model-invocation` is written only when it is true. A skill
 * carrying it is on disk and not offered to the model: present for a
 * person to invoke, absent from what the model is choosing between. The
 * flag defaults to off everywhere, so writing `false` on every other
 * skill would be a line that says nothing.
 */
/** The `metadata` key a delivered skill's id is written under, where it is (`SkillFrontmatterInput.skillIdMarker`). */
export const SKILL_ID_MARKER_KEY = "eo-skill-id";

export function skillFrontmatter(skill: SkillFrontmatterInput): string {
  const lines = ["---", `name: ${yamlQuoted(skill.slug)}`, `description: ${yamlQuoted(skill.description)}`];
  if (skill.disableModelInvocation) lines.push("disable-model-invocation: true");
  lines.push("metadata:", `  display-name: ${yamlQuoted(skill.name)}`);
  if (skill.skillIdMarker !== undefined) lines.push(`  ${SKILL_ID_MARKER_KEY}: ${yamlQuoted(skill.skillIdMarker)}`);
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

/**
 * The whole file: frontmatter, a blank line, then the body as written.
 *
 * The body is markdown a person wrote and is emitted verbatim — it is
 * below the closing `---`, so nothing in it can be read as YAML and
 * nothing in it needs escaping. Only the trailing whitespace is
 * normalised, so a body that happens to end in three blank lines does
 * not make the generated file differ from one that does not.
 */
export function renderSkillMarkdown(skill: SkillFrontmatterInput & { body: string }): string {
  const body = skill.body.trimEnd();
  return body === "" ? skillFrontmatter(skill) : `${skillFrontmatter(skill)}\n${body}\n`;
}
