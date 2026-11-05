import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLDER_KIND, MEMORY_EXTRACT_TIMEOUT_MS, MEMORY_NOTE_DEFINITION, MEMORY_EXTRACTED_EVENT, MemoryExtractedEventSchema, MIN_EXTRACTION_PROSE_WORDS, type Item, type Run, type SideCallResult } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { addMemory, createProject, createRun, createWorkspace, getRun, listAgents, listMemories, updateRun } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import type { SideCaller } from "../sideCalls/sideCall.js";
import { extractionEvent, extractionInput, extractionItem, extractionSkip, extractMemory, MEMORY_EXTRACT_SYSTEM, proseWords, reportedResult, runProduce } from "./extraction.js";
import type { MemoryScopeInfo } from "./selection.js";

/**
 * The extraction rules on their own (EO-479): what a run's prose is,
 * when nothing is asked, and what the one call is asked with. Driven
 * through a real dispatch in `supervisor/memoryExtraction.test.ts`.
 */
describe("memory extraction", () => {
  let handle: DbHandle;
  let item: Item;
  let scopes: MemoryScopeInfo[];
  let folder: string;

  beforeEach(() => {
    handle = openMigratedTestDb();
    folder = mkdtempSync(join(tmpdir(), "eo-extraction-"));
    const w = createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: folder } });
    const p = createProject(handle.db, { name: "Payments", keyPrefix: "PAY", workspaceIds: [w.id] });
    item = createTestItem(handle.db, {
      type: "story",
      title: "Add CSV export",
      body: "Finance wants the settlements as a spreadsheet.",
      spec: { acceptance_criteria: ["The export lists every settlement.", "  "] },
      stepId: "todo",
      projectId: p.id,
      workspaceId: w.id,
    });
    scopes = [
      { scope: { kind: "project", id: p.id }, name: "Payments" },
      { scope: { kind: "workspace", id: w.id }, name: "api" },
    ];
  });

  afterEach(() => {
    handle.close();
    rmSync(folder, { recursive: true, force: true });
  });

  const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(" ");
  const implementer = () => listAgents(handle.db).find((agent) => agent.role === "implementer")!;

  function endedRun(fields: Partial<Pick<Run, "status" | "interruption" | "result">>): Run {
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer().id, action: "implement", status: "running" });
    updateRun(handle.db, run.id, { status: "succeeded", endedAt: Date.now(), ...fields });
    return getRun(handle.db, run.id)!;
  }

  it("counts the words in the strings of the final answer, and asks at fifty but not at forty-nine", () => {
    const at = endedRun({ result: { raw: {}, parsed: { summary: words(MIN_EXTRACTION_PROSE_WORDS - 2), handoff: "two words" } } });
    expect(proseWords(at, runProduce(handle.db, at))).toBe(MIN_EXTRACTION_PROSE_WORDS);
    expect(extractionSkip(at, item, runProduce(handle.db, at), scopes)).toBeNull();

    const under = endedRun({ result: { raw: {}, parsed: { summary: words(MIN_EXTRACTION_PROSE_WORDS - 1) } } });
    expect(extractionSkip(under, item, runProduce(handle.db, under), scopes)).toBe("little_prose");
  });

  it("asks about a run that succeeded, failed or awaits input, and about no other", () => {
    const result = { raw: {}, parsed: { summary: words(80) } };
    for (const status of ["succeeded", "failed", "awaiting_input"] as const) {
      const run = endedRun({ status, result });
      expect(extractionSkip(run, item, runProduce(handle.db, run), scopes), status).toBeNull();
    }
    const cancelled = endedRun({ status: "cancelled", result });
    expect(extractionSkip(cancelled, item, runProduce(handle.db, cancelled), scopes)).toBe("not_ended");
    const interrupted = endedRun({ status: "cancelled", interruption: "quit", result });
    expect(extractionSkip(interrupted, item, runProduce(handle.db, interrupted), scopes)).toBe("interrupted");
    const ok = endedRun({ result });
    expect(extractionSkip(ok, { previewAt: Date.now() }, runProduce(handle.db, ok), scopes)).toBe("preview");
    expect(extractionSkip(ok, item, runProduce(handle.db, ok), [])).toBe("no_scopes");
  });

  it("makes one memory_extract call inside the run with a sixty-second limit, and writes nothing when it times out", async () => {
    const run = endedRun({ result: { raw: {}, parsed: { summary: words(80) } } });
    const sideCall = vi.fn(async (): Promise<SideCallResult<unknown>> => ({ ok: false, reason: "timeout", message: "The call took longer than its 60000 ms and was stopped." }));

    const outcome = await extractMemory({ db: handle.db, run, item, agent: implementer(), backend: "claude", scopes, sideCall: sideCall as unknown as SideCaller["sideCall"] });

    expect(outcome).toEqual({ kind: "failed", reason: "timeout", message: expect.any(String) });
    expect(sideCall).toHaveBeenCalledTimes(1);
    expect(sideCall).toHaveBeenCalledWith(expect.objectContaining({ purpose: "memory_extract", backend: "claude", insideRunId: run.id, itemId: item.id, timeoutMs: MEMORY_EXTRACT_TIMEOUT_MS }));
    expect(MEMORY_EXTRACT_TIMEOUT_MS).toBe(60_000);
    for (const info of scopes) expect(listMemories(handle.db, info.scope, { includeRetired: true })).toEqual([]);
  });

  it("does not write a note memory already holds word for word", async () => {
    const run = endedRun({ result: { raw: {}, parsed: { summary: words(80) } } });
    const answer = { notes: [{ scope: "project", text: "Settlements are in UTC." }, { scope: "project", text: "Settlements are in UTC." }] };
    const sideCall = vi.fn(async (): Promise<SideCallResult<unknown>> => ({ ok: true, value: answer }));

    const outcome = await extractMemory({ db: handle.db, run, item, agent: implementer(), backend: "claude", scopes, sideCall: sideCall as unknown as SideCaller["sideCall"] });

    expect(outcome).toMatchObject({ kind: "written", dropped: ["Memory already holds this, word for word."] });
    expect(listMemories(handle.db, scopes[0]!.scope).map((entry) => entry.body)).toEqual(["Settlements are in UTC."]);
  });

  it("says there was nothing to save when the answer holds no notes, rather than that it wrote none (EO-511)", async () => {
    const run = endedRun({ result: { raw: {}, parsed: { summary: words(80) } } });
    const sideCall = vi.fn(async (): Promise<SideCallResult<unknown>> => ({ ok: true, value: { notes: [] } }));

    const outcome = await extractMemory({ db: handle.db, run, item, agent: implementer(), backend: "claude", scopes, sideCall: sideCall as unknown as SideCaller["sideCall"] });

    expect(outcome).toEqual({ kind: "nothing_to_save" });
    expect(sideCall).toHaveBeenCalledTimes(1);
    for (const info of scopes) expect(listMemories(handle.db, info.scope, { includeRetired: true })).toEqual([]);
  });

  it("says it wrote, with each refusal, when the answer held notes and none of them could be kept", async () => {
    const run = endedRun({ result: { raw: {}, parsed: { summary: words(80) } } });
    const answer = { notes: [{ scope: "not-a-workspace", text: "Settlements are in UTC." }, { scope: "project", text: "   " }] };
    const sideCall = vi.fn(async (): Promise<SideCallResult<unknown>> => ({ ok: true, value: answer }));

    const outcome = await extractMemory({ db: handle.db, run, item, agent: implementer(), backend: "claude", scopes, sideCall: sideCall as unknown as SideCaller["sideCall"] });

    expect(outcome).toEqual({ kind: "written", entryIds: [], dropped: [expect.stringContaining("not-a-workspace"), expect.any(String)] });
    for (const info of scopes) expect(listMemories(handle.db, info.scope, { includeRetired: true })).toEqual([]);
  });

  it("says it wrote, with the new entries, when the answer held a note it kept", async () => {
    const run = endedRun({ result: { raw: {}, parsed: { summary: words(80) } } });
    const sideCall = vi.fn(async (): Promise<SideCallResult<unknown>> => ({ ok: true, value: { notes: [{ scope: "project", text: "Settlements are in UTC." }] } }));

    const outcome = await extractMemory({ db: handle.db, run, item, agent: implementer(), backend: "claude", scopes, sideCall: sideCall as unknown as SideCaller["sideCall"] });

    const written = listMemories(handle.db, scopes[0]!.scope);
    expect(written.map((entry) => entry.body)).toEqual(["Settlements are in UTC."]);
    expect(outcome).toEqual({ kind: "written", entryIds: [written[0]!.id], dropped: [] });
  });

  it("lays out what memory holds before the run, and ends on the run's final answer and what is asked (EO-511)", () => {
    const existing = addMemory(handle.db, { scope: scopes[0]!.scope, body: "Money is integer cents.", source: { type: "person", personId: null } });
    if (!existing.ok) throw new Error(existing.problem);
    const input = extractionInput({
      agentName: "Implementer",
      action: "implement",
      status: "succeeded",
      resultKey: null,
      item: { title: "Add CSV export", description: "Finance wants a spreadsheet.", acceptanceCriteria: ["The export lists every settlement."] },
      produce: { finalAnswer: "The CSV writer must emit a byte order mark.", comments: ["Starting."], toolNames: ["Read"], calledMemoryNote: false },
      humanComments: ["a person: Keep the column order."],
      scopes,
      existing: [existing.entry],
    });

    const at = (text: string) => input.indexOf(text);
    expect(at("# Where a note may go")).toBe(0);
    expect(at("Money is integer cents.")).toBeGreaterThan(at("# What memory already holds"));
    expect(at("# The run")).toBeGreaterThan(at("Money is integer cents."));
    expect(at("# The item the run worked on")).toBeGreaterThan(at("Money is integer cents."));
    expect(at("Finance wants a spreadsheet.")).toBeGreaterThan(at("# The item the run worked on"));
    expect(at("- The export lists every settlement.")).toBeLessThan(at("# What people said on the item"));
    expect(at("Keep the column order.")).toBeLessThan(at("# The run"));
    expect(at("Starting.")).toBeGreaterThan(at("# The run"));
    expect(at("The CSV writer must emit a byte order mark.")).toBeGreaterThan(at("Starting."));
    expect(input.trimEnd().split("\n").at(-3)).toBe("# Your answer");
  });

  it("records every outcome that asked something as a memory_extracted event, nothing_to_save apart from written, and no event for a skip (EO-511)", () => {
    expect(extractionEvent({ kind: "skipped", reason: "little_prose" })).toBeNull();
    const events = [
      extractionEvent({ kind: "nothing_to_save" }),
      extractionEvent({ kind: "written", entryIds: ["e1"], dropped: ["refused"] }),
      extractionEvent({ kind: "failed", reason: "timeout", message: "too slow" }),
    ];
    expect(events).toEqual([
      { type: MEMORY_EXTRACTED_EVENT, outcome: "nothing_to_save", entryIds: [], dropped: [], reason: null },
      { type: MEMORY_EXTRACTED_EVENT, outcome: "written", entryIds: ["e1"], dropped: ["refused"], reason: null },
      { type: MEMORY_EXTRACTED_EVENT, outcome: "failed", entryIds: [], dropped: [], reason: "timeout: too slow" },
    ]);
    for (const event of events) expect(MemoryExtractedEventSchema.safeParse(event).success).toBe(true);
  });
  it("shows the item's title, description and acceptance criteria, and the result the run reported beside how it ended (EO-592)", async () => {
    const run = endedRun({ result: { raw: {}, parsed: { result: "sent_back", summary: words(80) } } });
    const sideCall = vi.fn(async (): Promise<SideCallResult<unknown>> => ({ ok: true, value: { notes: [] } }));

    await extractMemory({ db: handle.db, run, item, agent: implementer(), backend: "claude", scopes, sideCall: sideCall as unknown as SideCaller["sideCall"] });

    const asked = (sideCall.mock.calls[0] as unknown as [{ input: string; system: string }])[0];
    expect(asked.system).toBe(MEMORY_EXTRACT_SYSTEM);
    expect(asked.input).toContain("Title: Add CSV export");
    expect(asked.input).toContain("Finance wants the settlements as a spreadsheet.");
    expect(asked.input).toContain("## Its acceptance criteria\n\n- The export lists every settlement.\n\n#");
    expect(asked.input).toContain('It ended: succeeded, reporting the result "sent_back".');
  });

  it("reads a reported result off the answer's result field, and says none where there is none", () => {
    expect(reportedResult(endedRun({ result: { raw: {}, parsed: { result: "opened", summary: "x" } } }))).toBe("opened");
    expect(reportedResult(endedRun({ result: { raw: {}, parsed: { summary: "x" } } }))).toBeNull();
    expect(reportedResult(endedRun({ result: { raw: {}, parsed: { result: 3 } } }))).toBeNull();
    expect(reportedResult(endedRun({ result: { raw: {}, parsed: "plain text" } }))).toBeNull();
    expect(reportedResult(endedRun({ result: null }))).toBeNull();
    const ran = extractionInput({
      agentName: "Agent",
      action: "act",
      status: "failed",
      resultKey: null,
      item: extractionItem({ title: "T", body: "   ", spec: null }),
      produce: { finalAnswer: null, comments: [], toolNames: [], calledMemoryNote: false },
      humanComments: [],
      scopes,
      existing: [],
    });
    expect(ran).toContain('Agent ran the action "act". It ended: failed.');
    expect(ran).toContain("## Its description\n\n(none)");
    expect(ran).toContain("## Its acceptance criteria\n\n(none)");
  });

  it("builds the prompt from core's one definition of a note, which tells the work under way apart from the project (EO-592)", () => {
    expect(MEMORY_EXTRACT_SYSTEM).toContain(MEMORY_NOTE_DEFINITION);
    expect(MEMORY_EXTRACT_SYSTEM).not.toContain("a requirement the code or what it produces must meet");
    expect(MEMORY_NOTE_DEFINITION).toContain("a rule the whole project follows, for any change, not only this one");
    expect(MEMORY_NOTE_DEFINITION).toContain("would a later agent need this after this item is finished?");
    expect(MEMORY_NOTE_DEFINITION).toContain("What is wrong, missing or still to do in the work under way");
    expect(MEMORY_NOTE_DEFINITION).toContain("Anything that restates what the item asks for");
    expect(MEMORY_NOTE_DEFINITION).toContain('Not a note: "Ensure module-created items remain trial-scoped, or refuse before writing."');
    expect(MEMORY_NOTE_DEFINITION).toContain(
      'A note: "deleteConversationItem must delete the conversation\'s rows before its first await; tests expect them gone when the call returns."',
    );
    expect(MEMORY_EXTRACT_SYSTEM).toMatchSnapshot();
  });

  it("lays out an extraction's input the same way every time (EO-592)", () => {
    const fixed: MemoryScopeInfo[] = [
      { scope: { kind: "project", id: "project-1" }, name: "Payments" },
      { scope: { kind: "workspace", id: "workspace-1" }, name: "api" },
    ];
    const input = extractionInput({
      agentName: "Checker",
      action: "check",
      status: "succeeded",
      resultKey: "sent_back",
      item: { title: "Add CSV export", description: "Finance wants a spreadsheet.", acceptanceCriteria: ["The export lists every settlement.", "Amounts are in cents."] },
      produce: { finalAnswer: '{ "result": "sent_back" }', comments: ["Looking at the export."], toolNames: ["Read", "Grep"], calledMemoryNote: false },
      humanComments: ["a person: Keep the column order."],
      scopes: fixed,
      existing: [
        {
          id: "entry-1",
          scope: { kind: "workspace", id: "workspace-1" },
          body: "Money is integer cents.",
          source: { type: "run", runId: "run-0", itemId: "item-0" },
        } as unknown as Parameters<typeof extractionInput>[0]["existing"][number],
        // A person's, which a note may never replace (EO-594).
        {
          id: "entry-2",
          scope: { kind: "project", id: "project-1" },
          body: "Settlements close at 17:00 UTC.",
          source: { type: "person", personId: null },
        } as unknown as Parameters<typeof extractionInput>[0]["existing"][number],
      ],
    });
    expect(input).toMatchSnapshot();
  });
});
