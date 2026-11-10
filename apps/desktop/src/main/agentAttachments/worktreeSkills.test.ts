import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WORKTREE_AGENT_DIRECTORY,
  deliverableSkills,
  eoOwnsSkillDirectory,
  skillReadAnswer,
  unmanagedAgentEntries,
  worktreeSkillFiles,
  worktreeSkillsPromptSection,
  writeWorktreeSkills,
} from "./worktreeSkills.js";
import { readTree } from "../testing/tree.js";

/**
 * Skills reaching a Codex agent (EO-207).
 *
 * Against a real directory rather than a stubbed filesystem, because the
 * claim is about what an agent finds on disk: the supporting files have
 * to be where `skill_read`'s answer says they are, and the instructions
 * themselves nowhere on disk at all (EO-721) — neither is a thing a mock
 * can be wrong about convincingly.
 */

/** The body string that must never reach a prompt — see the test that says so. */
const DISTINCTIVE_BODY = "MARZIPAN-ONLY-IN-THE-BODY";

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "0199cf00-0000-7000-8000-00000000000c",
    slug: "pr-review",
    name: "PR review",
    description: "How this house reviews a pull request.",
    body: `# PR review\n\n${DISTINCTIVE_BODY}\n`,
    files: [{ path: "checklist.md", content: "- [ ] tests\n- [ ] docs\n" }],
    disableModelInvocation: false,
    enabled: true,
    scope: { kind: "global" },
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null, createdBy: "person", locked: false,
    ...overrides,
  };
}

let worktree: string;

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), "eo worktree skills "));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

describe("writeWorktreeSkills", () => {
  it("puts a skill's supporting files where skill_read says they are, and never its SKILL.md (EO-721)", () => {
    const written = writeWorktreeSkills(worktree, [skill()]);

    expect(written.delivered.map((delivered) => delivered.slug)).toEqual(["pr-review"]);
    expect(written.undelivered).toEqual([]);
    expect(readTree(join(worktree, ".agent"))).toEqual({
      "skills/pr-review/checklist.md": "- [ ] tests\n- [ ] docs\n",
      // Inside the folder, so the folder is what says EO made it — the
      // only claim EO acts on when it comes to remove one.
      "skills/pr-review/.eo-delivered": expect.stringContaining("EO wrote this folder") as unknown as string,
    });
    // The instructions are `skill_read`'s answer: a load is a tool call EO
    // sees, not a file read it would have to infer.
    expect(existsSync(join(worktree, ".agent", "skills", "pr-review", "SKILL.md"))).toBe(false);
  });

  it("delivers a skill with no supporting files without writing anything", () => {
    const written = writeWorktreeSkills(worktree, [skill({ files: [] })]);

    expect(written.delivered.map((delivered) => delivered.slug)).toEqual(["pr-review"]);
    expect(existsSync(join(worktree, WORKTREE_AGENT_DIRECTORY))).toBe(false);
  });

  it("writes nothing at all, and leaves no empty folder, when nothing is attached", () => {
    expect(writeWorktreeSkills(worktree, [])).toEqual({ delivered: [], undelivered: [] });

    expect(existsSync(join(worktree, WORKTREE_AGENT_DIRECTORY))).toBe(false);
  });

  it("takes a detached skill back off disk", () => {
    writeWorktreeSkills(worktree, [skill(), skill({ id: "b", slug: "release", name: "Release" })]);

    writeWorktreeSkills(worktree, [skill()]);

    // Rewritten rather than merged into: one worktree is dispatched to
    // by several agents, and a directory that only ever gained files
    // would go on offering a skill nobody attached.
    expect(Object.keys(readTree(join(worktree, ".agent"))).sort()).toEqual(["skills/pr-review/.eo-delivered", "skills/pr-review/checklist.md"]);
  });

  it("does not deliver a disabled or an archived skill, by the same rule the other backend uses", () => {
    const written = writeWorktreeSkills(worktree, [
      skill({ id: "a", slug: "paused", enabled: false }),
      skill({ id: "b", slug: "retired", archivedAt: 99 }),
    ]);

    expect(written.delivered).toEqual([]);
    expect(existsSync(join(worktree, WORKTREE_AGENT_DIRECTORY))).toBe(false);
    // And it is `isDeliverable` deciding, not a second copy of the rule.
    expect(deliverableSkills([skill({ enabled: false })])).toEqual([]);
  });

  it("removes what EO wrote and never what somebody else put under .agent", () => {
    // `.agent` is a plausible name for a repository to have chosen
    // itself, and a rewrite that cleared the directory would delete
    // their tracked files on every dispatch. EO removes the slugs it
    // recorded, and the tidy-up only takes a directory that is empty
    // once they are gone.
    mkdirSync(join(worktree, ".agent", "skills", "theirs"), { recursive: true });
    writeFileSync(join(worktree, ".agent", "theirs.md"), "not EO's\n");
    writeFileSync(join(worktree, ".agent", "skills", "theirs", "SKILL.md"), "theirs, and it looks exactly like ours\n");

    writeWorktreeSkills(worktree, [skill()]);
    writeWorktreeSkills(worktree, []);

    expect(readFileSync(join(worktree, ".agent", "theirs.md"), "utf8")).toBe("not EO's\n");
    expect(readFileSync(join(worktree, ".agent", "skills", "theirs", "SKILL.md"), "utf8")).toContain("theirs");
    expect(existsSync(join(worktree, ".agent", "skills", "pr-review"))).toBe(false);
  });

  it("will not deliver over a folder of the same name that EO did not write", () => {
    // The collision the ownership marker exists for. A repository is
    // entitled to keep `.agent/skills/pr-review` of its own, and a
    // person who attaches a skill that happens to share the slug has not
    // thereby asked EO to replace it.
    mkdirSync(join(worktree, ".agent", "skills", "pr-review"), { recursive: true });
    writeFileSync(join(worktree, ".agent", "skills", "pr-review", "SKILL.md"), "theirs, under the same name\n");
    writeFileSync(join(worktree, ".agent", "skills", "pr-review", "notes.md"), "theirs too\n");

    const written = writeWorktreeSkills(worktree, [skill()]);

    // Not written over.
    expect(readFileSync(join(worktree, ".agent", "skills", "pr-review", "SKILL.md"), "utf8")).toBe("theirs, under the same name\n");
    expect(readFileSync(join(worktree, ".agent", "skills", "pr-review", "notes.md"), "utf8")).toBe("theirs too\n");
    // Not delivered, so the prompt cannot offer a skill whose file is
    // somebody else's — and said out loud rather than dropped.
    expect(written.delivered).toEqual([]);
    expect(written.undelivered.map((skill) => skill.slug)).toEqual(["pr-review"]);
    expect(written.undelivered[0]?.reason).toContain("EO did not write it");
    expect(worktreeSkillsPromptSection(written.delivered)).toBe("");
  });

  it("will not remove that folder on the next dispatch either", () => {
    // The second half, and the one a record of slugs got wrong: a name
    // EO wanted is not a name EO may delete. Only the marker inside a
    // folder says EO wrote it.
    mkdirSync(join(worktree, ".agent", "skills", "pr-review"), { recursive: true });
    writeFileSync(join(worktree, ".agent", "skills", "pr-review", "SKILL.md"), "theirs\n");

    writeWorktreeSkills(worktree, [skill()]);
    writeWorktreeSkills(worktree, []);

    expect(readFileSync(join(worktree, ".agent", "skills", "pr-review", "SKILL.md"), "utf8")).toBe("theirs\n");
  });

  it("treats a file sitting where the folder goes as somebody else's too", () => {
    mkdirSync(join(worktree, ".agent", "skills"), { recursive: true });
    writeFileSync(join(worktree, ".agent", "skills", "pr-review"), "not even a folder\n");

    const written = writeWorktreeSkills(worktree, [skill()]);

    expect(written.undelivered.map((skill) => skill.slug)).toEqual(["pr-review"]);
    expect(readFileSync(join(worktree, ".agent", "skills", "pr-review"), "utf8")).toBe("not even a folder\n");
  });

  it("sweeps a folder another agent's delivery left, which is why a resumed turn writes its own again", () => {
    // One worktree, several agents, one `.agent/skills`. The sweep is
    // what stops a directory accumulating skills nobody attached — and
    // it is the reason `providers/codex.ts` re-delivers on resume rather
    // than trusting what its first turn wrote.
    writeWorktreeSkills(worktree, [skill({ id: "a", slug: "theirs-a" })]);

    const mine = writeWorktreeSkills(worktree, [skill()]);

    expect(mine.delivered.map((delivered) => delivered.slug)).toEqual(["pr-review"]);
    expect(existsSync(join(worktree, ".agent", "skills", "theirs-a"))).toBe(false);
  });

  /**
   * A delivery EO really made, in a checkout of its own.
   *
   * The target of the symlink tests below, and it has to be a genuine
   * one: the claim under test is that EO does not sweep a folder it
   * *would* recognise as its own if the path reached it, so a
   * hand-written marker would prove nothing.
   */
  function elsewhereWithADelivery(): string {
    const elsewhere = mkdtempSync(join(tmpdir(), "eo somewhere else "));
    writeWorktreeSkills(elsewhere, [skill()]);
    expect(eoOwnsSkillDirectory(join(elsewhere, ".agent", "skills", "pr-review"))).toBe(true);
    return elsewhere;
  }

  it.skipIf(process.platform === "win32")("will not follow a .agent symlink out of the worktree", () => {
    // `readdir`, `stat` and `exists` all follow a link, so a repository
    // that ships `.agent -> /somewhere` would have EO write its skills
    // outside the worktree it was given — and, worse, sweep the marked
    // folders it found there, which is another checkout's delivery.
    const elsewhere = elsewhereWithADelivery();
    const theirs = join(elsewhere, ".agent", "skills", "pr-review");
    const before = readFileSync(join(theirs, "checklist.md"), "utf8");
    symlinkSync(join(elsewhere, ".agent"), join(worktree, ".agent"), "dir");

    try {
      const written = writeWorktreeSkills(worktree, [skill()]);

      // Nothing delivered, and the reason names the link rather than
      // leaving a person to work out why a skill went missing.
      expect(written.delivered).toEqual([]);
      expect(written.undelivered.map((entry) => entry.slug)).toEqual(["pr-review"]);
      expect(written.undelivered[0]?.reason).toContain("symbolic link");
      // Nothing written through it...
      expect(readFileSync(join(theirs, "checklist.md"), "utf8")).toBe(before);
      // ...and the sweep did not reach the marked folder on the other
      // side either, on this dispatch or the one that delivers nothing.
      writeWorktreeSkills(worktree, []);
      expect(existsSync(join(theirs, "checklist.md"))).toBe(true);
      expect(existsSync(join(theirs, ".eo-delivered"))).toBe(true);
      // The link itself is left where the checkout put it.
      expect(existsSync(join(worktree, ".agent"))).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("will not follow a .agent/skills symlink either", () => {
    // The second door into the same room: `.agent` EO's own, `skills`
    // pointing somewhere else.
    const elsewhere = elsewhereWithADelivery();
    const theirs = join(elsewhere, ".agent", "skills", "pr-review");
    mkdirSync(join(worktree, ".agent"), { recursive: true });
    symlinkSync(join(elsewhere, ".agent", "skills"), join(worktree, ".agent", "skills"), "dir");

    try {
      const written = writeWorktreeSkills(worktree, [skill()]);

      expect(written.delivered).toEqual([]);
      expect(written.undelivered[0]?.reason).toContain("symbolic link");
      expect(existsSync(join(theirs, ".eo-delivered"))).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("treats a linked skill folder as somebody else's, whatever it points at", () => {
    // One level further down. The folder resolves to a delivery EO made
    // in another checkout, marker and all — and it is still a link this
    // checkout placed, so it is neither swept nor written over.
    const elsewhere = elsewhereWithADelivery();
    const theirs = join(elsewhere, ".agent", "skills", "pr-review");
    mkdirSync(join(worktree, ".agent", "skills"), { recursive: true });
    symlinkSync(theirs, join(worktree, ".agent", "skills", "pr-review"), "dir");

    try {
      const written = writeWorktreeSkills(worktree, [skill()]);

      expect(written.delivered).toEqual([]);
      expect(written.undelivered.map((entry) => entry.slug)).toEqual(["pr-review"]);
      expect(existsSync(join(theirs, ".eo-delivered"))).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("does not read a marker that is a link to one EO wrote", () => {
    // The marker is what EO wrote, not what a name resolves to. A link
    // to a real marker is the checkout borrowing EO's words about a
    // folder EO never made.
    const elsewhere = elsewhereWithADelivery();
    const theirs = join(worktree, ".agent", "skills", "pr-review");
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, "SKILL.md"), "theirs\n");
    symlinkSync(join(elsewhere, ".agent", "skills", "pr-review", ".eo-delivered"), join(theirs, ".eo-delivered"));

    try {
      expect(eoOwnsSkillDirectory(theirs)).toBe(false);
      writeWorktreeSkills(worktree, []);
      expect(readFileSync(join(theirs, "SKILL.md"), "utf8")).toBe("theirs\n");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("says which skills a blocked path cost rather than answering an empty hand", () => {
    // A skill is a convenience layered on a turn that runs either way,
    // so an unwritable checkout dispatches without them — but silently
    // is exactly the failure this story exists to remove. Provoked with
    // a file where the directory goes, which is portable in a way chmod
    // is not.
    writeFileSync(join(worktree, ".agent"), "in the way\n");

    const written = writeWorktreeSkills(worktree, [skill(), skill({ id: "b", slug: "release" }), skill({ id: "c", slug: "plain", files: [] })]);

    // No skill with files offered, because EO cannot say what survived a
    // failure that can land part-way through. One with none needs no
    // disk, so the blocked path costs it nothing (EO-721).
    expect(written.delivered.map((entry) => entry.slug)).toEqual(["plain"]);
    // And every skill it cost named, with the reason a person can act
    // on rather than a bare count.
    expect(written.undelivered.map((entry) => entry.slug)).toEqual(["pr-review", "release"]);
    for (const entry of written.undelivered) {
      // Named before anything is attempted, so the sentence is EO's own
      // rather than an errno a person has to interpret.
      expect(entry.reason).toContain(WORKTREE_AGENT_DIRECTORY);
      expect(entry.reason).toContain("is a file rather than a directory");
    }
  });

  it("does not take a folder whose .eo-delivered is somebody's own file", () => {
    // The marker is a claim, and a claim is its content. A file merely
    // *named* `.eo-delivered` is a file a repository is free to have,
    // and treating its existence as proof would put EO back to deleting
    // unmanaged content — the same bug as a top-level record, in a
    // smaller box.
    const theirs = join(worktree, ".agent", "skills", "pr-review");
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, "SKILL.md"), "theirs\n");
    writeFileSync(join(theirs, ".eo-delivered"), "a note of my own, nothing to do with EO\n");

    const written = writeWorktreeSkills(worktree, [skill()]);

    // Neither swept as EO's...
    expect(readFileSync(join(theirs, "SKILL.md"), "utf8")).toBe("theirs\n");
    expect(readFileSync(join(theirs, ".eo-delivered"), "utf8")).toBe("a note of my own, nothing to do with EO\n");
    // ...nor written over, so it comes back as undelivered.
    expect(written.delivered).toEqual([]);
    expect(written.undelivered.map((entry) => entry.slug)).toEqual(["pr-review"]);
    // And the same file is not proof on the next dispatch either.
    writeWorktreeSkills(worktree, []);
    expect(existsSync(join(theirs, "SKILL.md"))).toBe(true);
  });

  it("reads only the sentinel, and declines a marker too large to be one of EO's", () => {
    // The file being read is one EO found in a checkout. A megabyte of
    // somebody's data under that name is a file to decline rather than
    // to load, and it is still not a claim.
    const theirs = join(worktree, ".agent", "skills", "pr-review");
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, "keep.txt"), "theirs\n");
    writeFileSync(join(theirs, ".eo-delivered"), `EO-DELIVERED-SKILL-FOLDER v1\n${"x".repeat(5000)}`);

    expect(eoOwnsSkillDirectory(theirs)).toBe(false);
    writeWorktreeSkills(worktree, []);
    expect(existsSync(join(theirs, "keep.txt"))).toBe(true);
  });

  it("recognises its own marker, so a delivery it made is swept next time", () => {
    // The other direction, so the check above is not vacuously strict:
    // what EO writes, EO reads back as its own.
    writeWorktreeSkills(worktree, [skill()]);

    expect(eoOwnsSkillDirectory(join(worktree, ".agent", "skills", "pr-review"))).toBe(true);
  });
});

describe("worktreeSkillFiles", () => {
  it("is the generated directory's layout, less SKILL.md (EO-721)", () => {
    expect(worktreeSkillFiles([skill()]).map((file) => file.path)).toEqual(["skills/pr-review/checklist.md"]);
  });

  it("is ordered by slug, so two dispatches of one attachment set write the same bytes", () => {
    const files = worktreeSkillFiles([skill({ id: "b", slug: "release" }), skill()]);

    expect(files.map((file) => file.path)).toEqual(["skills/pr-review/checklist.md", "skills/release/checklist.md"]);
  });
});

describe("skillReadAnswer", () => {
  it("answers with the body and names the folder and files the supporting files are in", () => {
    const answer = skillReadAnswer(skill());

    expect(answer.text).toContain(DISTINCTIVE_BODY);
    expect(answer.text).toContain("`.agent/skills/pr-review/`");
    expect(answer.text).toContain("`checklist.md`");
    // The body, not the file: no frontmatter.
    expect(answer.text).not.toContain('name: "pr-review"');
    expect(answer.data).toEqual({ slug: "pr-review", directory: ".agent/skills/pr-review", files: ["checklist.md"] });
  });

  it("names no folder for a skill with no supporting files", () => {
    const answer = skillReadAnswer(skill({ files: [] }));

    expect(answer.text).toBe(`# PR review\n\n${DISTINCTIVE_BODY}`);
    expect(answer.data).toEqual({ slug: "pr-review", directory: null, files: [] });
  });
});

describe("worktreeSkillsPromptSection", () => {
  it("names each skill's slug and description, and says to load one with skill_read on the eo server (EO-721)", () => {
    const section = worktreeSkillsPromptSection([skill()]);

    expect(section).toContain("`pr-review`");
    expect(section).toContain("How this house reviews a pull request.");
    expect(section).toContain("`skill_read`");
    expect(section).toContain("registers as `eo`");
    // No file to read, and neither backend's spelling of a tool id.
    expect(section).not.toContain("SKILL.md");
    expect(section).not.toContain("mcp__eo__");
    expect(section).not.toContain("eo/skill_read");
  });

  it("never carries the body — the split is the whole point", () => {
    // `SkillSchema` divides a skill deliberately: the description is
    // what the model reads to choose, the body is what it reads once it
    // has chosen. Inlining the bodies would put every one of them in the
    // context of every turn, whether or not the turn is about any of
    // them, which is the thing progressive disclosure exists to avoid.
    const section = worktreeSkillsPromptSection([skill(), skill({ id: "b", slug: "release", name: "Release" })]);

    expect(section).not.toContain(DISTINCTIVE_BODY);
    expect(section).not.toContain("- [ ] tests"); // nor a supporting file's content
  });

  it("leaves a disable-model-invocation skill out of the choices while still delivering it", () => {
    const quiet = skill({ slug: "manual-only", disableModelInvocation: true });

    // Delivered, because a person invoking it by name still has to reach it.
    expect(writeWorktreeSkills(worktree, [quiet]).delivered.map((delivered) => delivered.slug)).toEqual(["manual-only"]);
    expect(existsSync(join(worktree, ".agent", "skills", "manual-only", "checklist.md"))).toBe(true);
    // Absent from the list, which is exactly what the flag means on the
    // other backend: delivered, absent from what the model is choosing
    // between.
    expect(worktreeSkillsPromptSection([quiet])).toBe("");
  });

  it("is empty rather than an empty heading when nothing was delivered", () => {
    expect(worktreeSkillsPromptSection([])).toBe("");
  });

  it("keeps a multi-line description on one line", () => {
    // A description is free text somebody typed. A newline in one would
    // end the bullet and turn the remainder into prose the model reads
    // as instruction rather than as a choice.
    const section = worktreeSkillsPromptSection([skill({ description: "First line.\n\nSecond line." })]);

    expect(section).toContain("- `pr-review` — First line. Second line.");
  });
});

/**
 * What EO may not delete when it lets go of a worktree (EO-207).
 *
 * The other half of the ownership marker, and the half a review caught:
 * EO excludes `.agent` from git so its delivery does not fail every
 * run's `clean` step, and that exclusion also takes the directory out of
 * git's own refusal to remove a worktree with untracked content in it.
 * `workspace/worktrees.ts` asks this before it destroys anything.
 */
describe("unmanagedAgentEntries", () => {
  it("is nothing for a worktree that has no .agent at all", () => {
    expect(unmanagedAgentEntries(worktree)).toEqual([]);
  });

  it("is nothing when .agent holds only what EO delivered", () => {
    writeWorktreeSkills(worktree, [skill(), skill({ id: "b", slug: "release" })]);

    // Derived, and going with the worktree costs nobody anything.
    expect(unmanagedAgentEntries(worktree)).toEqual([]);
  });

  it("names a file at the top of .agent, a folder beside skills, and a skill EO did not write", () => {
    writeWorktreeSkills(worktree, [skill()]);
    writeFileSync(join(worktree, ".agent", "notes.md"), "mine\n");
    mkdirSync(join(worktree, ".agent", "prompts"), { recursive: true });
    mkdirSync(join(worktree, ".agent", "skills", "theirs"), { recursive: true });

    expect(unmanagedAgentEntries(worktree)).toEqual([
      ".agent/notes.md",
      ".agent/prompts",
      ".agent/skills/theirs",
    ]);
  });

  it.skipIf(process.platform === "win32")("counts a linked .agent without walking through it", () => {
    // `readdir` through a link lists the target, so a worktree pointing
    // at somebody else's directory would be reported as holding nothing
    // of theirs — and then removed, taking the link and answering for a
    // directory EO never looked at.
    const elsewhere = mkdtempSync(join(tmpdir(), "eo somewhere else "));
    writeWorktreeSkills(elsewhere, [skill()]);
    symlinkSync(join(elsewhere, ".agent"), join(worktree, ".agent"), "dir");

    try {
      expect(unmanagedAgentEntries(worktree)).toEqual([".agent"]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("counts a folder whose marker is not EO's sentinel", () => {
    const theirs = join(worktree, ".agent", "skills", "pr-review");
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, ".eo-delivered"), "not EO's sentence\n");

    expect(unmanagedAgentEntries(worktree)).toEqual([".agent/skills/pr-review"]);
  });
});
