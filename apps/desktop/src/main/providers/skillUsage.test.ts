import { renderSkillMarkdown, type InterruptibleStream, type Skill } from "@eo/core";
import { describe, expect, it, vi } from "vitest";
import { claudeSkillLoaded, codexSkillsRead, leadingWith, NO_SKILL_TEXTS, skillsOffered, skillTextsOf } from "./skillUsage.js";

/** How each adapter reads a skill delivered and a skill loaded (EO-715). */
describe("skill usage detection", () => {
  it("says nothing for a turn given no skill, and each delivered slug once, sorted", () => {
    expect(skillsOffered([])).toEqual([]);
    expect(skillsOffered(["b", "a", "b"])).toEqual([{ type: "skills_delivered", slugs: ["a", "b"] }]);
  });

  it("reads a Claude load from a Skill call under EO's plugin prefix only", () => {
    expect(claudeSkillLoaded("Skill", { skill: "eo-attachments:house-style" })).toEqual([{ type: "skill_loaded", slug: "house-style" }]);
    expect(claudeSkillLoaded("Skill", { skill: "house-style" })).toEqual([]);
    expect(claudeSkillLoaded("Skill", { skill: "other-plugin:house-style" })).toEqual([]);
    expect(claudeSkillLoaded("Skill", { skill: "eo-attachments:" })).toEqual([]);
    expect(claudeSkillLoaded("Read", { file_path: "/x/skills/house-style/SKILL.md" })).toEqual([]);
    expect(claudeSkillLoaded("Skill", null)).toEqual([]);
  });

  /** Two delivered skills, as the files Codex reads hold them. */
  const skill = (slug: string, description: string, body: string): Skill => ({
    id: `skill-${slug}`,
    slug,
    name: slug,
    description,
    body,
    files: [],
    disableModelInvocation: false,
    enabled: true,
    scope: { kind: "global" },
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    createdBy: "person",
    locked: false,
  });
  const HOUSE = skill("house-style", "How this house reviews a change.", "# House style\n\nRead the whole diff before you judge any of it.\n\n## Steps\n\nRun the tests yourself, every time, before approving.\n");
  const REVIEW = skill("review", "How to review.", "# Review\n\n## Steps\n\nLeave one comment per finding, never a wall of text.\n");
  const TEXTS = skillTextsOf([HOUSE, REVIEW]);
  const FILE = renderSkillMarkdown(HOUSE);
  const PATH = ".agent/skills/house-style/SKILL.md";
  const loads = (...slugs: string[]) => slugs.map((slug) => ({ type: "skill_loaded", slug }));

  it("holds each skill to its own lines: its description, and long lines no other skill given shares", () => {
    expect(TEXTS.lines.get('description: "How this house reviews a change."')).toBe("house-style");
    expect(TEXTS.lines.get('description: "How to review."')).toBe("review");
    expect(TEXTS.lines.get("Read the whole diff before you judge any of it.")).toBe("house-style");
    // Short, or in both files: in every other markdown file too.
    expect(TEXTS.lines.has("## Steps")).toBe(false);
    expect(TEXTS.lines.has("---")).toBe(false);
    const twins = skillTextsOf([skill("a", "A.", "The same long line in both of these skills.\n"), skill("b", "B.", "The same long line in both of these skills.\n")]);
    expect(twins.lines.has("The same long line in both of these skills.")).toBe(false);
  });

  it.each([
    ["cat", `bash -lc 'cat ${PATH}'`, FILE],
    ["sed -n, the opening lines", `bash -lc "sed -n '1,4p' ${PATH}"`, FILE.split("\n").slice(0, 4).join("\n")],
    ["tail, the closing lines", `tail -n 2 ${PATH}`, FILE.trimEnd().split("\n").slice(-2).join("\n")],
    ["nl, numbered", `nl -ba ${PATH}`, FILE.split("\n").map((line, at) => `${String(at + 1).padStart(6)}\t${line}`).join("\n")],
    ["rg, path and line prefixed", `rg -n . .agent/skills`, `${PATH}:7:Read the whole diff before you judge any of it.`],
    ["grep, line prefixed", `grep -n judge ${PATH}`, "7:Read the whole diff before you judge any of it."],
    ["python", `python3 -c "print(open('${PATH}').read())"`, FILE],
    ["xargs", `ls .agent/skills/*/SKILL.md | xargs cat`, FILE],
    ["a subshell", `echo "$(cat ${PATH})"`, FILE],
    ["among other output", `cat README.md ${PATH} package.json`, `# EO\n${FILE}{ "name": "eo" }`],
  ])("counts a Codex load when the output shows the skill's file: %s", (_, command, output) => {
    expect(codexSkillsRead(command, output, TEXTS)).toEqual(loads("house-style"));
  });

  it("counts each skill a command shows once, however many of its lines it shows", () => {
    expect(codexSkillsRead("cat .agent/skills/*/SKILL.md", `${FILE}${FILE}${renderSkillMarkdown(REVIEW)}`, TEXTS)).toEqual(loads("house-style", "review"));
  });

  it.each([
    // The path mentioned, nothing of the file shown.
    ["echo", `bash -lc 'echo ${PATH}'`, PATH],
    ["ls", `bash -lc 'ls ${PATH}'`, PATH],
    ["a comment", `echo ignored #; cat ${PATH}`, "ignored"],
    ["a heredoc", `cat <<'EOF'\ncat ${PATH}\nEOF`, `cat ${PATH}`],
    ["--help", `cat --help ${PATH}`, "Usage: cat [OPTION]... [FILE]...\nConcatenate FILE(s) to standard output."],
    ["an option's value", `sed -n -e ${PATH} /dev/null`, ""],
    ["a missing file beside it", `cat ${PATH}.bak`, `cat: ${PATH}.bak: No such file or directory`],
    ["a listing", `rg --files .agent/skills`, `${PATH}\n.agent/skills/review/SKILL.md`],
    ["a write", `sed -i 's/a/b/' ${PATH}`, ""],
    ["output kept from the agent", `cat ${PATH} > /dev/null`, ""],
    // Only lines every markdown file has.
    ["generic lines", "cat CONTRIBUTING.md", "---\n## Steps\n# House style"],
    // The skill's words typed by the agent, not read: in the command itself.
    ["the agent echoing a line", "echo 'Read the whole diff before you judge any of it.'", "Read the whole diff before you judge any of it."],
    ["a heredoc holding a line", "cat <<'EOF'\nRead the whole diff before you judge any of it.\nEOF", "Read the whole diff before you judge any of it."],
  ])("counts no Codex load from %s", (_, command, output) => {
    expect(codexSkillsRead(command, output, TEXTS)).toEqual([]);
  });

  it("counts nothing on a turn given no skill", () => {
    expect(codexSkillsRead(`cat ${PATH}`, FILE, NO_SKILL_TEXTS)).toEqual([]);
  });

  it("says the leading events first and keeps the turn reachable", async () => {
    const interrupt = vi.fn(async () => undefined);
    const steer = vi.fn(async () => true);
    const inner: InterruptibleStream<string> = {
      async *[Symbol.asyncIterator]() {
        yield "turn";
      },
      interrupt,
      steer,
    };
    const stream = leadingWith(["first"], inner);
    const said: string[] = [];
    for await (const value of stream) said.push(value);
    expect(said).toEqual(["first", "turn"]);
    await stream.interrupt?.();
    expect(await stream.steer?.("hello")).toBe(true);
    expect(interrupt).toHaveBeenCalled();
    expect(steer).toHaveBeenCalledWith("hello", undefined);
    expect(leadingWith([], inner)).toBe(inner);
  });
});
