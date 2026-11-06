import { describe, expect, it } from "vitest";
import { loadRolePrompt } from "./prompts.js";

/**
 * What the system agent is taught about a module asked for on its own
 * (EO-398): it is proposed with `modules`, it arrives as a card, and the
 * person approves it there.
 *
 * Held here because the prompt is the only place the agent learns the
 * route exists. Before this it was told the opposite — that `modules`
 * without a `draft` is refused — and a prompt still saying so would send
 * it back to writing the catalog directly, with nothing in the chat to
 * approve from.
 */

const prompt = loadRolePrompt("system")!;

/** The section the route is taught in: from its heading to the next one. */
function ownModuleSection(): string {
  const start = prompt.indexOf("### A module on its own");
  expect(start).toBeGreaterThan(-1);
  // The next heading of any depth: fixing a module has a section of its own after this one (EO-401).
  const next = /\n#{1,3} /.exec(prompt.slice(start + 1));
  return next ? prompt.slice(start, start + 1 + next.index) : prompt.slice(start);
}

describe("what the system agent's prompt says about a module on its own", () => {
  it("says it is proposed with `modules` and no `draft`, and approved on its card", () => {
    const section = ownModuleSection().replace(/\s+/g, " ");
    expect(section).toContain("return it in `modules` and leave `draft` out");
    expect(section).toContain("**its own card**");
    expect(section).toContain("**View code**");
    expect(section).toContain("**The person approves it on that card.**");
    expect(section).toContain("`tests`");
  });

  it("lists it among the proposals a person acts on", () => {
    expect(prompt.replace(/\s+/g, " ")).toContain("**A new module is a card.**");
  });

  it("no longer says `modules` without a `draft` is refused, or that a module on its own is `module_save`", () => {
    const flat = prompt.replace(/\s+/g, " ");
    expect(flat).not.toContain("`modules` without a `draft` is refused");
    expect(flat).not.toContain("a module on its own is still `module_save`");
    expect(ownModuleSection().replace(/\s+/g, " ")).toContain("Do not save a module the person asked you for with `module_save`");
  });

  it("does not send anyone to Settings → Modules to approve it", () => {
    const section = ownModuleSection().replace(/\s+/g, " ");
    expect(section).toContain("you do not send anyone to Settings → Modules");
    expect(section.match(/Settings → Modules/g)).toHaveLength(1);
  });

  // Invariant 12: a tool is named by the name every backend agrees on,
  // never with one harness's punctuation around it.
  it("names no backend-specific tool punctuation", () => {
    const section = ownModuleSection();
    expect(section).not.toMatch(/mcp__/);
    expect(section).not.toMatch(/\b[a-z_]+\/[a-z_]+\b/);
    expect(section).not.toMatch(/\b(claude|codex)\b/i);
  });

  it("is a newer version than the prompt that taught the refusal", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(12);
  });
});

/**
 * And about the modules a draft needs (EO-399): the draft card lists
 * them, each with View code and Approve, and holds Publish until the
 * last is approved. Before this the prompt sent the person to Settings →
 * Modules for them, away from the card that now does it.
 */
describe("what the system agent's prompt says about a draft's modules", () => {
  /** The section drafts from the chat are taught in, up to the one about a module on its own. */
  function draftSection(): string {
    const start = prompt.indexOf("**`modules` proposes the modules the draft needs**");
    expect(start).toBeGreaterThan(-1);
    return prompt.slice(start, prompt.indexOf("### A module on its own", start)).replace(/\s+/g, " ");
  }

  it("says a draft's modules are approved on the draft card, which holds Publish until they are", () => {
    const section = draftSection();
    expect(section).toContain("**the person approves a draft's modules on the draft card.**");
    expect(section).toContain("**View code**");
    expect(section).toContain("**Approve**");
    expect(section).toContain("holds Publish until the last one is approved");
  });

  it("no longer sends the person to Settings → Modules to approve them", () => {
    expect(draftSection()).not.toContain("the person does, in Settings → Modules");
  });

  it("says a module in the catalog that is not approved yet can be named by its id, on a card that waits on it", () => {
    const section = draftSection();
    expect(section).toContain("**not approved yet** can be named by its id");
    expect(section).toContain("a card that waits on it");
  });

  it("names no backend-specific tool punctuation", () => {
    const section = draftSection();
    expect(section).not.toMatch(/mcp__/);
    expect(section).not.toMatch(/\b(claude|codex)\b/i);
  });

  it("is a newer version than the prompt that sent them to Settings", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(13);
  });
});

/**
 * And about a module that failed approval (EO-401): the fix is proposed
 * again under the same slug, and replaces the one nobody approved. Before
 * this the prompt's only advice for a held slug was a new one, which left
 * the broken module behind in the catalog.
 */
describe("what the system agent's prompt says about fixing a module that failed approval", () => {
  function fixingSection(): string {
    const start = prompt.indexOf("### Fixing a module that failed approval");
    expect(start).toBeGreaterThan(-1);
    const next = /\n#{1,3} /.exec(prompt.slice(start + 1));
    return (next ? prompt.slice(start, start + 1 + next.index) : prompt.slice(start)).replace(/\s+/g, " ");
  }

  it("says it is fixed by proposing it again under the same slug", () => {
    const section = fixingSection();
    expect(section).toContain("**a module that failed approval is fixed by proposing it again under the same slug**");
    expect(section).toContain("Do not give it a new slug");
    expect(section).toContain("stays unapproved");
  });

  it("says a draft that uses it is proposed again with it", () => {
    expect(fixingSection()).toContain("**A draft that uses the module is proposed again with it**");
    expect(draftPointer()).toContain("propose the draft again with it");
  });

  /** Where the draft's own section sends the agent here. */
  function draftPointer(): string {
    const start = prompt.indexOf("**`modules` proposes the modules the draft needs**");
    return prompt.slice(start, prompt.indexOf("### A module on its own", start)).replace(/\s+/g, " ");
  }

  it("says how its test cases are matched, and that the earlier card gives way to the new one", () => {
    const section = fixingSection();
    expect(section).toContain("matched by `description`");
    expect(section).toContain("a case you do not list is kept");
    expect(section).toContain("the earlier card stops offering Approve");
  });

  it("says an approved module, and one a person wrote or imported, is never overwritten", () => {
    const section = fixingSection();
    expect(section).toContain("An approved module is never overwritten by a proposal");
    expect(section).toContain("neither is one a person wrote or imported, approved or not");
  });

  it("names no backend-specific tool punctuation", () => {
    const section = fixingSection();
    expect(section).not.toMatch(/mcp__/);
    expect(section).not.toMatch(/\b[a-z_]+\/[a-z_]+\b/);
    expect(section).not.toMatch(/\b(claude|codex)\b/i);
  });

  it("is a newer version than the prompt that knew only a new slug", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(14);
  });
});

/**
 * What it says about a module attaching files (EO-414).
 *
 * The agent writes modules and their tests from these instructions and
 * from nothing else, so a `ctx` call the prompt does not describe is one
 * no module it writes will ever make — and a harness field it does not
 * describe is one no test it writes will ever assert on.
 */
describe("what the system agent's prompt says about a module attaching files", () => {
  const flat = prompt.replace(/\s+/g, " ");

  it("describes ctx.attach: what it takes, what it answers and what it refuses", () => {
    expect(flat).toContain("`await ctx.attach(paths, caption)`");
    expect(flat).toContain("`{ attached: true }` or `{ attached: false, reason }`");
    expect(flat).toContain("up to eight");
    expect(flat).toContain("Only regular files inside `ctx.cwd`");
    expect(flat).toContain("symbolic link");
    expect(flat).toContain("20 MB");
    expect(flat).toContain("counts as one of the run's comments");
    expect(flat).toContain("mirrored to Jira the files are uploaded");
  });

  it("tells it to declare needs.attach", () => {
    expect(flat).toContain("`attach: true` if you attach files");
    expect(flat).toContain("`ticket`, `comment` and `attach` are not enforced");
  });

  it("describes ctx.createItem, its answer and its limits", () => {
    expect(flat).toContain("`await ctx.createItem(spec)`");
    expect(flat).toContain("`{ idempotencyKey, type, title, body, spec, pipeline, parent, repository, existingBranch, wait, dependsOn }`");
    expect(flat).toContain("`{ created: true, key, existing }` or `{ created: false, reason }`");
    expect(flat).toContain("never a container");
    expect(flat).toContain("A run may create ten items");
    expect(flat).toContain("a run on a generation 3 ticket cannot create");
    expect(flat).toContain("answers the first item's key with `existing: true`");
  });

  it("describes existingBranch: worked on instead of a cut branch, and refused where no branch is worked on (EO-648)", () => {
    expect(flat).toContain("`existingBranch` names a branch that already exists");
    expect(flat).toContain("pipeline whose entry step does not work on a branch, is refused and nothing is created");
    expect(flat).toContain("does not change the first ticket's branch");
  });

  it("tells it to declare needs.create, and that it is enforced", () => {
    expect(flat).toContain("`create: true` if you create work items");
    expect(flat).toContain("`bin`, `env` and `create` are enforced");
  });

  it("describes the harness's createItem fixture and created", () => {
    expect(flat).toContain("`createItem`: `[{ key: \"EO-9\" }, { reason: \"…\" }, …]`");
    expect(flat).toContain("creations answer `NEW-1`, `NEW-2` and so on");
    expect(flat).toContain("`created` is `[{ idempotencyKey, key, type, title, body, spec, pipeline, parent, repository, existingBranch, wait, dependsOn }]`");
  });

  /**
   * Waiting (EO-434). The sentence that matters most is the one a
   * module author would otherwise find out by watching work not
   * wait: what is held is the next step EO runs, and nothing else.
   */
  it("describes wait and dependsOn, and what waiting does and does not hold", () => {
    expect(flat).toContain('`wait` is `"none"` (the default), `"this_waits"` or `"created_waits"`');
    expect(flat).toContain('`dependsOn: ["EO-40"]`');
    expect(flat).toContain("a combination that would be circular");
    expect(flat).toContain("**Waiting does not pause the module.**");
    expect(flat).toContain("what is held is the *next step EO would run*");
    expect(flat).toContain("A step a person acts on is not held, and neither is the last step");
    expect(flat).toContain("a `wait` that is none of the three");
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(21);
  });

  it("is a newer version than the prompt that knew no ctx.createItem", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(20);
  });

  it("describes the harness's attachments", () => {
    expect(flat).toContain("`{ outcome, comments, attachments, created, logs, execs }`");
    expect(flat).toContain("`attachments` is `[{ key, caption, paths }]`");
    expect(flat).toContain("write it in `harness.cwd` before `harness.run`");
  });

  it("is a newer version than the prompt that knew no ctx.attach", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(15);
  });
});
