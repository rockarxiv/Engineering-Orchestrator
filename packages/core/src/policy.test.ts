import { describe, expect, it } from "vitest";
import {
  backendAllowed,
  bindingRefusal,
  disallowedBackendRefusal,
  managedServerIds,
  moneyLabel,
  NO_POLICY,
  NOT_ALLOWED_BY_YOUR_ORGANISATION,
  OrganisationPolicySchema,
  ORGANISATION_SECRET_LINE,
  overPersonBudget,
  personBudgetAcross,
  personBudgetLine,
  personBudgetRefusal,
  type OrganisationPolicy,
} from "./policy.js";

/**
 * What an organisation decides for everybody, as pure functions
 * (EO-328, `ARCHITECTURE.md`, "Policy").
 *
 * The behaviour that matters here is the one an installation with no
 * organisation depends on: every check answers "allowed" and every
 * budget answers "no ceiling", so a solo desktop is untouched by the
 * existence of any of this.
 */

function policy(overrides: Partial<OrganisationPolicy> = {}): OrganisationPolicy {
  return { ...NO_POLICY, ...overrides };
}

describe("allowed backends", () => {
  it("allows everything when the organisation has not said", () => {
    expect(backendAllowed(NO_POLICY, "claude")).toBe(true);
    expect(backendAllowed(NO_POLICY, "codex")).toBe(true);
  });

  it("allows only what is listed", () => {
    const allowed = policy({ allowedBackends: ["claude"] });
    expect(backendAllowed(allowed, "claude")).toBe(true);
    expect(backendAllowed(allowed, "codex")).toBe(false);
  });

  it("tells an empty list apart from no list at all", () => {
    // Two opposite answers that a nullable-versus-empty collapse would
    // have made one: "we have not decided" and "no agent may run".
    expect(backendAllowed(policy({ allowedBackends: [] }), "claude")).toBe(false);
    expect(backendAllowed(policy({ allowedBackends: null }), "claude")).toBe(true);
  });

  it("does not refuse an agent that is bound to nothing", () => {
    // `UNBOUND_BACKEND`: a pack's role whose recommended backend nobody
    // here signed in to. The refusal it needs is the one that already
    // exists for an unbound agent.
    expect(backendAllowed(policy({ allowedBackends: ["claude"] }), "")).toBe(true);
  });

  it("names the backend asked for and the ones that were not refused", () => {
    const refusal = disallowedBackendRefusal({
      agentName: "Implementer",
      provider: "codex",
      policy: policy({ allowedBackends: ["claude", "fake"] }),
    });
    expect(refusal).toContain("Implementer");
    expect(refusal).toContain("codex");
    expect(refusal).toContain(NOT_ALLOWED_BY_YOUR_ORGANISATION);
    expect(refusal).toContain('"claude" and "fake"');
  });

  it("says so rather than rendering an empty list when nothing is allowed", () => {
    const refusal = disallowedBackendRefusal({ agentName: "Implementer", provider: "codex", policy: policy({ allowedBackends: [] }) });
    expect(refusal).toContain("allows no backend at all");
  });

  it("says something different to whoever is trying to bind one", () => {
    // Two moments, two verbs. The dispatch refusal is written on a
    // thread after the fact — "nothing was dispatched", with an agent to
    // go and re-point. This is answered to somebody standing in the
    // editor, so it says what will not be written and what to pick.
    const refusal = bindingRefusal({ provider: "codex", policy: policy({ allowedBackends: ["claude"] }) });
    expect(refusal).toContain(NOT_ALLOWED_BY_YOUR_ORGANISATION);
    expect(refusal).toContain("nothing was saved");
    expect(refusal).toContain('Pick "claude"');
    expect(refusal).not.toContain("dispatched");
  });

  it("does not send somebody to a list of nothing when an organisation allows none", () => {
    expect(bindingRefusal({ provider: "codex", policy: policy({ allowedBackends: [] }) })).toContain("ask your admin");
  });
});

describe("a person's day", () => {
  it("writes the line §8.4 asks for", () => {
    expect(personBudgetLine({ spentCents: 300, budgetCents: 1000 })).toBe("your budget: $3 of $10 today");
  });

  it("keeps cents as cents below a dollar", () => {
    expect(moneyLabel(42)).toBe("42¢");
    expect(moneyLabel(0)).toBe("0¢");
    expect(moneyLabel(100)).toBe("$1");
    expect(moneyLabel(1_250)).toBe("$12.50");
  });

  it("is over at the ceiling, not past it", () => {
    // The same boundary the per-item and daily guards use: reaching the
    // budget is spending it.
    expect(overPersonBudget({ spentCents: 999, budgetCents: 1000 })).toBe(false);
    expect(overPersonBudget({ spentCents: 1000, budgetCents: 1000 })).toBe(true);
    expect(overPersonBudget({ spentCents: 1001, budgetCents: 1000 })).toBe(true);
  });

  it("takes the largest of two readings that are each short in a different way", () => {
    // A managed desktop has two sources for one figure and neither is
    // complete: the record has not heard about the run this machine just
    // finished, and this machine has never heard about the other
    // desktop's. One function, because the dispatch guard and the top
    // bar both use it and a person watching "$0 of $10" while their work
    // is refused has no way to tell which of the two is lying.
    expect(personBudgetAcross(1_000, [1_000, 0])).toEqual({ spentCents: 1_000, budgetCents: 1_000 });
    expect(personBudgetAcross(1_000, [0, 700])).toEqual({ spentCents: 700, budgetCents: 1_000 });
    // Not a sum: the record may already have been told about this
    // machine's share, and counting it twice would refuse work that is
    // within the ceiling.
    expect(personBudgetAcross(1_000, [900, 250])).toEqual({ spentCents: 900, budgetCents: 1_000 });
  });

  it("reads no readings at all as nothing spent, rather than as minus infinity", () => {
    // What `Math.max` answers with an empty list, and a figure no screen
    // could draw.
    expect(personBudgetAcross(1_000, [])).toEqual({ spentCents: 0, budgetCents: 1_000 });
  });

  it("names the budget in the refusal, which is the acceptance criterion", () => {
    const refusal = personBudgetRefusal({ spentCents: 1000, budgetCents: 1000 });
    expect(refusal).toContain("$10");
    expect(refusal).toContain("Your organisation");
  });
});

describe("organisation secrets", () => {
  it("is honest about what it claims", () => {
    // ARCHITECTURE.md, "Secrets": not "never readable". A module receives these as
    // environment variables and an agent with a shell reads its own
    // environment, so the claim EO can keep is that it does not show it.
    expect(ORGANISATION_SECRET_LINE).toBe("set by your organisation · not shown here");
    expect(ORGANISATION_SECRET_LINE).not.toContain("never readable");
  });

  it("publishes names and nothing else", () => {
    // The row a screen draws is drawn from this list, so nothing has to
    // go near a value to decide whether to say "set by your
    // organisation".
    expect(policy({ secretNames: ["FLY_API_TOKEN"] }).secretNames).toEqual(["FLY_API_TOKEN"]);
    expect(NO_POLICY.secretNames).toEqual([]);
  });
});

describe("the published policy", () => {
  it("reads a copy written by a build that knew fewer fields", () => {
    // A desktop pulls this from a server that may be a release ahead or
    // behind, so a partial object has to parse rather than throw.
    const parsed = OrganisationPolicySchema.parse({ allowedBackends: ["claude"] });
    expect(parsed.perPersonDailyBudgetCents).toBeNull();
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.secretNames).toEqual([]);
    expect(parsed.publishedAt).toBeNull();
  });

  it("answers which catalogue rows are the organisation's", () => {
    const published = policy({
      mcpServers: [{ id: "s1", name: "github", description: "", config: { transport: "stdio", command: "gh", args: [] }, envNames: [] }],
    });
    expect(managedServerIds(published)).toEqual(["s1"]);
    expect(managedServerIds(NO_POLICY)).toEqual([]);
  });

  it("hands out a frozen empty policy, so nobody publishes one by accident", () => {
    expect(Object.isFrozen(NO_POLICY)).toBe(true);
  });
});
