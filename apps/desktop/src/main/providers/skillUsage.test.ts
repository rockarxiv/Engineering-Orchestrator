import type { InterruptibleStream } from "@eo/core";
import { describe, expect, it, vi } from "vitest";
import { claudeSkillLoaded, codexSkillsRead, leadingWith, skillsOffered } from "./skillUsage.js";

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

  it.each([
    ["bash -lc 'cat .agent/skills/house-style/SKILL.md'", ["house-style"]],
    ['bash -lc "sed -n 1,80p /tmp/wt/.agent/skills/house-style/SKILL.md"', ["house-style"]],
    ["/bin/zsh -lc \"sed -n '1,200p' ./.agent/skills/house-style/SKILL.md\"", ["house-style"]],
    ["head -40 .agent/skills/house-style/SKILL.md", ["house-style"]],
    ["nl -ba .agent/skills/house-style/SKILL.md | head -50", ["house-style"]],
    ["cd /tmp/wt && cat .agent/skills/a/SKILL.md .agent/skills/b-2/SKILL.md; cat ./.agent/skills/a/SKILL.md", ["a", "b-2"]],
    ["sed -n p < .agent/skills/house-style/SKILL.md", ["house-style"]],
    ["cat .agent/skills/house-style/SKILL.md > /tmp/copy.md", ["house-style"]],
    // Searching the file reads it.
    ["rg . .agent/skills/house-style/SKILL.md", ["house-style"]],
    ["rg -n --color=never -e foo -- .agent/skills/house-style/SKILL.md", ["house-style"]],
    ["grep -n '' .agent/skills/house-style/SKILL.md", ["house-style"]],
    ["grep -A3 -i release .agent/skills/house-style/SKILL.md", ["house-style"]],
    ["egrep -e a -e b .agent/skills/house-style/SKILL.md", ["house-style"]],
    // Options and their values are skipped, not mistaken for the file or for its absence.
    ["head -n 40 .agent/skills/house-style/SKILL.md", ["house-style"]],
    ["tail -n40 .agent/skills/house-style/SKILL.md", ["house-style"]],
    ["sed -n -e 1,20p .agent/skills/house-style/SKILL.md", ["house-style"]],
    ["sed -nE '1,20p' .agent/skills/house-style/SKILL.md", ["house-style"]],
    ["awk '{print}' .agent/skills/house-style/SKILL.md", ["house-style"]],
    ["cat -- .agent/skills/house-style/SKILL.md", ["house-style"]],
    ["bat --style=plain -r 1:40 .agent/skills/house-style/SKILL.md", ["house-style"]],
  ])("reads a Codex load from %s", (command, slugs) => {
    expect(codexSkillsRead(command)).toEqual(slugs.map((slug) => ({ type: "skill_loaded", slug })));
  });

  it.each([
    // A mention is not a read.
    "bash -lc 'echo .agent/skills/house-style/SKILL.md'",
    "bash -lc 'ls .agent/skills/house-style/SKILL.md'",
    "ls -la .agent/skills/",
    "test -f .agent/skills/house-style/SKILL.md && echo yes",
    "rg -n house-style .agent/skills/house-style/SKILL.md.bak",
    // Not exactly that file.
    "cat .agent/skills/house-style/SKILL.md.bak",
    "cat .agent/skills/house-style/checklist.md",
    "cat foo.agent/skills/house-style/SKILL.md",
    "cat .agent/skills/House/SKILL.md",
    "cat '.agent/skills/house-style/SKILL.md x'",
    // Written, not read.
    "cat > .agent/skills/house-style/SKILL.md",
    "echo hi >> .agent/skills/house-style/SKILL.md",
    "sed -i 's/a/b/' .agent/skills/house-style/SKILL.md",
    // Named inside an argument that is not the file.
    "grep -c x 'see .agent/skills/house-style/SKILL.md'",
    // Help and version read no file.
    "cat --help .agent/skills/house-style/SKILL.md",
    "head --version .agent/skills/house-style/SKILL.md",
    "rg -V .agent/skills/house-style/SKILL.md",
    "rg -h .agent/skills/house-style/SKILL.md",
    "bat --list-languages .agent/skills/house-style/SKILL.md",
    // Listing files is not reading them.
    "rg --files .agent/skills/house-style/SKILL.md",
    // The path as an option's value, a script or a pattern, not a file operand.
    "sed -n -e .agent/skills/house-style/SKILL.md /dev/null",
    "sed .agent/skills/house-style/SKILL.md",
    "sed -f .agent/skills/house-style/SKILL.md README.md",
    "awk -f .agent/skills/house-style/SKILL.md README.md",
    "rg .agent/skills/house-style/SKILL.md",
    "rg -e .agent/skills/house-style/SKILL.md README.md",
    "grep -f .agent/skills/house-style/SKILL.md README.md",
    "grep --regexp=x --file .agent/skills/house-style/SKILL.md README.md",
    "tail --pid .agent/skills/house-style/SKILL.md README.md",
    "head -n .agent/skills/house-style/SKILL.md README.md",
    // An in-place edit, however it is spelled.
    "sed -ni 's/a/b/' .agent/skills/house-style/SKILL.md",
    "sed --in-place=.orig 's/a/b/' .agent/skills/house-style/SKILL.md",
    "cat --help < .agent/skills/house-style/SKILL.md",
  ])("counts no Codex load from %s", (command) => {
    expect(codexSkillsRead(command)).toEqual([]);
  });

  it("counts a Codex load from the app-server's read actions, on exactly the skill's file", () => {
    expect(codexSkillsRead("/bin/bash -lc 'x'", ["/tmp/wt/.agent/skills/house-style/SKILL.md", ".agent/skills/review/SKILL.md"])).toEqual([
      { type: "skill_loaded", slug: "house-style" },
      { type: "skill_loaded", slug: "review" },
    ]);
    expect(codexSkillsRead("/bin/bash -lc 'x'", ["/tmp/wt/.agent/skills/house-style/SKILL.md.bak", "/tmp/wt/README.md"])).toEqual([]);
    // Both kinds of evidence for one skill are one load.
    expect(codexSkillsRead("cat .agent/skills/a/SKILL.md", ["/w/.agent/skills/a/SKILL.md"])).toEqual([{ type: "skill_loaded", slug: "a" }]);
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
