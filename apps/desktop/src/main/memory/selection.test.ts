import { MAX_SELECTED_MEMORIES, type MemoryEntryView, type MemorySelection, type SideCallResult } from "@eo/core";
import { describe, expect, it, vi } from "vitest";
import { chooseMemory, describeAge, MEMORY_SELECT_SYSTEM, newestWithin, renderMemorySection, selectionInput, totalChars, type MemoryScopeInfo } from "./selection.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

const PROJECT: MemoryScopeInfo = { scope: { kind: "project", id: "project-p" }, name: "Payments" };
const WORKSPACE: MemoryScopeInfo = { scope: { kind: "workspace", id: "workspace-w" }, name: "api" };

function entry(id: string, body: string, ageDays: number, scope: MemoryScopeInfo = PROJECT, source: MemoryEntryView["source"] = { type: "person", personId: null }): MemoryEntryView {
  return {
    id,
    scope: scope.scope,
    body,
    source,
    createdAt: NOW - ageDays * DAY,
    updatedAt: NOW - ageDays * DAY,
    retiredAt: null,
    retiredReason: null,
    consolidationId: null,
    contradictsRepositoryFile: false,
  };
}

describe("the selection prompt", () => {
  it("says an entry helps only where the action will do what it is about, in no role's words (EO-611)", () => {
    expect(MEMORY_SELECT_SYSTEM).toContain("An entry helps only where the action will do what the entry is about.");
    expect(MEMORY_SELECT_SYSTEM).not.toMatch(/\b(implement|review|plann?|test(er|ing)? agent|develop)(er|or|ing|s)?\b/i);
    expect(MEMORY_SELECT_SYSTEM).toMatchSnapshot();
  });
});

/** A side call that answers as scripted and counts how often it was asked. */
function scripted(answer: SideCallResult<MemorySelection>) {
  return vi.fn(async (_candidates: readonly MemoryEntryView[]) => answer);
}

describe("choosing a dispatch's memory (EO-478)", () => {
  it("delivers every candidate and makes no side call when they total the threshold or less", () => {
    const select = scripted({ ok: true, value: { ids: [] } });
    const candidates = [entry("a", "x".repeat(2_500), 1), entry("b", "y".repeat(1_500), 2)];
    expect(totalChars(candidates)).toBe(4_000);

    const choice = chooseMemory({ candidates, thresholdChars: 4_000, select });

    // Answered on the spot: no promise, so the dispatch does not yield.
    expect(choice).not.toBeInstanceOf(Promise);
    expect(choice).toMatchObject({ mode: "all", selectionRan: false, reason: null });
    expect((choice as { delivered: MemoryEntryView[] }).delivered.map((e) => e.id)).toEqual(["a", "b"]);
    expect(select).toHaveBeenCalledTimes(0);
  });

  it("makes no side call when there is nothing to choose from", () => {
    const select = scripted({ ok: true, value: { ids: [] } });
    expect(chooseMemory({ candidates: [], thresholdChars: 4_000, select })).toEqual({ delivered: [], mode: "none", selectionRan: false, reason: null });
    expect(select).toHaveBeenCalledTimes(0);
  });

  it("above the threshold makes one side call and delivers only the ids it returns", async () => {
    const candidates = Array.from({ length: 12 }, (_, index) => entry(`e${index}`, "z".repeat(500), index));
    const select = scripted({ ok: true, value: { ids: ["e3", "e7", "e1"] } });

    const choice = await chooseMemory({ candidates, thresholdChars: 4_000, select });

    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0]![0].map((e) => e.id)).toEqual(candidates.map((e) => e.id));
    expect(choice.mode).toBe("selected");
    expect(choice.selectionRan).toBe(true);
    // In the candidates' order — newest first — rather than the selector's.
    expect(choice.delivered.map((e) => e.id)).toEqual(["e1", "e3", "e7"]);
  });

  it("never delivers an id the selector made up, or more than eight", async () => {
    const candidates = Array.from({ length: 12 }, (_, index) => entry(`e${index}`, "z".repeat(500), index));
    const choice = await chooseMemory({
      candidates,
      thresholdChars: 4_000,
      select: scripted({ ok: true, value: { ids: ["invented", "e0", "e0", "e1", "e2", "e3", "e4", "e5", "e6"] } }),
    });

    expect(choice.delivered.map((e) => e.id)).not.toContain("invented");
    expect(choice.delivered.length).toBeLessThanOrEqual(MAX_SELECTED_MEMORIES);
  });

  it.each(["timeout", "schema", "budget", "quota", "signed_out", "sign_in_unreachable", "error"] as const)(
    "falls back to the newest entries up to the threshold when the side call fails with %s",
    async (reason) => {
      const candidates = [entry("old", "o".repeat(1_000), 30), entry("newest", "n".repeat(2_000), 1), entry("middle", "m".repeat(1_500), 5), entry("older", "p".repeat(500), 10)];
      const choice = await chooseMemory({ candidates, thresholdChars: 4_000, select: scripted({ ok: false, reason, message: "it did not work" }) });

      expect(choice.mode).toBe("fallback");
      expect(choice.selectionRan).toBe(false);
      expect(choice.reason).toBe(`${reason}: it did not work`);
      // 2,000 + 1,500 = 3,500 fits; the next newest (500) would make
      // 4,000, which still fits; the oldest would not.
      expect(choice.delivered.map((e) => e.id)).toEqual(["newest", "middle", "older"]);
    },
  );

  it("falls back, rather than failing the dispatch, when the side call itself throws", async () => {
    const candidates = [entry("a", "a".repeat(3_000), 1), entry("b", "b".repeat(3_000), 2)];
    const choice = await chooseMemory({
      candidates,
      thresholdChars: 4_000,
      select: async () => {
        throw new Error("boom");
      },
    });
    expect(choice).toMatchObject({ mode: "fallback", reason: "error: boom" });
    expect(choice.delivered.map((e) => e.id)).toEqual(["a"]);
  });

  it("takes the newest in order and stops at the first that does not fit", () => {
    const entries = [entry("big-new", "x".repeat(3_000), 1), entry("small-old", "y".repeat(100), 9), entry("bigger-mid", "z".repeat(2_000), 4)];
    expect(newestWithin(entries, 4_000).map((e) => e.id)).toEqual(["big-new"]);
  });
});

describe("the selection question", () => {
  it("carries every candidate with its id, and the task — title, body, action and the comments since", () => {
    const text = selectionInput(
      { kind: "step", title: "Add CSV export", body: "Export the ledger as CSV.", action: "implement", comments: [{ author: "a person", body: "Use the existing writer." }] },
      [entry("e1", "The ledger lives in packages/ledger.", 1), entry("e2", "Run make db before tests.", 2, WORKSPACE)],
      [PROJECT, WORKSPACE],
    );
    expect(text).toContain("Action: implement");
    expect(text).toContain("## Add CSV export");
    expect(text).toContain("Export the ledger as CSV.");
    expect(text).toContain("- a person: Use the existing writer.");
    expect(text).toContain('<entry id="e1" scope="project Payments">\nThe ledger lives in packages/ledger.\n</entry>');
    expect(text).toContain('<entry id="e2" scope="workspace api">');
  });

  it("gives the selector the whole body, every comment in full and the whole latest message, however long", () => {
    const body = `${"Background. ".repeat(600)}THE-DETAIL-AT-THE-END-OF-THE-BODY`;
    const comments = Array.from({ length: 6 }, (_, index) => ({ author: "a person", body: `${"Words. ".repeat(400)}COMMENT-${index}-TAIL` }));
    const step = selectionInput({ kind: "step", title: "T", body, action: "implement", comments }, [entry("e1", "x", 1)], [PROJECT]);
    expect(step).toContain("THE-DETAIL-AT-THE-END-OF-THE-BODY");
    for (let index = 0; index < 6; index += 1) expect(step).toContain(`COMMENT-${index}-TAIL`);
    expect(step).not.toContain("[…]");

    const message = `${"Context. ".repeat(1_200)}THE-QUESTION-AT-THE-END`;
    expect(selectionInput({ kind: "conversation", latestMessage: message }, [entry("e1", "x", 1)], [PROJECT])).toContain("THE-QUESTION-AT-THE-END");
  });

  it("is the latest message on a conversation turn", () => {
    const text = selectionInput({ kind: "conversation", latestMessage: "How do refunds work?" }, [entry("e1", "x", 1)], [PROJECT]);
    expect(text).toContain("The latest message:\n\nHow do refunds work?");
  });
});

describe("the memory section", () => {
  it("says how old an entry is the way a person would", () => {
    expect(describeAge(NOW - 20_000, NOW)).toBe("written just now");
    expect(describeAge(NOW - 5 * 60_000, NOW)).toBe("written 5 minutes ago");
    expect(describeAge(NOW - 60 * 60_000, NOW)).toBe("written 1 hour ago");
    expect(describeAge(NOW - 12 * DAY, NOW)).toBe("written 12 days ago");
    expect(describeAge(NOW - 90 * DAY, NOW)).toBe("written 3 months ago");
    expect(describeAge(NOW - 800 * DAY, NOW)).toBe("written 2 years ago");
  });

  it("renders the delivered entries with scope and age, says they are background to verify, and counts what each scope holds besides", () => {
    const candidates = [
      entry("p1", "Payments settle in UTC; never use local time for a settlement date.", 12),
      entry("p2", "Refunds over 500 EUR need a second approver.", 40),
      entry("p3", "The old Stripe adapter is deprecated.", 200),
      entry("w1", "Run `make db` before the integration tests.\nThe container takes about a minute.", 2, WORKSPACE, { type: "run", runId: "r1", itemId: "i1" }),
      entry("w2", "Lint with `pnpm lint --fix`.", 70, WORKSPACE),
    ];
    const section = renderMemorySection({
      scopes: [PROJECT, WORKSPACE],
      candidates,
      choice: { delivered: [candidates[0]!, candidates[3]!], mode: "selected", selectionRan: true, reason: null },
      now: NOW,
    });

    expect(section).toContain("background");
    expect(section).toContain("true when it was written");
    expect(section).toContain("check one against the workspace before you act on it");
    // Each with its id, and a person's marked as one (EO-594): what a note
    // correcting an entry names in `replaces`, and which it may not.
    expect(section).toContain("(written 12 days ago by a person, id `p1`) Payments settle in UTC");
    expect(section).toContain("(written 2 days ago, id `w1`) Run `make db`");
    expect(section).toContain("This scope holds 2 other entries.");
    expect(section).toContain("This scope holds 1 other entry.");
    expect(section).toMatchSnapshot();
  });

  it("says so when selection did not run", () => {
    const candidates = [entry("p1", "a", 1), entry("p2", "b", 2)];
    const section = renderMemorySection({
      scopes: [PROJECT],
      candidates,
      choice: { delivered: [candidates[0]!], mode: "fallback", selectionRan: false, reason: "timeout: too slow" },
      now: NOW,
    });
    expect(section).toContain("Selection did not run for this dispatch, so these are the newest entries");
    expect(section).toMatchSnapshot();
  });

  it("lists a scope nothing was delivered from, and renders nothing at all when no scope holds anything", () => {
    const candidates = [entry("p1", "a", 1)];
    const section = renderMemorySection({ scopes: [PROJECT, WORKSPACE], candidates, choice: { delivered: candidates, mode: "all", selectionRan: false, reason: null }, now: NOW });
    expect(section).toContain("### Workspace: api (scope `workspace-w`)\n\nThis scope holds no entries.");
    expect(section).toContain("This scope holds no other entries.");

    expect(renderMemorySection({ scopes: [PROJECT], candidates: [], choice: { delivered: [], mode: "none", selectionRan: false, reason: null }, now: NOW })).toBeNull();
  });
});
