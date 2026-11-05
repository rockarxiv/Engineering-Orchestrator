import { describe, expect, it } from "vitest";
import {
  PREVIEW_AGENT_KEY,
  THREAD_PER_CONVERSATION_ACTIONS,
  isThreadPerConversationAction,
  resultsFromRoutes,
  rolesStaffedFor,
  staffingAgents,
  staffsItem,
} from "./index.js";
import type { StaffingAgent, StepResult, Uuid } from "./index.js";

/**
 * The rooms whose item is one chat (EO-210, EO-356).
 */
describe("isThreadPerConversationAction", () => {
  it("names the two rooms and nothing else", () => {
    // Discussions' `discuss` and the Architecture panel's `configure`
    // went with their rooms (EO-526).
    expect([...THREAD_PER_CONVERSATION_ACTIONS]).toEqual(["assist", "scenario"]);
    for (const action of THREAD_PER_CONVERSATION_ACTIONS) expect(isThreadPerConversationAction(action)).toBe(true);
    // `interpret` and `respond` are the system agent's other two, and
    // both run against a real work item.
    for (const action of ["interpret", "respond", "discuss", "configure", "discussion", "assistant", ""]) {
      expect(isThreadPerConversationAction(action), action).toBe(false);
    }
  });

  it("takes an absent action as a no, never as a match", () => {
    expect(isThreadPerConversationAction(null)).toBe(false);
    expect(isThreadPerConversationAction(undefined)).toBe(false);
  });
});


/**
 * A human step's results against its routes (EO-310).
 *
 * Every writer of a graph runs its user steps through this before
 * submitting one, so what it decides about each field is what a person
 * ends up pressing. Three of the four fields belong to the route row —
 * the only place any of them is edited — and one belongs to the
 * declaration, because nothing else edits it.
 */
describe("resultsFromRoutes", () => {
  const route = (resultKey: string, label: string, tone: StepResult["tone"], position: number) => ({
    fromStepId: "approval",
    resultKey,
    label,
    tone,
    position,
  });

  const step = (results: StepResult[] = []) => ({ id: "approval", type: "user" as const, results });

  it("offers one result per branch, in the routes' own order", () => {
    const results = resultsFromRoutes(step(), [route("send_back", "Send back", "warning", 1), route("approved", "Approve", "success", 0)]);

    expect(results.map((result) => result.key)).toEqual(["approved", "send_back"]);
  });

  /**
   * The regression EO-310's review caught. The result row on the
   * configuration screen writes its Label and Tone onto the *route* —
   * there is no second editor for either — so a declaration that kept
   * its own copy showed the old words on the button after a rename.
   */
  it("takes the row's words and colour every time, even for a key already declared", () => {
    const declared = step([{ key: "approved", label: "Approve", tone: "success", requiresComment: false }]);

    const [result] = resultsFromRoutes(declared, [route("approved", "Accept", "warning", 0)]);

    expect(result).toEqual({ key: "approved", label: "Accept", tone: "warning", requiresComment: false });
  });

  /**
   * And the field that goes the other way. Whether taking a result needs
   * a reason is not on the edge — it is a property of the decision — so
   * rewiring around it must not quietly drop it, and the tone it now
   * carries must not decide it either.
   */
  it("keeps whether a reason is needed, whatever the row's tone becomes", () => {
    const declared = step([
      { key: "approved", label: "Approve", tone: "success", requiresComment: true },
      { key: "send_back", label: "Send back", tone: "warning", requiresComment: false },
    ]);

    const results = resultsFromRoutes(declared, [route("approved", "Approve", "warning", 0), route("send_back", "Send back", "success", 1)]);

    expect(results.map((result) => result.requiresComment)).toEqual([true, false]);
  });

  /** A row nobody has configured starts from the design: a non-approving result asks why. */
  it("starts an undeclared key from its tone", () => {
    const results = resultsFromRoutes(step(), [route("approved", "Approve", "success", 0), route("send_back", "Send back", "warning", 1)]);

    expect(results.map((result) => result.requiresComment)).toEqual([false, true]);
  });

  /** An agent, a builtin and a module each report their own result; there is nobody there to offer anything to. */
  it("offers nothing on a step nobody decides on", () => {
    expect(resultsFromRoutes({ id: "approval", type: "agent", results: [] }, [route("approved", "Approve", "success", 0)])).toEqual([]);
  });

  it("offers nothing for branches out of another step", () => {
    expect(resultsFromRoutes(step(), [{ ...route("approved", "Approve", "success", 0), fromStepId: "elsewhere" }])).toEqual([]);
  });
});

describe("the staffing rule — agents scoped to a project (EO-474)", () => {
  const P = "0199aa00-0000-7000-8000-0000000000a1" as Uuid;
  const Q = "0199aa00-0000-7000-8000-0000000000a2" as Uuid;
  const agent = (name: string, overrides: Partial<StaffingAgent> = {}): StaffingAgent & { name: string } => ({
    name,
    role: "implementer",
    enabled: true,
    archivedAt: null,
    config: {},
    projectId: null,
    ...overrides,
  });
  const real = (projectId: Uuid | null) => ({ previewAt: null, projectId });

  it("a global agent staffs every item; a project's own staffs that project's and nothing else", () => {
    expect([real(P), real(Q), real(null)].map((item) => staffsItem(agent("g"), item))).toEqual([true, true, true]);
    expect([real(P), real(Q), real(null)].map((item) => staffsItem(agent("p", { projectId: P }), item))).toEqual([true, false, false]);
  });

  it("keeps the preview rule beside the scope: a preview's own agent runs previews only", () => {
    const rehearsal = agent("preview", { config: { [PREVIEW_AGENT_KEY]: true } });
    expect(staffsItem(rehearsal, real(P))).toBe(false);
    expect(staffsItem(rehearsal, { previewAt: 1, projectId: P })).toBe(true);
  });

  it("takes the global agents off a project's item while the project has a dispatchable one of its own", () => {
    const agents = [agent("global"), agent("p", { projectId: P }), agent("q", { projectId: Q })];
    expect(staffingAgents(agents, "implementer", real(P)).map((a) => a.name)).toEqual(["p"]);
    expect(staffingAgents(agents, "implementer", real(Q)).map((a) => a.name)).toEqual(["q"]);
    expect(staffingAgents([agent("global"), agent("p", { projectId: P })], "implementer", real(Q)).map((a) => a.name)).toEqual(["global"]);
    expect(staffingAgents(agents, "implementer", real(null)).map((a) => a.name)).toEqual(["global"]);
  });

  it("falls back to the global agents when the project's own is not dispatchable, or holds another role", () => {
    for (const own of [agent("p", { projectId: P, enabled: false }), agent("p", { projectId: P, archivedAt: 1 }), agent("p", { projectId: P, role: "reviewer" })]) {
      expect(staffingAgents([agent("global"), own], "implementer", real(P)).map((a) => a.name)).toEqual(["global"]);
    }
  });

  it("is empty for a step with no role", () => {
    expect(staffingAgents([agent("global")], null, real(P))).toEqual([]);
  });

  it("names a role staffed for a pipeline's work exactly when somebody would be dispatched for it", () => {
    const agents = [agent("p", { projectId: P }), agent("r", { role: "reviewer" })];
    expect(rolesStaffedFor(agents, real(P)).sort()).toEqual(["implementer", "reviewer"]);
    expect(rolesStaffedFor(agents, real(Q))).toEqual(["reviewer"]);
  });
});
