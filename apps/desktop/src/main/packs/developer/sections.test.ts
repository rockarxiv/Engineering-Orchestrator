import { assembleContext, assembleSeedContext, type AssembleContextInput, type AssembleSeedContextInput } from "@eo/engine";
import { actionOverridesFor, developerRegistry, eoToolName, ATTACHMENT_ADD_TOOL_NAME, FOLDER_KIND, GIT_WORKTREE_KIND, NONE_KIND, SCRATCH_KIND } from "@eo/core";
import { describe, expect, it } from "vitest";
import { developerSectionRenderers } from "./sections.js";
import { TICKET_FILES_DIRECTORY } from "./workspace/ticketFiles.js";

/**
 * What an item of this pack's own types says its actions mean (KAN-163).
 *
 * Resolved off the real registry rather than written out here, because
 * that is what `buildDispatchContext` hands the assembly and because the
 * point of these tests is which words a *type* gets: a story's `refine`
 * is answered in the clarify shape and a feature's is not, and neither
 * this file nor the renderer knows either word.
 */
const overridesOf = (slug: string) => {
  const registry = developerRegistry();
  return actionOverridesFor(registry, registry.itemTypes.get(`developer:${slug}`));
};

/**
 * The prompt sections this pack writes (KAN-161).
 *
 * They used to live in `packages/engine/src/context.ts`, where the tests
 * that held them to their words lived too. The words have not changed
 * and neither has where they land — what changed is who owns them — so
 * these are those tests, run against the real renderers through the real
 * assembly rather than against a fixture.
 */

function full(overrides: Partial<AssembleContextInput> = {}): AssembleContextInput {
  return {
    action: "implement",
    item: { key: "EO-1", title: "A story", body: "Do the thing.", acceptanceCriteria: ["It does the thing."], actionOverrides: overridesOf("story"), workspaceKind: "none" },
    sectionRenderers: developerSectionRenderers,
    parentFeature: null,
    commentThread: [],
    dependencies: [],
    maxTokens: 10_000,
    ...overrides,
  };
}

function seed(overrides: Partial<AssembleSeedContextInput> = {}): AssembleSeedContextInput {
  return {
    action: "implement",
    item: { key: "EO-1", title: "A story", body: "Do the thing.", acceptanceCriteria: ["It does the thing."], actionOverrides: overridesOf("story"), workspaceKind: "none" },
    sectionRenderers: developerSectionRenderers,
    dependencyKeys: [],
    stepComments: [],
    humanComments: [],
    omitted: { total: 0, byAuthorAndKind: [], attachments: [] },
    ...overrides,
  };
}

/** The section by id, or null where it said nothing. */
function section(input: AssembleContextInput, id: string): string | null {
  return assembleContext(input).contributedSections.find((entry) => entry.id === id)?.text ?? null;
}

describe("what the work is judged against", () => {
  it("renders the acceptance criteria under the item, where they have always been", () => {
    const { fullText } = assembleContext(full());

    expect(fullText).toContain("## Acceptance Criteria\n- It does the thing.");
    expect(fullText.indexOf("# EO-1: A story")).toBeLessThan(fullText.indexOf("## Acceptance Criteria"));
  });

  it("renders them on a seeded dispatch too, which is most of them", () => {
    // An implementer and a reviewer are both seeded. A section that
    // reached only the full assembly would be missing from nearly every
    // prompt EO sends.
    expect(assembleSeedContext(seed()).fullText).toContain("## Acceptance Criteria\n- It does the thing.");
  });

  it("says nothing at all where an item declares none", () => {
    // Not an empty heading: a review of an item with no criteria is
    // refused before it is dispatched (`developerDispatchGate`), and on
    // every other action a bare heading is a section about nothing.
    const { fullText } = assembleContext(full({ item: { key: "EO-1", title: "T", body: null, acceptanceCriteria: [], actionOverrides: overridesOf("story"), workspaceKind: "none" } }));

    expect(fullText).not.toContain("Acceptance Criteria");
  });

  it("carries every criterion, in the order they were written", () => {
    expect(section(full({ item: { key: "EO-9", title: "T", body: null, acceptanceCriteria: ["Criterion A", "Criterion B"], actionOverrides: overridesOf("story"), workspaceKind: "none" } }), "acceptanceCriteria")).toBe(
      "## Acceptance Criteria\n- Criterion A\n- Criterion B",
    );
  });
});

/**
 * Plan mode's closing line (KAN-18).
 *
 * The engine asks the implementer to change nothing. This is the
 * sentence that says the promise is checked — and it is this pack's to
 * say, because `worktreeIsClean` is this pack's hook.
 */
describe("saying that the checkout is inspected afterwards", () => {
  it("warns that the worktree is checked, because it is", () => {
    // The guard exists either way; saying so is what makes it a rule
    // rather than a trap.
    expect(assembleContext(full({ action: "implement", planMode: true })).fullText).toContain("checked after this run");
  });

  it("reads as the last line of the plan-mode instruction", () => {
    const { fullText } = assembleContext(full({ action: "implement", planMode: true }));

    expect(fullText).toContain("adjust the plan and propose again.\n\nThe worktree is checked after this run:");
  });

  it("says nothing with plan mode off, or on any other action", () => {
    expect(section(full({ action: "implement" }), "planModeCheck")).toBeNull();
    for (const action of ["intake", "refine", "review"]) {
      expect(section(full({ action, planMode: true }), "planModeCheck"), action).toBeNull();
    }
  });
});

/**
 * Work that arrived already written (KAN-19).
 *
 * `refine` reaches this prompt for two different jobs, and the product
 * owner's instructions describe only one of them. This section is how it
 * learns which it has been handed — so a story someone wrote is checked
 * rather than replaced by stories an agent invented.
 */
describe("refining something already written", () => {
  const leaf = (overrides: Partial<AssembleContextInput> = {}) => full({ action: "refine", ...overrides });
  const container = (overrides: Partial<AssembleContextInput> = {}) =>
    full({ action: "refine", item: { key: "EO-1", title: "A feature", body: "Do the thing.", acceptanceCriteria: [], actionOverrides: overridesOf("feature"), workspaceKind: "none" }, ...overrides });

  it("tells the product owner not to decompose it", () => {
    const text = section(leaf(), "clarify");

    expect(text).toContain("do not decompose it");
    expect(text).toContain("Ignore the `refine` section");
  });

  it("routes a real question through the one path that parks an item", () => {
    // Not a `ready: false` field: a question has to end the run and wait
    // for a reply, which is what a blocking mention does (A-03).
    const text = section(leaf(), "clarify");

    expect(text).toContain("clarification_required");
    expect(text).toContain("rather than writing a comment");
    // Still the load-bearing promise: asking ends the run.
    expect(text).toContain("Your run ends there");
  });

  it("says nothing for a container, byte for byte", () => {
    // Decomposition is the overwhelming case and must be untouched. What
    // decides comes off the item type row now rather than off the word
    // "feature" — the flag from KAN-146, the type's own answer for the
    // action since KAN-163 — and the words are unchanged through both.
    expect(section(container(), "clarify")).toBeNull();
    expect(assembleContext(container()).fullText).toBe(
      assembleContext(container({ sectionRenderers: developerSectionRenderers.filter((renderer) => renderer.id !== "clarify") })).fullText,
    );
  });

  it("says nothing on any other action", () => {
    for (const action of ["intake", "implement", "review"]) {
      expect(section(full({ action }), "clarify"), action).toBeNull();
    }
  });

  it("sits above the item, so it is read before the work is", () => {
    const { fullText } = assembleContext(leaf());

    expect(fullText.indexOf("## This is already written")).toBeLessThan(fullText.indexOf("# EO-1: A story"));
  });
});

describe("where a file for the ticket goes (EO-413)", () => {
  const story = (workspaceKind: string) => ({ key: "EO-1", title: "A story", body: "Do the thing.", acceptanceCriteria: ["It does the thing."], actionOverrides: overridesOf("story"), workspaceKind });
  const count = (text: string, needle: string): number => text.split(needle).length - 1;
  const TOOL = eoToolName(ATTACHMENT_ADD_TOOL_NAME);

  it("names the directory and the tool once on a git workspace, in the full assembly and the seed alike", () => {
    for (const { fullText } of [assembleContext(full({ item: story(GIT_WORKTREE_KIND) })), assembleSeedContext(seed({ item: story(GIT_WORKTREE_KIND) }))]) {
      expect(count(fullText, `\`${TICKET_FILES_DIRECTORY}/\``)).toBe(1);
      expect(count(fullText, TOOL)).toBe(1);
    }
  });

  it("names the tool the way an agent can call it, on either backend", () => {
    // The qualified name `eoToolName` gives, which is the one both
    // providers advertise (invariant 12) — not the bare name the server
    // uses for itself, and not one backend's punctuation written out.
    const text = section(full({ item: story(GIT_WORKTREE_KIND) }), "ticketFiles");

    expect(text).toContain("`mcp__eo__attachment_add`");
  });

  it("says it on every action a run on a git workspace is dispatched for", () => {
    for (const action of ["implement", "review", "refine"]) {
      expect(section(full({ action, item: story(GIT_WORKTREE_KIND) }), "ticketFiles")).not.toBeNull();
    }
  });

  it.each([FOLDER_KIND, SCRATCH_KIND, NONE_KIND])("says nothing on a %s workspace", (workspaceKind) => {
    const fullText = [assembleContext(full({ item: story(workspaceKind) })).fullText, assembleSeedContext(seed({ item: story(workspaceKind) })).fullText].join("\n");

    expect(section(full({ item: story(workspaceKind) }), "ticketFiles")).toBeNull();
    expect(fullText).not.toContain(TICKET_FILES_DIRECTORY);
    expect(fullText).not.toContain(TOOL);
  });

  it("is not sent again on a resumed thread, which already holds it", () => {
    expect(developerSectionRenderers.find((renderer) => renderer.id === "ticketFiles")?.volatile ?? false).toBe(false);
  });
});
