import type { InterruptibleStream } from "@eo/core";
import { describe, expect, it, vi } from "vitest";
import { claudeSkillLoaded, codexSkillLoaded, leadingWith, skillsOffered } from "./skillUsage.js";

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
   * Codex loads a skill with EO's `skill_read` (EO-721): the call EO
   * answered is the load, as exact as Claude's `Skill` call above.
   */
  it("reads a Codex load from a skill_read call to the eo server that EO answered, and from nothing else", () => {
    expect(codexSkillLoaded("eo", "skill_read", { slug: "house-style" }, true)).toEqual([{ type: "skill_loaded", slug: "house-style" }]);
    // Refused, failed or never answered: nothing was loaded.
    expect(codexSkillLoaded("eo", "skill_read", { slug: "house-style" }, false)).toEqual([]);
    // The same tool name on somebody else's server is not EO's tool.
    expect(codexSkillLoaded("github", "skill_read", { slug: "house-style" }, true)).toEqual([]);
    // Another of EO's tools, and calls without a slug.
    expect(codexSkillLoaded("eo", "memory_read", { slug: "house-style" }, true)).toEqual([]);
    expect(codexSkillLoaded("eo", "skill_read", {}, true)).toEqual([]);
    expect(codexSkillLoaded("eo", "skill_read", { slug: " " }, true)).toEqual([]);
    expect(codexSkillLoaded("eo", "skill_read", null, true)).toEqual([]);
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
