import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@eo/core";
import { afterEach, describe, expect, it } from "vitest";
import { toolDirectorySkillsPromptSection, writeToolDirectory } from "./pluginDirectory.js";
import { worktreeSkillsPromptSection } from "./worktreeSkills.js";

const skill = (slug: string): Skill => ({
  id: `skill-${slug}`,
  slug,
  name: slug,
  description: `How to ${slug}.`,
  body: `# ${slug}\n`,
  files: [],
  disableModelInvocation: false,
  enabled: true,
  scope: { kind: "global" },
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null, createdBy: "person", locked: false,
});

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("skillsPromptSection", () => {
  it("renders both backends' sections alike but for how a skill is opened (EO-602)", () => {
    scratch = mkdtempSync(join(tmpdir(), "eo skills prompt "));
    const skills = [skill("house-style"), skill("release")];
    writeToolDirectory(scratch, { servers: [], skills });

    const claude = toolDirectorySkillsPromptSection(scratch).split("\n");
    const codex = worktreeSkillsPromptSection(skills).split("\n");

    // The skill names are each backend's own spelling of one slug.
    const differing = claude.map((line, index) => [line.replace("`eo-attachments:", "`"), codex[index]] as const).filter(([a, b]) => a !== b);
    expect(claude).toHaveLength(codex.length);
    // One sentence: how the skill that fits is opened.
    expect(differing).toEqual([
      [
        "Pick from those descriptions. When one of them fits what you are doing, invoke it with the Skill tool by the name shown and follow it;",
        "Pick from those descriptions. When one of them fits what you are doing, read `.agent/skills/<slug>/SKILL.md` and follow it;",
      ],
    ]);
  });
});
