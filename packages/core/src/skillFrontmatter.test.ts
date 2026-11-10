import { describe, expect, it } from "vitest";
import { renderSkillMarkdown, skillFrontmatter, yamlQuoted, yamlUnquoted } from "./skillFrontmatter.js";

/**
 * The YAML EO writes at the top of a `SKILL.md` (EO-105).
 *
 * Generated, never parsed, and generated from strings a person typed —
 * so what these are about is the display name that would otherwise end
 * the scalar, end the key or end the document.
 */
const skill = { slug: "pr-review", name: "PR review", description: "Reviews a pull request.", disableModelInvocation: false };

describe("skillFrontmatter", () => {
  it("writes the slug as `name`, not the display name", () => {
    // The whole point. The name a model is shown is the name it has to
    // call, so a display name there offers it something that does not
    // resolve — multica shipped exactly that as MUL-5529.
    const written = skillFrontmatter({ ...skill, slug: "pr-review", name: "PR review" });

    expect(written.split("\n")).toContain('name: "pr-review"');
    // The display name is still in there — under `metadata`, where
    // nothing offers it to the model as something to call.
    expect(written.split("\n")).not.toContain('name: "PR review"');
    expect(written.split("\n")).toContain('  display-name: "PR review"');
  });

  it("writes the skill's id under metadata only where a delivery asks for it (EO-715)", () => {
    expect(skillFrontmatter(skill)).not.toContain("eo-skill-id");
    const marked = skillFrontmatter({ ...skill, skillIdMarker: "0199-skill" }).split("\n");
    expect(marked.slice(-4)).toEqual(['  display-name: "PR review"', '  eo-skill-id: "0199-skill"', "---", ""]);
  });

  it("escapes a display name carrying a quote, a colon and a newline", () => {
    const written = skillFrontmatter({ ...skill, name: 'Ship: "now"\nor never' });

    // Every one of those would otherwise change the document's
    // structure: the colon starts a mapping, the quote ends the scalar,
    // the newline ends the entry — and the line after `---` ends the
    // frontmatter itself.
    expect(written).toContain('  display-name: "Ship: \\"now\\"\\nor never"');
    expect(written.split("\n").filter((line) => line === "---")).toHaveLength(2);
    expect(written.trimEnd().split("\n")).toHaveLength(6);
  });

  it("escapes the same things in a description", () => {
    const written = skillFrontmatter({ ...skill, description: 'Use when: the diff is "large"\nor risky' });

    expect(written).toContain('description: "Use when: the diff is \\"large\\"\\nor risky"');
  });

  it("writes disable-model-invocation only when it is on", () => {
    expect(skillFrontmatter(skill)).not.toContain("disable-model-invocation");
    expect(skillFrontmatter({ ...skill, disableModelInvocation: true })).toContain("disable-model-invocation: true");
  });

  it("writes the whole block, in full", () => {
    expect(skillFrontmatter({ slug: "pr-review", name: "PR review", description: "Reviews a pull request.", disableModelInvocation: true })).toBe(
      ['---', 'name: "pr-review"', 'description: "Reviews a pull request."', "disable-model-invocation: true", "metadata:", '  display-name: "PR review"', "---", ""].join(
        "\n",
      ),
    );
  });
});

describe("yamlQuoted", () => {
  it("quotes a value that would otherwise stop being a string", () => {
    expect(yamlQuoted("true")).toBe('"true"');
    expect(yamlQuoted("null")).toBe('"null"');
    expect(yamlQuoted("0755")).toBe('"0755"');
    expect(yamlQuoted("- item")).toBe('"- item"');
  });

  it("escapes a backslash before anything else reads it as one", () => {
    // `C:\next` is a Windows path and `\n` in it is not a newline. Get
    // the order wrong and it becomes one.
    expect(yamlQuoted("C:\\next")).toBe('"C:\\\\next"');
  });

  it("escapes tabs, carriage returns and the rest of C0", () => {
    expect(yamlQuoted("a\tb\r\nc")).toBe('"a\\tb\\r\\nc"');
    expect(yamlQuoted("bell\u0007")).toBe('"bell\\x07"');
  });

  it("leaves ordinary text alone inside its quotes", () => {
    expect(yamlQuoted("Reviews a pull request — carefully. 🎉")).toBe('"Reviews a pull request — carefully. 🎉"');
  });
});

describe("renderSkillMarkdown", () => {
  it("puts the body below the frontmatter, verbatim", () => {
    const body = "# How to review\n\nRead the whole diff first.";

    const written = renderSkillMarkdown({ ...skill, body });

    expect(written).toBe(`${skillFrontmatter(skill)}\n${body}\n`);
    // Nothing in the body is escaped: it is below the closing `---`, so
    // nothing in it is read as YAML.
    expect(renderSkillMarkdown({ ...skill, body: 'A colon: and a "quote".' })).toContain('A colon: and a "quote".');
  });

  it("normalises the body's trailing whitespace so the file is stable", () => {
    expect(renderSkillMarkdown({ ...skill, body: "Read it.\n\n\n" })).toBe(renderSkillMarkdown({ ...skill, body: "Read it." }));
  });
});

describe("yamlUnquoted", () => {
  it("reads back whatever yamlQuoted wrote", () => {
    // Claude's prompt names skills from the files EO wrote (EO-602), so
    // every value a person can type has to survive the round trip.
    for (const value of ["plain", "C:\\next", 'say "hi"', "a\tb\r\nc", "bell\u0007\u007f", "", "colon: here", "café ✓"]) {
      expect(yamlUnquoted(yamlQuoted(value))).toBe(value);
    }
  });

  it("is null for anything yamlQuoted would not have written", () => {
    expect(yamlUnquoted("unquoted")).toBeNull();
    expect(yamlUnquoted('"open')).toBeNull();
    expect(yamlUnquoted('"a"b"')).toBeNull();
    expect(yamlUnquoted('"ends\\"')).toBeNull();
    expect(yamlUnquoted('"\\q"')).toBeNull();
    expect(yamlUnquoted('"\\xZZ"')).toBeNull();
  });
});
