import { renderSkillMarkdown, type InterruptibleStream, type Skill } from "@eo/core";
import { describe, expect, it, vi } from "vitest";
import { worktreeSkillMarkdown } from "../agentAttachments/worktreeSkills.js";
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

  /**
   * Codex detection is a best-effort inference from what Codex reports
   * (the rule settled for EO-715); Claude's above is exact. These hold it
   * to that rule: the skill's id in the output, or the skill's path named
   * — by the command or as a grep-style prefix — with a line of the file.
   */
  const skill = (id: string, slug: string, description: string, body: string): Skill => ({
    id,
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
  const HOUSE = skill("0199aaaa-0000-7000-8000-000000000001", "house-style", "How this house reviews a change.", "# House style\n\nRead the whole diff before you judge any of it.\n\nRun the tests.\n");
  const REVIEW = skill("0199aaaa-0000-7000-8000-000000000002", "review", "How to review.", "# Review\n\nLeave one comment per finding.\n");
  // Two short skills that differ in nothing a person wrote but the slug.
  const A = skill("0199aaaa-0000-7000-8000-00000000000a", "a", "Same.", "Read the diff.\n");
  const B = skill("0199aaaa-0000-7000-8000-00000000000b", "b", "Same.", "Read the diff.\n");
  const TEXTS = skillTextsOf([HOUSE, REVIEW, A, B]);
  const FILE = worktreeSkillMarkdown(HOUSE);
  const PATH = ".agent/skills/house-style/SKILL.md";
  const loads = (...slugs: string[]) => slugs.map((slug) => ({ type: "skill_loaded", slug }));

  it("delivers the skill's id in the file Codex reads, and in nothing else EO writes", () => {
    expect(FILE).toContain(`eo-skill-id: "${HOUSE.id}"`);
    expect(renderSkillMarkdown(HOUSE)).not.toContain(HOUSE.id);
  });

  it.each([
    // The frontmatter shown: the id says which file, whatever the command.
    ["cat", `bash -lc 'cat ${PATH}'`, FILE],
    ["head", `head -8 ${PATH}`, FILE.split("\n").slice(0, 8).join("\n")],
    ["python", `python3 -c "print(open('${PATH}').read())"`, FILE],
    ["xargs", "ls .agent/skills/*/SKILL.md | xargs cat", FILE],
    ["find -exec", "find . -name SKILL.md -exec cat {} +", FILE],
    ["a subshell", `echo "$(cat ${PATH})"`, FILE],
    ["among other output", `cat README.md ${PATH} package.json`, `# EO\n${FILE}{ "name": "eo" }`],
    // The frontmatter left out: the path named, and a line of the file shown.
    ["tail", `tail -n 3 ${PATH}`, "Read the whole diff before you judge any of it.\n\nRun the tests."],
    ["grep with the line in the command", `grep -n 'Run the tests.' ${PATH}`, "9:Run the tests."],
    ["nl", `nl -ba ${PATH} | tail -2`, "    11\tRun the tests."],
    ["sed past the frontmatter", `sed -n '9,11p' /tmp/wt/${PATH}`, "Run the tests."],
    // The path as a grep-style prefix on the line.
    ["grep -r, path prefixed", "grep -rn 'tests' .agent/skills", `${PATH}:11:Run the tests.`],
    ["grep context, path prefixed", "grep -rn -B1 'tests' .agent/", `${PATH}-10-\n${PATH}:11:Run the tests.`],
  ])("counts a Codex load from %s", (_, command, output) => {
    expect(codexSkillsRead(command, output, TEXTS)).toEqual(loads("house-style"));
  });

  it("tells two skills with the same words apart by their ids, and by the path named", () => {
    const a = worktreeSkillMarkdown(A);
    expect(codexSkillsRead("cat .agent/skills/a/SKILL.md", a, TEXTS)).toEqual(loads("a"));
    // A partial read of a short line both share: the path says whose.
    expect(codexSkillsRead("tail -n 1 .agent/skills/b/SKILL.md", "Read the diff.", TEXTS)).toEqual(loads("b"));
    expect(codexSkillsRead("grep -rn diff .agent/skills", ".agent/skills/a/SKILL.md:9:Read the diff.", TEXTS)).toEqual(loads("a"));
    // Both shown: both loaded, once each.
    expect(codexSkillsRead("cat .agent/skills/*/SKILL.md", `${a}${worktreeSkillMarkdown(B)}${a}`, TEXTS)).toEqual(loads("a", "b"));
  });

  it.each([
    // The skill's words in another file: no id, and no path named.
    ["a README holding a skill's line", "cat README.md", "# EO\nRead the whole diff before you judge any of it.\n"],
    ["a search finding it in the README", "rg -n 'Read the whole diff' .", "README.md:3:Read the whole diff before you judge any of it."],
    ["a short shared line elsewhere", "cat NOTES.md", "Read the diff."],
    // The path mentioned, nothing of the file shown.
    ["echo", `bash -lc 'echo ${PATH}'`, PATH],
    ["ls", `bash -lc 'ls ${PATH}'`, PATH],
    ["a comment", `echo ignored #; cat ${PATH}`, "ignored"],
    ["a heredoc", `cat <<'EOF'\ncat ${PATH}\nEOF`, `cat ${PATH}`],
    ["--help", `cat --help ${PATH}`, "Usage: cat [OPTION]... [FILE]...\nConcatenate FILE(s) to standard output."],
    ["an option's value", `sed -n -e ${PATH} /dev/null`, ""],
    ["a missing file beside it", `cat ${PATH}.bak`, `cat: ${PATH}.bak: No such file or directory`],
    ["a listing", "rg --files .agent/skills", `${PATH}\n.agent/skills/review/SKILL.md`],
    ["output kept from the agent", `cat ${PATH} > /dev/null`, ""],
    // Another skill's path named: its line is not this skill's.
    ["the other skill's file", "tail -n 1 .agent/skills/review/SKILL.md", "Read the whole diff before you judge any of it."],
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
