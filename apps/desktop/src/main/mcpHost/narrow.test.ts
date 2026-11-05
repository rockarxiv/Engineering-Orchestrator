import { describe, expect, it } from "vitest";
import {
  ANSWER_BUDGET,
  answerSize,
  matches,
  MAX_LIMIT,
  NARROWING_KEYS,
  narrowAnswer,
  splitArguments,
  withinBudget,
  type Condition,
  type Narrowing,
  type NarrowingKey,
} from "./narrow.js";

/**
 * The narrowing parameters on their own (EO-538), away from any tool:
 * what each operator matches, how a list pages, what `fields` keeps,
 * and when an un-narrowed answer is cut to the budget.
 * narrowing.test.ts drives the same through the catalogue and
 * `answerToolCall`.
 */

const element = { key: "EO-1", title: "Rate limit the import", stepName: "Implement", attempts: 3, labels: ["api", "Backend"], parentKey: null, createdAt: "2026-10-01T09:00:00Z" };

function where(condition: Condition): boolean {
  return matches(element, condition);
}

function parsed(args: Record<string, unknown>, keys: readonly NarrowingKey[] = NARROWING_KEYS) {
  const split = splitArguments(args, keys);
  if (!split.ok) throw new Error(split.issues.join("; "));
  return split;
}

describe("where, one operator at a time", () => {
  it("eq matches an exact value and nothing else", () => {
    expect(where({ path: "stepName", op: "eq", value: "Implement" })).toBe(true);
    expect(where({ path: "stepName", op: "eq", value: "implement" })).toBe(false);
    expect(where({ path: "attempts", op: "eq", value: 3 })).toBe(true);
    expect(where({ path: "parentKey", op: "eq", value: null })).toBe(true);
    expect(where({ path: "labels", op: "eq", value: ["api", "Backend"] })).toBe(true);
  });

  it("ne matches everything eq does not", () => {
    expect(where({ path: "stepName", op: "ne", value: "Review" })).toBe(true);
    expect(where({ path: "stepName", op: "ne", value: "Implement" })).toBe(false);
    expect(where({ path: "missing", op: "ne", value: "x" })).toBe(true);
  });

  it("in matches any one of the values given", () => {
    expect(where({ path: "stepName", op: "in", value: ["Review", "Implement"] })).toBe(true);
    expect(where({ path: "stepName", op: "in", value: ["Review", "Done"] })).toBe(false);
    expect(where({ path: "attempts", op: "in", value: [1, 3] })).toBe(true);
  });

  it("contains is a case-insensitive substring on text", () => {
    expect(where({ path: "title", op: "contains", value: "RATE LIMIT" })).toBe(true);
    expect(where({ path: "title", op: "contains", value: "export" })).toBe(false);
  });

  it("contains is membership on an array", () => {
    expect(where({ path: "labels", op: "contains", value: "api" })).toBe(true);
    expect(where({ path: "labels", op: "contains", value: "frontend" })).toBe(false);
    // Membership, not a substring of any element.
    expect(where({ path: "labels", op: "contains", value: "ap" })).toBe(false);
  });

  it("contains takes any JSON value for membership, objects and null included", () => {
    const field = { allowedValues: [{ id: "10", value: "High" }, { id: "11", value: "Low" }, null] };

    expect(matches(field, { path: "allowedValues", op: "contains", value: { id: "11", value: "Low" } })).toBe(true);
    expect(matches(field, { path: "allowedValues", op: "contains", value: { id: "12", value: "None" } })).toBe(false);
    expect(matches(field, { path: "allowedValues", op: "contains", value: null })).toBe(true);
    expect(matches({ allowedValues: [] }, { path: "allowedValues", op: "contains", value: null })).toBe(false);
    // And an object or null is never a substring of text.
    expect(where({ path: "title", op: "contains", value: null })).toBe(false);
    expect(where({ path: "title", op: "contains", value: { a: 1 } })).toBe(false);
    for (const value of [{ id: "11" }, null, ["x"]]) expect(splitArguments({ where: [{ path: "a", op: "contains", value }] }, ["where"]).ok, JSON.stringify(value)).toBe(true);
  });

  it("gt, gte, lt and lte order numbers", () => {
    expect(where({ path: "attempts", op: "gt", value: 2 })).toBe(true);
    expect(where({ path: "attempts", op: "gt", value: 3 })).toBe(false);
    expect(where({ path: "attempts", op: "gte", value: 3 })).toBe(true);
    expect(where({ path: "attempts", op: "gte", value: 4 })).toBe(false);
    expect(where({ path: "attempts", op: "lt", value: 4 })).toBe(true);
    expect(where({ path: "attempts", op: "lt", value: 3 })).toBe(false);
    expect(where({ path: "attempts", op: "lte", value: 3 })).toBe(true);
    expect(where({ path: "attempts", op: "lte", value: 2 })).toBe(false);
  });

  it("gt, gte, lt and lte order text, so ISO dates compare by when", () => {
    expect(where({ path: "createdAt", op: "gt", value: "2026-09-30" })).toBe(true);
    expect(where({ path: "createdAt", op: "lt", value: "2026-09-30" })).toBe(false);
    expect(where({ path: "createdAt", op: "gte", value: "2026-10-01T09:00:00Z" })).toBe(true);
    expect(where({ path: "createdAt", op: "lte", value: "2026-10-01T09:00:00Z" })).toBe(true);
  });

  it("an ordering never matches across kinds, nor a value that is not there", () => {
    expect(where({ path: "attempts", op: "gt", value: "2" })).toBe(false);
    expect(where({ path: "missing", op: "lt", value: 10 })).toBe(false);
  });

  it("exists matches a value that is present and not null, and with false the opposite", () => {
    expect(where({ path: "title", op: "exists" })).toBe(true);
    expect(where({ path: "title", op: "exists", value: true })).toBe(true);
    expect(where({ path: "parentKey", op: "exists" })).toBe(false);
    expect(where({ path: "missing", op: "exists" })).toBe(false);
    expect(where({ path: "parentKey", op: "exists", value: false })).toBe(true);
    expect(where({ path: "title", op: "exists", value: false })).toBe(false);
  });

  it("reads a dot path into an element, and EO's own words for the old ones", () => {
    const run = { ticket: { key: "EO-2" }, ticketId: "a" };
    expect(matches(run, { path: "ticket.key", op: "eq", value: "EO-2" })).toBe(true);
    expect(matches(run, { path: "item.key", op: "eq", value: "EO-2" })).toBe(true);
    expect(matches(run, { path: "itemId", op: "eq", value: "a" })).toBe(true);
  });

  it("combines conditions with AND", () => {
    const data = { tickets: [{ key: "EO-1", stepName: "Implement", attempts: 1 }, { key: "EO-2", stepName: "Implement", attempts: 4 }, { key: "EO-3", stepName: "Review", attempts: 4 }] };
    const answer = narrowAnswer(data, "items", parsed({ where: [{ path: "stepName", op: "eq", value: "Implement" }, { path: "attempts", op: "gte", value: 2 }] }).narrowing!);

    expect((answer.data["tickets"] as { key: string }[]).map((t) => t.key)).toEqual(["EO-2"]);
    expect(answer.data["total"]).toBe(1);
  });
});

describe("refusing what EO cannot read", () => {
  it("refuses an operator it does not know, in a sentence naming the ones it does", () => {
    const split = splitArguments({ where: [{ path: "title", op: "like", value: "%rate%" }] }, ["where"]);

    expect(split.ok).toBe(false);
    if (split.ok) return;
    expect(split.issues).toEqual(['where[0].op: "like" is not an operator EO knows. Use one of eq, ne, in, contains, gt, gte, lt, lte or exists.']);
  });

  it("refuses a value an operator cannot use", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ path: "a", op: "in", value: "x" }, "where[0].value: in takes an array of the values to match."],
      [{ path: "a", op: "gt", value: { n: 1 } }, "where[0].value: gt compares numbers or text, so its value must be a number or a string."],
      [{ path: "a", op: "eq" }, "where[0].value: eq needs a value to compare with."],
      [{ path: "a", op: "exists", value: "yes" }, "where[0].value: exists takes true or false, or no value at all for true."],
      [{ path: "a", op: "contains" }, "where[0].value: contains needs a value to compare with."],
    ];
    for (const [condition, sentence] of cases) {
      const split = splitArguments({ where: [condition] }, ["where"]);
      expect(split.ok ? [] : split.issues, JSON.stringify(condition)).toEqual([sentence]);
    }
  });

  it(`refuses a limit over ${MAX_LIMIT}, and a negative offset`, () => {
    const split = splitArguments({ limit: MAX_LIMIT + 1, offset: -1 }, ["limit", "offset"]);

    expect(split.ok ? [] : split.issues).toEqual(["limit: limit is at most 1,000; page with offset for more.", "offset: offset cannot be negative."]);
    expect(splitArguments({ limit: MAX_LIMIT }, ["limit"]).ok).toBe(true);
  });

  it("leaves a key the tool does not take with the tool, and the rest of the call untouched", () => {
    const split = parsed({ projectId: "p", fields: ["a"], limit: 5 }, ["fields"]);

    expect(split.narrowing).toEqual({ fields: ["a"] });
    expect(split.rest).toEqual({ projectId: "p", limit: 5 });
  });

  it("reports no narrowing for a call that names none, and hands the arguments on as they came", () => {
    const args = { projectId: "p" };
    const split = parsed(args);

    expect(split.narrowing).toBeNull();
    expect(split.rest).toBe(args);
  });
});

describe("sort, limit and offset", () => {
  const data = {
    tickets: [
      { key: "EO-3", attempts: 2 },
      { key: "EO-1", attempts: 5 },
      { key: "EO-4" },
      { key: "EO-2", attempts: 1 },
      { key: "EO-5", attempts: 3 },
    ],
  };
  const keysOf = (answer: { data: Record<string, unknown> }) => (answer.data["tickets"] as { key: string }[]).map((t) => t.key);

  it("orders by a field either way, with the elements that lack it last", () => {
    expect(keysOf(narrowAnswer(data, "items", { sort: { path: "attempts", direction: "asc" } }))).toEqual(["EO-2", "EO-3", "EO-5", "EO-1", "EO-4"]);
    expect(keysOf(narrowAnswer(data, "items", { sort: { path: "attempts", direction: "desc" } }))).toEqual(["EO-1", "EO-5", "EO-3", "EO-2", "EO-4"]);
    expect(keysOf(narrowAnswer(data, "items", { sort: { path: "key", direction: "asc" } }))).toEqual(["EO-1", "EO-2", "EO-3", "EO-4", "EO-5"]);
  });

  it("pages through the list, and every page says where the next one starts", () => {
    const sort: Narrowing["sort"] = { path: "key", direction: "asc" };
    const first = narrowAnswer(data, "items", { sort, limit: 2 });
    const second = narrowAnswer(data, "items", { sort, limit: 2, offset: 2 });
    const last = narrowAnswer(data, "items", { sort, limit: 2, offset: 4 });

    expect(keysOf(first)).toEqual(["EO-1", "EO-2"]);
    expect(first.data).toMatchObject({ total: 5, returned: 2, nextOffset: 2 });
    expect(keysOf(second)).toEqual(["EO-3", "EO-4"]);
    expect(second.data).toMatchObject({ total: 5, returned: 2, nextOffset: 4 });
    expect(keysOf(last)).toEqual(["EO-5"]);
    expect(last.data).toMatchObject({ total: 5, returned: 1, nextOffset: null });
  });

  it("counts what matched, before the page was cut", () => {
    const answer = narrowAnswer(data, "items", { where: [{ path: "attempts", op: "exists" }], limit: 1 });

    expect(answer.data).toMatchObject({ total: 4, returned: 1, nextOffset: 1 });
  });

  it("writes the summary on one line, and the data after it as compact JSON", () => {
    const answer = narrowAnswer(data, "items", { limit: 2 });
    const [summary, json, ...rest] = answer.text.split("\n");

    expect(rest).toEqual([]);
    expect(summary).toBe("5 tickets matched; 2 returned; the next page starts at offset 2.");
    expect(JSON.parse(json!)).toEqual(answer.data);
    expect(json).toBe(JSON.stringify(answer.data));
  });
});

describe("fields", () => {
  const data = { activeProjectId: "p1", tickets: [{ key: "EO-1", stepName: "Implement", title: "One", run: { id: "r1", costCents: 4 } }, { key: "EO-2", stepName: "Review", title: "Two", run: { id: "r2", costCents: 9 } }] };

  it("keeps only the paths named, through the list", () => {
    const answer = narrowAnswer(data, "items", { fields: ["tickets.key", "tickets.run.costCents"] });

    expect(answer.data).toEqual({ tickets: [{ key: "EO-1", run: { costCents: 4 } }, { key: "EO-2", run: { costCents: 9 } }], total: 2, returned: 2, nextOffset: null });
  });

  it("names a path that matches nothing in the summary, and keeps the rest", () => {
    const answer = narrowAnswer(data, "items", { fields: ["tickets.key", "tickets.colour"] });

    expect(answer.text.split("\n")[0]).toBe("2 tickets matched; 2 returned, and there are no more. Nothing is at `tickets.colour`, so it was left out.");
    expect(answer.data["tickets"]).toEqual([{ key: "EO-1" }, { key: "EO-2" }]);
  });

  it("keeps a parent whole when a path inside it is named as well, in either order", () => {
    for (const fields of [["tickets", "tickets.key"], ["tickets.key", "tickets"]]) {
      expect(narrowAnswer(data, "items", { fields }).data["tickets"], JSON.stringify(fields)).toEqual(data.tickets);
    }
    for (const fields of [["tickets.run", "tickets.run.id", "tickets.key"], ["tickets.run.id", "tickets.key", "tickets.run"]]) {
      expect(narrowAnswer(data, "items", { fields }).data["tickets"], JSON.stringify(fields)).toEqual([
        { key: "EO-1", run: { id: "r1", costCents: 4 } },
        { key: "EO-2", run: { id: "r2", costCents: 9 } },
      ]);
    }
  });

  it("leaves out a value that ends before the path does, rather than keeping it whole", () => {
    const events = {
      events: [
        { seq: 0, payload: { summary: "Read it", tokens: 10 } },
        { seq: 1, payload: "git status --porcelain and everything it printed" },
        { seq: 2, payload: null },
        { seq: 3, payload: { tokens: 4 } },
        { seq: 4, payload: [{ summary: "a", n: 1 }, "loose text", null, { n: 2 }] },
        { seq: 5, payload: ["only", "text"] },
      ],
    };
    const answer = narrowAnswer(events, "events", { fields: ["events.seq", "events.payload.summary"] });

    expect(answer.data["events"]).toEqual([
      { seq: 0, payload: { summary: "Read it" } },
      { seq: 1 },
      { seq: 2 },
      { seq: 3, payload: {} },
      { seq: 4, payload: [{ summary: "a" }, {}] },
      { seq: 5 },
    ]);
    expect(answer.data).toMatchObject({ total: 6, returned: 6 });
    expect(JSON.parse(answer.text.split("\n")[1]!)).toEqual(answer.data);
  });

  it("works on a read with no list, without page counts", () => {
    const answer = narrowAnswer({ paused: false, activeRunCount: 2 }, undefined, { fields: ["paused"] });

    expect(answer.data).toEqual({ paused: false });
    expect(answer.text).toBe('Narrowed to the field asked for.\n{"paused":false}');
  });
});

describe("the size budget", () => {
  const big = { tickets: Array.from({ length: 600 }, (_, n) => ({ key: `EO-${n + 1}`, title: `Item number ${n + 1} with a title long enough to count`, body: "x".repeat(60) })) };
  const text = big.tickets.map((t) => `- ${t.key} ${t.title}`).join("\n");

  it("leaves an answer under the budget alone", () => {
    const small = { tickets: big.tickets.slice(0, 10) };

    expect(withinBudget("ten tickets", small, "items", "items_list")).toBeNull();
  });

  it("cuts an answer over it to the first page that fits, and says how to narrow", () => {
    expect(answerSize(text, big)).toBeGreaterThan(ANSWER_BUDGET);
    const answer = withinBudget(text, big, "items", "items_list");

    expect(answer).not.toBeNull();
    const { data } = answer!;
    const returned = data["returned"] as number;
    expect(answerSize(answer!.text, data)).toBeLessThanOrEqual(ANSWER_BUDGET);
    expect(returned).toBeGreaterThan(0);
    expect(data["tickets"]).toEqual(big.tickets.slice(0, returned));
    expect(data).toMatchObject({ total: 600, nextOffset: returned });

    const summary = answer!.text.split("\n")[0]!;
    expect(summary).toContain(`first page: ${returned} of 600 tickets`);
    for (const word of ["`where`", "`fields`", "`limit`"]) expect(summary).toContain(word);
    expect(summary).toContain(`offset ${returned}`);
  });

  it("cuts a read with no list to what fits, naming what it left out", () => {
    const item = { record: { key: "EO-486", title: "Big one", comments: Array.from({ length: 200 }, (_, n) => ({ body: "y".repeat(400), n })) } };
    const answer = withinBudget(JSON.stringify(item), item, undefined, "item_get");

    expect(answer).not.toBeNull();
    expect(answerSize(answer!.text, answer!.data)).toBeLessThanOrEqual(ANSWER_BUDGET);
    expect(answer!.data).toMatchObject({ record: { key: "EO-486", title: "Big one" }, omitted: [{ path: "record.comments", entries: 200 }] });
    expect(answer!.text.split("\n")[0]).toContain("`fields`");
  });
});
