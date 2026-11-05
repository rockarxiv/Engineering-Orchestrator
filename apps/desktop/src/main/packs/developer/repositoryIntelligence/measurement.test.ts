import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compare,
  difference,
  indexCostOf,
  isIndexAnswerableSearch,
  isIndexToolName,
  measureRun,
  measureItem,
  toolCallKind,
  type RecordedEvent,
  type RecordedRun,
  type RecordedItem,
} from "./measurement.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The measurement (EO-155).
 *
 * Every figure here is derived from rows EO was already writing, so the
 * tests are written the same way: an array of `run_events` in the shape
 * the log actually holds them, including the two backends' different
 * spellings of a tool id and Codex's habit of wrapping every command in
 * `bash -lc`. Both of those were found by reading the real database, and
 * both are the kind of detail that makes a census quietly report zero.
 */

let seq = 0;
const event = (type: string, payload: unknown, ts = 1_000 + seq): RecordedEvent => ({ seq: seq++, ts, type, payload });
const call = (name: string, args: unknown = {}, ts?: number): RecordedEvent =>
  event("tool_call", { type: "tool_call", name, args }, ts);
const edit = (path = "/w/src/a.ts", ts?: number): RecordedEvent => event("file_edit", { type: "file_edit", path }, ts);
const usage = (scope: "turn" | "session", tokensIn: number, tokensOut = 10, ts?: number): RecordedEvent =>
  event("usage", { type: "usage", scope, tokensIn, tokensOut }, ts);
const servers = (...names: string[]): RecordedEvent =>
  event("server_status", { type: "server_status", servers: names.map((name) => ({ name, status: "connected" })) });
const nudge = (needle: string): RecordedEvent =>
  event("search_interception", { type: "search_interception", tool: "Bash", kind: "symbol", needle, suggestion: "ask the index" });

function run(overrides: Partial<RecordedRun> = {}): RecordedRun {
  seq = 0;
  return {
    id: "run-1",
    action: "implement",
    startedAt: 1_000,
    endedAt: 2_000,
    tokensIn: 0,
    tokensOut: 0,
    costCents: 0,
    events: [],
    ...overrides,
  };
}

function item(runs: RecordedRun[], overrides: Partial<RecordedItem> = {}): RecordedItem {
  return { key: "EO-1", runs, index: null, ...overrides };
}

describe("what a tool call was", () => {
  /**
   * Both backends' spellings, because only knowing one is a silent zero.
   *
   * One backend sends `mcp__repo__<tool>` and the other `repo/<tool>`,
   * and this database holds calls in both spellings. A census that
   * recognised only the first would report every run on the second as
   * never having touched the index — which is exactly the shape of a
   * wrong measurement that reads like a finding.
   *
   * The tool names here are invented on purpose. What comes after the
   * server name is whichever provider is configured, and a measurement
   * that only recognised the vocabulary EO ships with today would be
   * the coupling `architecturalInvariants.test.ts` forbids.
   */
  it("recognises an index call on either backend's spelling", () => {
    expect(isIndexToolName("mcp__repo__area")).toBe(true);
    expect(isIndexToolName("repo/area")).toBe(true);
    expect(isIndexToolName("mcp__eo__ticket_detail")).toBe(false);
    expect(isIndexToolName("Grep")).toBe(false);
  });

  it("tells a search from a read from everything else", () => {
    expect(toolCallKind("mcp__repo__symbols", { query: "transitionItem" })).toBe("index");
    expect(toolCallKind("Grep", { pattern: "transitionItem" })).toBe("search");
    expect(toolCallKind("Read", { file_path: "/w/a.ts" })).toBe("read");
    expect(toolCallKind("Bash", { command: "grep -rn transitionItem ." })).toBe("search");
    expect(toolCallKind("Bash", { command: "sed -n '1,80p' apps/desktop/src/main/engine.ts" })).toBe("read");
    expect(toolCallKind("Bash", { command: "pnpm test" })).toBe("other");
    expect(toolCallKind("Edit", { file_path: "/w/a.ts" })).toBe("other");
  });

  /**
   * Codex hands every command to `bash -lc`, so the program a naive read
   * finds is `bash` on all 3,561 of its calls in this database.
   */
  it("looks inside a shell wrapper rather than reporting bash", () => {
    expect(toolCallKind("command_execution", { command: `/usr/bin/bash -lc "rg transitionItem apps"` })).toBe("search");
    expect(toolCallKind("command_execution", { command: `/usr/bin/bash -lc "sed -n '1,40p' apps/desktop/src/main/db/schema.ts"` })).toBe("read");
  });

  /**
   * `sed` is how this codebase reads *and* how it writes, so the flag has
   * to decide. An edit counted as a read inflates the very number the
   * two arms are compared on.
   */
  it("does not count a stream editor writing in place as a read", () => {
    expect(toolCallKind("Bash", { command: "sed -i 's/foo/bar/' apps/desktop/src/main/db/schema.ts" })).toBe("other");
    expect(toolCallKind("Bash", { command: "sed -n '1,20p' apps/desktop/src/main/db/schema.ts" })).toBe("read");
  });

  /** A command that searches and then reads is a search: the search is what the index replaces. */
  it("counts a command that searches and reads as a search", () => {
    expect(toolCallKind("Bash", { command: "grep -rln broadSearch apps | head -5" })).toBe("search");
  });

  /**
   * `git grep` is a search of the tree, whatever else `git` does.
   *
   * It was landing in `other`, so every call an agent spelled the git
   * way was missing from the read/search side of the comparison the
   * story is about — 9 calls in this database, silently. `git` is not a
   * program that does one thing, so the subcommand decides.
   */
  it("counts the git subcommands that search the tree", () => {
    expect(toolCallKind("Bash", { command: "git grep -n transitionItem" })).toBe("search");
    expect(toolCallKind("Bash", { command: "git grep -rn 'foo' -- apps packages" })).toBe("search");
    expect(toolCallKind("Bash", { command: "git ls-files '*.test.ts'" })).toBe("search");
    // Global options before the subcommand: `-C` takes a value, and a
    // parser that did not step over it would read the path as the
    // subcommand and miss the search entirely.
    expect(toolCallKind("Bash", { command: "git -C /home/dev/repo grep -n transitionItem" })).toBe("search");
    expect(toolCallKind("Bash", { command: "git --no-pager grep -n transitionItem" })).toBe("search");
    // And through the other backend's shell wrapper.
    expect(toolCallKind("command_execution", { command: `/usr/bin/bash -lc "git grep -n transitionItem"` })).toBe("search");
  });

  /**
   * And no other git call is one.
   *
   * These are the overwhelming majority — 2,242 `git diff` calls in this
   * database against 9 `git grep` — so a rule that counted `git` itself
   * as a search would have been wrong far more often than the omission
   * it replaced. `git log --grep=…` is the trap: the subcommand is
   * `log`, and searching commit messages is not a question any index of
   * declarations answers.
   */
  it("leaves every other git call alone", () => {
    for (const command of [
      "git diff --stat",
      "git log --oneline -15",
      "git log --grep=transitionItem",
      "git status --porcelain",
      "git show HEAD",
      "git merge-base main HEAD",
      "git add apps/desktop/src/main/db/schema.ts",
      "git commit -q -F -",
      "git worktree list",
      "git rev-parse HEAD",
    ]) {
      expect(toolCallKind("Bash", { command })).toBe("other");
    }
  });

  /**
   * The census sees a `git grep`; the interception still does not.
   *
   * Deliberate and worth pinning, because it reads like an
   * inconsistency. EO-165 promises agents that git operations are never
   * interrupted — a promise with one exception carved out of it is not
   * one — and that promise is about what EO does to a running agent, not
   * about what a report may notice afterwards.
   */
  it("does not make a git search into one the interception would have caught", () => {
    expect(toolCallKind("Bash", { command: "git grep -n transitionItem" })).toBe("search");
    expect(isIndexAnswerableSearch("Bash", { command: "git grep -n transitionItem" })).toBe(false);
    expect(isIndexAnswerableSearch("Bash", { command: "grep -rn transitionItem ." })).toBe(true);
  });
});

describe("one run", () => {
  it("counts calls by kind and stops the opening at the first change", () => {
    const measured = measureRun(
      run({
        events: [
          call("Bash", { command: "grep -rn transitionItem ." }),
          call("Read", { file_path: "/w/a.ts" }),
          call("mcp__repo__symbols", { query: "transitionItem" }),
          call("Edit", { file_path: "/w/a.ts" }),
          edit(),
          call("Bash", { command: "grep -rn afterwards ." }),
        ],
      }),
    );

    expect(measured.calls).toEqual({ index: 1, search: 2, read: 1, other: 1 });
    expect(measured.callsBeforeFirstEdit).toEqual({ index: 1, search: 1, read: 1, other: 1 });
    expect(measured.firstEditAt).not.toBeNull();
  });

  /**
   * A run that never edited spent its whole length looking.
   *
   * Correct rather than a fallback: a review, a failed attempt and a
   * refinement are all runs whose entire cost is discovery, and treating
   * their opening as zero would hide the cost this feature exists to
   * remove.
   */
  it("treats a run that changed nothing as all opening", () => {
    const measured = measureRun(run({ events: [call("Bash", { command: "rg foo apps" }), call("Read", { file_path: "/w/a.ts" })] }));

    expect(measured.firstEditAt).toBeNull();
    expect(measured.callsBeforeFirstEdit).toEqual({ index: 0, search: 1, read: 1, other: 0 });
  });

  it("reads the arm off the servers the backend reported", () => {
    expect(measureRun(run({ events: [servers("repo", "eo")] })).indexAttached).toBe(true);
    expect(measureRun(run({ events: [servers("eo")] })).indexAttached).toBe(false);
    // A run that called the index plainly had it, whatever it announced.
    expect(measureRun(run({ events: [call("repo/tree", {})] })).indexAttached).toBe(true);
  });

  /**
   * Nudged, then queried: the one comparison that is internally
   * controlled.
   *
   * The worked example on the item is exactly this shape — an
   * interception on a repository-wide grep, an index call two events
   * later with the same needle, and a second interception the agent
   * ignored. Two nudges, one taken up.
   */
  it("counts the nudges an index call followed, and the ones it did not", () => {
    const measured = measureRun(
      run({
        events: [
          nudge("porcelain"),
          call("Bash", { command: "grep -rn porcelain ." }),
          call("mcp__repo__symbols", { query: "porcelain" }),
          nudge("isRepositoryIndexPath"),
          call("Bash", { command: "grep -rn isRepositoryIndexPath ." }),
          call("Read", { file_path: "/w/a.ts" }),
        ],
      }),
    );

    expect(measured.interceptions).toBe(2);
    expect(measured.interceptionsTakenUp).toBe(1);
    expect(measured.takenUpAfter).toEqual([2]);
  });

  it("does not credit a nudge with an index call that came after the next nudge", () => {
    const measured = measureRun(
      run({ events: [nudge("a"), call("Bash", { command: "rg a apps" }), nudge("b"), call("mcp__repo__symbols", { query: "b" })] }),
    );

    expect(measured.interceptions).toBe(2);
    expect(measured.interceptionsTakenUp).toBe(1);
  });
});

describe("tokens before the first change", () => {
  /**
   * The exact case: a backend that reports per turn has readings on both
   * sides of the edit, so the figure is a measurement rather than a
   * bound. Codex reports this way.
   */
  it("is exact when the readings straddle the edit", () => {
    const measured = measureItem(
      item([
        run({
          tokensIn: 900,
          tokensOut: 30,
          events: [call("Bash", { command: "rg foo apps" }), usage("turn", 300, 10), call("Edit", {}), edit(), usage("turn", 600, 20)],
        }),
      ]),
    );

    expect(measured.spendBeforeFirstEdit).toEqual({
      atLeast: { tokensIn: 300, tokensOut: 10, costCents: 0 },
      atMost: { tokensIn: 300, tokensOut: 10, costCents: 0 },
      exact: true,
    });
  });

  /**
   * The usual case, and the reason this returns two numbers.
   *
   * The Claude SDK reports a running total once, on the result message,
   * so a run that edited in its eighth turn has no reading taken at the
   * moment it did. What EO can defend is that the earlier runs' tokens
   * were certainly spent before the edit and the editing run's were
   * certainly not spent after it. A single figure here would be a
   * plausible number with nothing behind it.
   */
  it("is a bound when every reading arrived after the edit", () => {
    const measured = measureItem(
      item([
        run({ id: "r1", action: "refine", startedAt: 1_000, endedAt: 2_000, tokensIn: 5_000, tokensOut: 100, events: [call("Read", {})] }),
        run({
          id: "r2",
          action: "implement",
          startedAt: 3_000,
          endedAt: 4_000,
          tokensIn: 20_000,
          tokensOut: 400,
          events: [call("Bash", { command: "rg foo apps" }), call("Edit", {}), edit(), usage("session", 20_000, 400)],
        }),
      ]),
    );

    expect(measured.spendBeforeFirstEdit).toEqual({
      atLeast: { tokensIn: 5_000, tokensOut: 100, costCents: 0 },
      atMost: { tokensIn: 25_000, tokensOut: 500, costCents: 0 },
      exact: false,
    });
  });

  it("says nothing at all about an item that never changed a file", () => {
    const measured = measureItem(item([run({ tokensIn: 1_000, events: [call("Read", {})] })]));

    expect(measured.spendBeforeFirstEdit).toBeNull();
    expect(measured.workingMsBeforeFirstEdit).toBeNull();
  });

  /**
   * Session readings replace, turn readings add.
   *
   * Through the shipping tally rather than by summing here, which is the
   * point: the Claude SDK re-reports a running total on every result
   * message and says to read the latest rather than sum them. A report
   * that summed would inflate every Claude run and look plausible doing
   * it.
   */
  it("does not sum a backend's running totals", () => {
    const measured = measureItem(
      item([
        run({
          tokensIn: 9_000,
          events: [call("Read", {}), usage("session", 3_000, 10), usage("session", 9_000, 30), call("Edit", {}), edit()],
        }),
      ]),
    );

    expect(measured.spendBeforeFirstEdit?.atLeast.tokensIn).toBe(9_000);
    expect(measured.spendBeforeFirstEdit?.exact).toBe(true);
  });
});

describe("one item", () => {
  it("adds up every run before the change, and none after it", () => {
    const measured = measureItem(
      item([
        run({ id: "r1", startedAt: 1_000, endedAt: 2_000, events: [call("Bash", { command: "rg foo apps" }), call("Read", {})] }),
        run({ id: "r2", startedAt: 3_000, endedAt: 5_000, events: [call("Grep", {}), call("Edit", {}), edit("/w/a.ts", 4_000), call("Grep", {})] }),
        run({ id: "r3", startedAt: 6_000, endedAt: 7_000, events: [call("Bash", { command: "rg bar apps" })] }),
      ]),
    );

    expect(measured.calls.search).toBe(4);
    // The `Edit` call is in the opening and the search after it is not:
    // the call that changed the file comes before the event announcing
    // it, and it lands in `other`, which is where a change belongs. The
    // two kinds the arms are compared on are unaffected either way.
    expect(measured.callsBeforeFirstEdit).toEqual({ index: 0, search: 2, read: 1, other: 1 });
  });

  /**
   * Time inside runs, not wall clock.
   *
   * An item that waited overnight for a person did not spend the night
   * looking for a symbol, and a measurement that reported the wait as
   * discovery would be dominated by how quickly somebody read their
   * inbox. Both numbers are kept, because the wall-clock one is what a
   * person feels and neither should be quietly substituted for the
   * other.
   */
  it("reports time spent inside runs and wall clock separately", () => {
    const measured = measureItem(
      item([
        run({ id: "r1", startedAt: 0, endedAt: 60_000, events: [call("Read", {})] }),
        run({ id: "r2", startedAt: 600_000, endedAt: 900_000, events: [call("Edit", {}), edit("/w/a.ts", 690_000)] }),
      ]),
    );

    expect(measured.workingMsBeforeFirstEdit).toBe(60_000 + 90_000);
    expect(measured.elapsedMsBeforeFirstEdit).toBe(690_000);
  });

  it("puts an item in the arm its runs were actually dispatched in", () => {
    expect(measureItem(item([run({ events: [servers("repo", "eo")] })])).arm).toBe("on");
    expect(measureItem(item([run({ events: [servers("eo")] })])).arm).toBe("off");
  });

  it("carries the index's own numbers through untouched", () => {
    const measured = measureItem(
      item([run()], {
        index: { status: "ready", lastIndexDurationMs: 9_000, lastSyncDurationMs: 22, lastSyncChangedFiles: 0, indexSizeBytes: 51_781_632 },
      }),
    );

    expect(measured.index).toEqual({
      status: "ready",
      lastIndexDurationMs: 9_000,
      lastSyncDurationMs: 22,
      lastSyncChangedFiles: 0,
      indexSizeBytes: 51_781_632,
    });
  });
});

describe("the two arms", () => {
  const onItem = (key: string, searches: number): RecordedItem =>
    item(
      [
        run({
          events: [
            servers("repo", "eo"),
            ...Array.from({ length: searches }, () => call("Bash", { command: "rg foo apps" })),
            call("Edit", {}),
            edit(),
          ],
        }),
      ],
      { key },
    );
  const offItem = (key: string, searches: number): RecordedItem =>
    item(
      [run({ events: [servers("eo"), ...Array.from({ length: searches }, () => call("Bash", { command: "rg foo apps" })), call("Edit", {}), edit()] })],
      { key },
    );

  it("splits items by the arm they ran in and states the difference in words", () => {
    const comparison = compare(
      [onItem("EO-2", 2), onItem("EO-3", 4), offItem("EO-4", 10), offItem("EO-5", 12)].map((it) => measureItem(it)),
    );

    expect(comparison.on.map((t) => t.key)).toEqual(["EO-2", "EO-3"]);
    expect(comparison.off.map((t) => t.key)).toEqual(["EO-4", "EO-5"]);

    const headline = comparison.differences[0];
    expect(headline?.delta).toBe(-8);
    expect(headline?.stated).toContain("8 fewer");
    expect(headline?.stated).toContain("with it on against");
    expect(headline?.stated).toContain("median");
  });

  /**
   * The caution is part of the statement, not a footnote somebody may
   * skip.
   *
   * At n of three or four per arm the ranges overlap almost always, and
   * every hand-made claim during this feature that turned out to be
   * wrong was a mean quoted without its spread.
   */
  it("says so when the two arms' ranges overlap", () => {
    const overlapping = difference("Searches", "calls", [2, 9], [3, 10]);
    expect(overlapping.overlapping).toBe(true);
    expect(overlapping.stated).toContain("not a result");

    const separated = difference("Searches", "calls", [1, 2], [10, 12]);
    expect(separated.overlapping).toBe(false);
    expect(separated.stated).not.toContain("not a result");
  });

  /**
   * The mistake this line exists to prevent was nearly made writing this
   * story.
   *
   * Restricted to the items either side of the flag being turned on,
   * the headline read "43% fewer calls before the first change" — off a
   * pair of arms whose medians were both 54.5, with one 548-call item
   * dragging the mean. A mean that moves while the median does not is
   * one item's story, and quoting it would have been precisely the
   * unsupported saving this report exists to make impossible.
   */
  it("says when a difference in the means is carried by outliers", () => {
    const carried = difference("Searches", "calls", [10, 10, 10], [10, 10, 300]);

    expect(carried.medianDelta).toBe(0);
    expect(carried.delta).toBeLessThan(0);
    expect(carried.stated).toContain("carried by outliers");

    const genuine = difference("Searches", "calls", [4, 5, 6], [10, 11, 12]);
    expect(genuine.stated).not.toContain("carried by outliers");
  });

  it("refuses to compare an arm that has no items in it", () => {
    const only = difference("Searches", "calls", [1, 2], []);
    expect(only.stated).toContain("nothing to compare");
  });

  it("reports compliance only once something has been nudged", () => {
    expect(compare([measureItem(item([run()]))]).compliance).toBeNull();

    const nudged = compare([
      measureItem(item([run({ events: [nudge("a"), call("Bash", { command: "rg a apps" }), call("mcp__repo__symbols", {})] })])),
    ]);
    expect(nudged.compliance).toEqual({ interceptions: 1, takenUp: 1, share: 1 });
  });
});

describe("what the index cost", () => {
  it("summarises the durations and sizes the provider recorded", () => {
    const cost = indexCostOf(
      [
        item([run()], { key: "EO-2", index: { status: "ready", lastIndexDurationMs: 8_000, lastSyncDurationMs: 20, lastSyncChangedFiles: 0, indexSizeBytes: 100 } }),
        item([run()], { key: "EO-3", index: { status: "ready", lastIndexDurationMs: 12_000, lastSyncDurationMs: 40, lastSyncChangedFiles: 2, indexSizeBytes: 300 } }),
      ].map((it) => measureItem(it)),
    );

    expect(cost.builds.mean).toBe(10_000);
    expect(cost.syncs.median).toBe(30);
    expect(cost.sizeBytes.max).toBe(300);
    expect(cost.unrecorded).toBe(0);
  });

  /**
   * A row written before these columns existed has not measured zero, it
   * has measured nothing — and is counted separately so a reader knows
   * what the spread is missing rather than reading it as the whole
   * population.
   */
  it("counts a row that recorded nothing rather than averaging in a zero", () => {
    const cost = indexCostOf(
      [
        item([run()], { key: "EO-2", index: { status: "ready", lastIndexDurationMs: null, lastSyncDurationMs: null, lastSyncChangedFiles: null, indexSizeBytes: null } }),
        item([run()], { key: "EO-3", index: { status: "ready", lastIndexDurationMs: 12_000, lastSyncDurationMs: null, lastSyncChangedFiles: null, indexSizeBytes: null } }),
      ].map((it) => measureItem(it)),
    );

    expect(cost.builds).toMatchObject({ n: 1, mean: 12_000 });
    expect(cost.unrecorded).toBe(1);
  });
});

/**
 * The rule the whole subsystem is built around, asserted structurally
 * rather than trusted.
 *
 * A command line is read to decide what a call was and then thrown
 * away; a file's contents are never opened at all. The proof is that a
 * distinctive string put into a command, a path and a needle cannot be
 * found anywhere in what a caller is handed — and the item key and
 * index path, which EO already stores and a report needs, still can.
 */
describe("what the report is allowed to hold", () => {
  it("keeps no command line and no file content", () => {
    const secret = "SUPERSECRETLITERAL";
    const measured = measureItem(
      item([
        run({
          events: [
            call("Bash", { command: `grep -rn ${secret} apps` }),
            call("Read", { file_path: `/w/${secret}.ts` }),
            nudge(secret),
            call("mcp__repo__symbols", { query: secret }),
            call("Edit", {}),
            edit(`/w/${secret}.ts`),
          ],
        }),
      ]),
    );

    expect(JSON.stringify(measured)).not.toContain(secret);
    expect(JSON.stringify(compare([measured]))).not.toContain(secret);
    // The tool name survives, because "which of the nine were reached"
    // is one of the questions this report exists to answer.
    expect(measured.indexTools).toEqual({ mcp__repo__symbols: 1 });
  });

  /**
   * "Nothing is transmitted anywhere" is an acceptance criterion, and a
   * promise in a comment is not one.
   *
   * EO has no telemetry by choice, and the risk a measurement story
   * carries is that somebody later adds "just a ping". So it is
   * structural: neither the derivation nor the command that runs it may
   * name a way to reach the network, and adding one fails this test
   * rather than a review.
   *
   * `db/architecturalInvariants.test.ts` draws its rule the same way, on
   * module specifiers rather than on occurrences of a word, so that a
   * sentence about HTTP in a comment is not a violation and an import of
   * it is.
   */
  it("names no way to reach the network, in the derivation or in the command", () => {
    const NETWORK = /\b(?:node:)?(?:https?|net|dgram|tls|dns|http2)\b|\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bnavigator\.sendBeacon\b/;
    const sources = [
      join(here, "measurement.ts"),
      join(here, "..", "..", "..", "..", "..", "..", "..", "scripts", "index-benefit.mts"),
    ];

    for (const source of sources) {
      const text = readFileSync(source, "utf8");
      const specifiers = [...text.matchAll(/\bfrom\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/g)].flatMap((match) =>
        match.slice(1).filter((specifier): specifier is string => specifier !== undefined),
      );

      expect(specifiers.filter((specifier) => NETWORK.test(specifier))).toEqual([]);
      // The body too, for the spellings that need no import at all.
      expect(text.split("\n").filter((line) => !line.trimStart().startsWith("//") && /\bfetch\s*\(|sendBeacon|new WebSocket/.test(line))).toEqual([]);
    }
  });

  /**
   * The *launcher* must not reach the network either, and that is not
   * something reading the script can tell you.
   *
   * This shipped with `#!/usr/bin/env -S pnpm dlx tsx` and the README
   * said to run it that way. `pnpm dlx` downloads its tool when the
   * machine has not cached it, so on a clean machine the documented way
   * to run a report whose criterion is "nothing is transmitted anywhere"
   * opened with a request to registry.npmjs.org — a file that imports
   * nothing but `node:*` and is still fetched over the wire before it
   * runs.
   *
   * So this runs the real command, the one `package.json` defines and
   * the README quotes, against a database built here, with every route
   * to a package registry poisoned: an unroutable registry, npm and
   * pnpm in offline mode, and `HOME` moved somewhere with no store or
   * credentials. Anything that needed a download fails; this exits 0 and
   * prints a report.
   */
  it("runs its documented command with every route to a registry poisoned", () => {
    const root = join(here, "..", "..", "..", "..", "..", "..", "..");
    const command = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const script = command.scripts["report:index-benefit"];
    expect(script, "the documented command has to exist to be tested").toBeTruthy();
    expect(script).not.toMatch(/\b(?:dlx|npx)\b/);

    const scratch = mkdtempSync(join(tmpdir(), "eo-report-offline-"));
    try {
      const database = join(scratch, "eo.db");
      seedReportDatabase(database);

      const [runner = "", ...argv] = (script as string).split(" ");
      const finished = spawnSync(runner, [...argv, "--db", database], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: scratch,
          USERPROFILE: scratch,
          // Anything that tried to resolve a package would have to come
          // through one of these, and all three refuse.
          npm_config_registry: "http://127.0.0.1:1/",
          npm_config_offline: "true",
          npm_config_prefer_offline: "true",
          NPM_CONFIG_REGISTRY: "http://127.0.0.1:1/",
          // And if anything did reach out anyway, send it nowhere.
          HTTP_PROXY: "http://127.0.0.1:1/",
          HTTPS_PROXY: "http://127.0.0.1:1/",
        },
      });

      expect(finished.stderr ?? "").not.toMatch(/registry|ERR_|EAI_AGAIN|ENOTFOUND/i);
      expect(finished.status, finished.stderr).toBe(0);
      expect(finished.stdout).toContain("ran with the index attached");
      expect(finished.stdout).toContain("The difference between the arms");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * The smallest database the report will read: one item, one run, a
 * handful of events.
 *
 * Written with `node:sqlite` rather than through EO's own migrations
 * because what is under test is the *command* — that it starts, reads
 * and prints without fetching anything — and standing up the real schema
 * would test the migrator instead. Only the columns the report's own
 * queries name are here; a column it stops selecting is a column this
 * stops creating.
 */
function seedReportDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE items (id TEXT PRIMARY KEY, key TEXT NOT NULL);
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL, action TEXT NOT NULL, started_at INTEGER, ended_at INTEGER,
      tokens_in INTEGER, tokens_out INTEGER, cost_cents INTEGER
    );
    CREATE TABLE run_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE repository_indexes (
      id TEXT PRIMARY KEY, item_id TEXT, status TEXT NOT NULL,
      last_index_duration_ms INTEGER, last_sync_duration_ms INTEGER, last_sync_changed_files INTEGER, index_size_bytes INTEGER
    );
    INSERT INTO items VALUES ('t1', 'EO-1');
    INSERT INTO runs VALUES ('r1', 't1', 'implement', 1000, 2000, 100, 10, 1);
    INSERT INTO run_events VALUES
      ('r1', 1, 1001, 'server_status', '{"type":"server_status","servers":[{"name":"repo","status":"connected"}]}'),
      ('r1', 2, 1002, 'tool_call', '{"type":"tool_call","name":"Bash","args":{"command":"git grep -n transitionItem"}}'),
      ('r1', 3, 1003, 'file_edit', '{"type":"file_edit","path":"/w/a.ts"}');
    INSERT INTO repository_indexes VALUES ('i1', 't1', 'ready', 1600, 24, 0, 45000000);
  `);
  db.close();
}

/**
 * No saving is claimed that this report does not support (EO-155).
 *
 * The last acceptance criterion of the last story in EO-141, and the
 * only one that is about the state of the codebase rather than about a
 * number. It is enforced rather than audited once, because the failure
 * mode is a sentence somebody adds in eighteen months to a file nobody
 * is reviewing for this.
 *
 * The patterns are deliberately about *this* claim — tokens, money, and
 * the cost of exploring — and not about the word "cheaper" in general.
 * A comment saying a directory listing is cheaper than a write is about
 * something else entirely, and a matcher that could not tell the
 * difference would be turned off within the month.
 *
 * The way past it is not to weaken the pattern. It is to point at
 * `scripts/index-benefit.mts`, which is the command that would have to
 * support the claim — a file that cites the report is a file whose
 * reader can go and check.
 */
describe("the claim audit", () => {
  const SAVING_CLAIMS = [
    /\bsaves?\s+(?:you\s+)?(?:tokens|money|context)\b/i,
    /\btoken[-\s]savings?\b/i,
    /\bfewer\s+tokens\b/i,
    /\bcosts?\s+less\s+than\b/i,
    /\bcheaper\s+than\s+(?:grep|grepping|searching|a\s+search|rediscover|rediscovering|exploring|exploration)\b/i,
    /\breduces?\s+(?:the\s+)?(?:tokens?|token\s+spend|discovery|exploration)\b/i,
    /\bspends?\s+(?:fewer|less)\s+(?:tokens|money)\b/i,
  ];

  /** The one file that would have to back a claim up, and so the one thing a claim must cite. */
  const EVIDENCE = "index-benefit";

  const SCANNED = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".md", ".sql"]);
  const SKIPPED = new Set(["node_modules", ".codewiki", ".git", "dist", "out", "release", "coverage"]);

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (SKIPPED.has(entry.name)) return [];
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && SCANNED.has(extname(entry.name)) ? [full] : [];
    });
  }

  it("finds no saving asserted anywhere that does not point at the report", () => {
    const root = join(here, "..", "..", "..", "..", "..", "..", "..");
    const files = [...walk(join(root, "apps")), ...walk(join(root, "packages")), ...walk(join(root, "scripts"))];
    // The scan has to actually be reaching the tree; a walk that quietly
    // returned nothing would pass this test for ever.
    expect(files.length).toBeGreaterThan(200);

    const claims = files.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      if (text.includes(EVIDENCE)) return [];
      return text
        .split("\n")
        .map((line, at) => ({ line, at }))
        .filter(({ line }) => SAVING_CLAIMS.some((pattern) => pattern.test(line)))
        .map(({ line, at }) => `${relative(root, file)}:${at + 1} ${line.trim()}`);
    });

    expect(claims).toEqual([]);
  });

  /** The matcher has to be able to fail, or it is asserting nothing. */
  it("recognises the claim it is looking for", () => {
    const asserted = [
      "// the index saves tokens on every run",
      "* a query is cheaper than grepping",
      "Repository intelligence reduces the tokens an agent spends.",
      "It costs less than rediscovering the repository.",
    ];
    for (const line of asserted) expect(SAVING_CLAIMS.some((pattern) => pattern.test(line))).toBe(true);

    const innocent = [
      "// a handful of small file reads, which is cheaper than the writes it avoids",
      "// the number matters less than there being one",
      "const total = sorted.reduce((sum, value) => sum + value, 0);",
    ];
    for (const line of innocent) expect(SAVING_CLAIMS.some((pattern) => pattern.test(line))).toBe(false);
  });
});
