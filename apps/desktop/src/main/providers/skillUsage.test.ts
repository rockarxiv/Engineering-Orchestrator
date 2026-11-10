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
    [".agent/skills/house-style/SKILL.md", ["house-style"]],
    ["cat ./.agent/skills/a/SKILL.md .agent/skills/b-2/SKILL.md ./.agent/skills/a/SKILL.md", ["a", "b-2"]],
    ["cat .agent/skills/house-style/checklist.md", []],
    ["ls .agent/skills/", []],
    ["cat foo.agent/skills/house-style/SKILL.md", []],
    ["cat .agent/skills/House/SKILL.md", []],
  ])("reads a Codex load from %s", (command, slugs) => {
    expect(codexSkillsRead(command)).toEqual(slugs.map((slug) => ({ type: "skill_loaded", slug })));
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
