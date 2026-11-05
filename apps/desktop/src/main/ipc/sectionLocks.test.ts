import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECTION_LOCK_TEXT, type IpcChannel, type IpcPayload, type IpcResponse } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { markReplica } from "../db/recordRole.js";
import { createPerson, listAgents, listStepsForPipeline, publishSection } from "../db/repos/index.js";
import { sectionLockFor } from "../managed/locks.js";
import { saveAgent, savePipeline } from "./configCommands.js";
import { listPipelineStepViews } from "./domainQueries.js";
import { listSectionsCommand, publishPreflightCommand, publishSectionCommand } from "./sectionCommands.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "./registry.js";
import { TOOLS, type Dispatch } from "../mcpHost/catalog.js";

/**
 * The lock, from both doors (EO-329,
 * `ARCHITECTURE.md`, "Publish, lock and versions").
 *
 * The acceptance criterion this file exists for is a sentence about
 * *two callers*: "after publishing pipelines, `pipeline:save` on a
 * desktop and `pipeline_save` through the MCP host both return the
 * typed refusal; a test calls each". So both are called here, against
 * one database, through the registry they share — which is the whole
 * claim the design makes. A test that only drove the renderer's door
 * would pass in exactly the world the finding is about.
 */

let handle: DbHandle;
let stopBeingAReplica: (() => void) | null = null;

/**
 * The options `registerAllHandlers` builds, as far as this is about.
 *
 * The lock is a member of them rather than something each command
 * remembers, so a test that wired the handlers without it would be
 * testing a different door than the one the app hangs.
 */
const opts = { exposeErrorDetails: true, sectionLock: (channel: IpcChannel) => sectionLockFor(handle.db, channel) };
const dispatch: Dispatch = (channel: IpcChannel, payload: unknown) => dispatchIpc(channel, payload);

function tool(name: string) {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
}

/** This machine has a record somewhere else — a desktop signed in to an organisation. */
function signedInToAnOrganisation(): void {
  stopBeingAReplica = markReplica(handle.db, () => true);
}

/** The graph as it stands, ready to be sent back through `pipeline:save`. */
function currentGraph(pipelineId = "default"): IpcPayload<"pipeline:save"> {
  const graph = listPipelineStepViews(handle.db, { pipelineId });
  return { pipelineId, steps: graph.steps, routes: graph.routes, entryStepId: graph.entryStepId };
}

/** What the two pack doors were asked to write, so a refusal can be seen to have stopped them. */
let imported: string[] = [];

beforeEach(() => {
  imported = [];
  handle = openMigratedTestDb();
  registerHandler("pipeline:save", (payload) => savePipeline(handle.db, undefined, payload), opts);
  registerHandler("agents:save", (payload) => saveAgent(handle.db, payload), opts);
  registerHandler("sections:list", () => listSectionsCommand(handle.db), opts);
  registerHandler("sections:publish", (payload) => publishSectionCommand(handle.db, payload), opts);
  registerHandler("sections:publishPreflight", (payload) => publishPreflightCommand(handle.db, payload), opts);
  // Stubs, because what is being proved is that they are never reached:
  // the lock is asked before the payload is read, let alone written.
  registerHandler(
    "pipelines:import",
    () => {
      imported.push("pipelines:import");
      return { imported: true, pipelineId: "default", unapprovedModules: [], keptDefinitions: [], problem: null };
    },
    opts,
  );
  registerHandler(
    "gallery:use",
    () => {
      imported.push("gallery:use");
      return { ok: true, projectId: null, pipelineId: null, jobId: null, itemId: null, problem: null, needs: [] };
    },
    opts,
  );
});

afterEach(() => {
  stopBeingAReplica?.();
  stopBeingAReplica = null;
  clearHandlerRegistry();
  handle.close();
});

describe("a section the organisation has published", () => {
  beforeEach(() => {
    // What the sync delivers: the record's row, stored here read-only.
    publishSection(handle.db, {
      section: "pipelines",
      subjectId: "default",
      versionId: "a-version",
      versionNumber: 6,
      publishedAt: Date.now(),
      publishedBy: "dana-id",
      publishedByName: "Dana",
    });
    signedInToAnOrganisation();
  });

  it("refuses pipeline:save on a desktop with the typed refusal", async () => {
    const before = listStepsForPipeline(handle.db, "default").length;
    const graph = currentGraph();

    const answer = await dispatchIpc("pipeline:save", { ...graph, steps: graph.steps.slice(0, 1) });

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    // Typed, so a renderer branches on it rather than on the English.
    expect(answer.error.code).toBe("section-locked");
    expect(answer.error.lock).toEqual({ locked: true, section: "pipelines", publishedBy: "Dana" });
    // And nothing was written — the refusal is before the handler, not
    // an apology after it.
    expect(listStepsForPipeline(handle.db, "default").length).toBe(before);
  });

  it("refuses pipeline_save through the MCP host as a tool error naming the section", async () => {
    const before = listStepsForPipeline(handle.db, "default").length;
    const graph = currentGraph();

    const outcome = await tool("pipeline_save").run(dispatch, { ...graph, steps: graph.steps.slice(0, 1) });

    // `ok: false` rather than a refusal on a successful call: the
    // system agent must read this as the tool failing, not as an answer
    // it can work around.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("pipelines");
    expect(outcome.message).toContain("Dana");
    expect(outcome.message).toContain("Nothing has been written");
    expect(listStepsForPipeline(handle.db, "default").length).toBe(before);
  });

  it("leaves a section nobody published editable on the same machine", async () => {
    const answer = await dispatchIpc("agents:save", { name: "Reviewer", role: "reviewer", provider: "claude", model: "sonnet", instructions: "Reviews.", enabled: true });

    expect(answer).toMatchObject({ ok: true });
    expect(listAgents(handle.db).some((agent) => agent.name === "Reviewer")).toBe(true);
  });

  it("says which sections are locked, and carries the one sentence §4.3 writes", () => {
    const answer = listSectionsCommand(handle.db);

    expect(answer.locked).toEqual(["pipelines"]);
    expect(answer.lockText).toBe(SECTION_LOCK_TEXT);
    expect(answer.lockText).toContain("Your sign-ins, local folders and personal secrets are yours.");
  });

  it("refuses to publish from a desktop at all", async () => {
    // Admin-only is enforced at a *server's* door; a person's own
    // machine has no such door, and a laptop that could publish would
    // be a laptop locking itself out of its own editor.
    const answer = await dispatchIpc("sections:publish", { section: "agents" });

    expect(answer).toMatchObject({ ok: true });
    if (!answer.ok) return;
    const data = answer.data as IpcResponse<"sections:publish">;
    expect(data.published).toEqual([]);
    expect(data.problem).toContain("not your organisation's record");
    // And nothing new was written: the agents section is still nobody's
    // but this machine's.
    expect(listSectionsCommand(handle.db).locked).toEqual(["pipelines"]);
  });

  it("refuses a pack arriving by either door while agents or policy are published", async () => {
    // `writeImport` calls `writeRoles` and `writeMcpServers`, so a pack
    // brings agents with prompts and tool surfaces *and* declares which
    // MCP servers exist. Both doors are therefore writes into three
    // sections, and whichever of them is published refuses the import —
    // otherwise the lock's whole subject arrives by another name
    // (EO-329, review).
    publishSection(handle.db, { section: "agents", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });

    for (const channel of ["pipelines:import", "gallery:use"] as const) {
      const answer = await dispatchIpc(channel, channel === "pipelines:import" ? { document: "{}", choices: {} } : { slug: "weekly-report" });

      expect(answer.ok).toBe(false);
      if (answer.ok) continue;
      expect(answer.error.code).toBe("section-locked");
      // The pipelines section is published here too, and it is named
      // first — a channel in two sections always refuses under the same
      // name, whichever door the caller knocked on.
      expect(answer.error.lock?.section).toBe("pipelines");
    }
    // Neither handler ran: the refusal is before them.
    expect(imported).toEqual([]);
  });

  it("lets go of the lock when the machine stops being a device", async () => {
    // The row is still here; this machine is not somebody's device any
    // more. A lock that survived the link would be a configuration
    // nobody on earth could unlock.
    stopBeingAReplica?.();
    stopBeingAReplica = null;

    const answer = await dispatchIpc("pipeline:save", currentGraph());

    expect(answer).toMatchObject({ ok: true });
    expect(listSectionsCommand(handle.db).locked).toEqual([]);
  });
});

describe("the record an admin publishes from", () => {
  it("does not lock itself, and locks every desktop", async () => {
    const dana = createPerson(handle.db, { name: "Dana", email: "dana@example.com" });
    // Published by an admin on the record: no `markReplica` here,
    // because a server is the record and has no record elsewhere.
    const published = await dispatchIpc("sections:publish", { section: "pipelines", actingDeviceId: undefined });
    expect(published).toMatchObject({ ok: true });

    // Still editable here. This is the whole reason the lock asks
    // whether the installation is a replica as well as whether the row
    // exists: the admin is the one person who must be able to edit it.
    expect(await dispatchIpc("pipeline:save", currentGraph())).toMatchObject({ ok: true });
    expect(listSectionsCommand(handle.db).locked).toEqual([]);
    expect(dana.name).toBe("Dana");

    // …and the rows say what a desktop would be told.
    const rows = listSectionsCommand(handle.db).published;
    expect(rows.map((row) => row.section)).toContain("pipelines");
    expect(rows.every((row) => row.versionNumber !== null)).toBe(true);
  });

  it("confirms with the count of what finishes on the older version", async () => {
    const answer = await dispatchIpc("sections:publishPreflight", { section: "pipelines" });

    expect(answer).toMatchObject({ ok: true });
    if (!answer.ok) return;
    const preflight = answer.data as IpcPayload<"sections:publishPreflight"> & { confirmation: string; items: number };
    // Nothing on the board yet, so the honest sentence is the other one
    // rather than "0 items in flight across 0 desktops".
    expect(preflight.confirmation).toBe("Nothing is in flight. Every desktop takes this version.");
    expect(preflight.items).toBe(0);
  });
});
