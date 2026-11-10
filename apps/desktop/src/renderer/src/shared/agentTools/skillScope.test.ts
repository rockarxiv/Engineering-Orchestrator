import { describe, expect, it } from "vitest";
import type { Skill, SkillScope } from "@eo/core";
import { scopeFromValue, scopeLabel, scopeOptions, scopeValue, skillsScopedTo, type ScopeTargets } from "./skillScope";

/**
 * What both layouts say and pick about a skill's scope (EO-470): one
 * spelling of a scope as a picker value, one sentence per scope, and the
 * one rule for which skills a project's or a workspace's settings list.
 */
const TARGETS: ScopeTargets = {
  projects: [{ id: "p1", name: "Shop" }],
  workspaces: [
    { id: "w1", label: "shop-api", projectId: "p1" },
    { id: "w2", label: "loose", projectId: null },
  ],
};

describe("a scope as a picker value", () => {
  it("round-trips every kind", () => {
    const scopes: SkillScope[] = [{ kind: "global" }, { kind: "project", projectId: "p1" }, { kind: "workspace", workspaceId: "w1" }];
    for (const scope of scopes) expect(scopeFromValue(scopeValue(scope))).toEqual(scope);
  });
});

describe("scopeLabel", () => {
  it("names the project or the workspace, and the workspace's project", () => {
    expect(scopeLabel({ kind: "global" }, TARGETS)).toBe("Every run");
    expect(scopeLabel({ kind: "project", projectId: "p1" }, TARGETS)).toBe("Runs on Shop");
    expect(scopeLabel({ kind: "workspace", workspaceId: "w1" }, TARGETS)).toBe("Runs in shop-api (Shop)");
    expect(scopeLabel({ kind: "workspace", workspaceId: "w2" }, TARGETS)).toBe("Runs in loose");
  });

  it("says a scope whose project or workspace is gone reaches no run", () => {
    expect(scopeLabel({ kind: "project", projectId: "gone" }, TARGETS)).toContain("no longer exists");
    expect(scopeLabel({ kind: "workspace", workspaceId: "gone" }, TARGETS)).toContain("reaches no run");
  });
});

describe("scopeOptions", () => {
  it("offers global, every project and every workspace", () => {
    expect(scopeOptions(TARGETS, { kind: "global" }).map((option) => option.value)).toEqual(["global", "project:p1", "workspace:w1", "workspace:w2"]);
  });

  it("keeps the scope a skill has even when its target is gone, so a save does not move it", () => {
    const options = scopeOptions(TARGETS, { kind: "project", projectId: "gone" });
    expect(options.at(-1)).toMatchObject({ value: "project:gone", group: "project" });
  });
});

describe("skillsScopedTo", () => {
  const skill = (id: string, scope: SkillScope, archivedAt: number | null = null): Skill => ({
    id,
    slug: id,
    name: id,
    description: "d",
    body: "b",
    files: [],
    disableModelInvocation: false,
    enabled: true,
    scope,
    createdAt: 0,
    updatedAt: 0,
    archivedAt,
    createdBy: "person",
    locked: false,
  });
  const all = [
    skill("everywhere", { kind: "global" }),
    skill("shop", { kind: "project", projectId: "p1" }),
    skill("archived-shop", { kind: "project", projectId: "p1" }, 1),
    skill("api", { kind: "workspace", workspaceId: "w1" }),
  ];

  it("lists exactly the live skills scoped to that project or workspace", () => {
    expect(skillsScopedTo(all, { kind: "project", projectId: "p1" }).map((entry) => entry.id)).toEqual(["shop"]);
    expect(skillsScopedTo(all, { kind: "workspace", workspaceId: "w1" }).map((entry) => entry.id)).toEqual(["api"]);
    expect(skillsScopedTo(all, { kind: "workspace", workspaceId: "w2" })).toEqual([]);
  });
});
