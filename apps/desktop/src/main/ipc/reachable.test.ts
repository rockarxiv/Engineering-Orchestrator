import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ipcContract, ipcPushContract } from "@eo/core";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../mcpHost/catalog.js";

/**
 * Nothing in the contract should be unreachable (U-14).
 *
 * Three capabilities in a row turned out to be wired end to end except
 * where a person meets them — no way to create a feature (U-08),
 * decomposition never called (R-04), priority never settable (U-13) —
 * and each was found by accident. This is that check, kept.
 *
 * It reads source text rather than imports on purpose: what matters is
 * whether a human-facing caller exists, not whether the module graph
 * happens to link.
 */
const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = join(here, "..", "..", "renderer", "src");
const mainRoot = join(here, "..");

function sourceUnder(root: string, includeTests = false): string {
  let text = "";
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      text += sourceUnder(path, includeTests);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (!includeTests && /\.test\.tsx?$/.test(entry)) continue;
    text += readFileSync(path, "utf8");
  }
  return text;
}

const renderer = sourceUnder(rendererRoot);
const main = sourceUnder(mainRoot);

/**
 * The renderer is no longer the only way a capability is reached.
 *
 * EO hosts an MCP server, and a channel offered as one of its tools is
 * reachable by definition — by a person's editor rather than by a
 * screen. This check exists so that nothing in the contract is wired up
 * everywhere except where someone could use it, and a tool satisfies
 * that as squarely as a button does.
 *
 * Deliberately the catalog rather than a hand-kept list: the same
 * property is checked from the other side in `mcpHost/catalog.test.ts`,
 * which refuses a tool naming a channel the contract does not have, so
 * the two cannot drift into agreeing about a channel that is not real.
 */
const catalogued = new Set<string>(TOOLS.flatMap((tool) => tool.channels));

/**
 * A channel whose caller is a later phase's, and which phase that is.
 *
 * The exception this test has to have, and the narrowest shape it can
 * take. The platform phases deliberately land a model before the screen
 * that drives it — phase 5 gives an item an assignee, and the people to
 * hand one to arrive with the server in phase 7b — so for the phases in
 * between there is a command with nothing calling it, and a rule that
 * cannot say so would be answered by wiring a button somewhere just to
 * satisfy it.
 *
 * It shrinks, and has. `items:setOutput` sat here from EO-298 until
 * EO-311 put the editor above the thread; the entry left in the same
 * change as the screen, which is the bargain below.
 *
 * Written as a record rather than a set, for `importAllowlist.test.ts`'s
 * reason (invariant 13): every entry names the phase it leaves in, so
 * the list is a plan rather than a ledger nobody reads. It may not grow
 * quietly — an entry naming a channel that *is* reachable fails below,
 * so a screen landing takes its entry with it.
 *
 * Not a way around the MCP decision, either. `mcpHost/catalog.test.ts`
 * still demands a written-down judgement for every channel it does not
 * offer, and `items:assign` has one there on its own merits: who holds a
 * piece of work is not a thing a client gets to decide on a person's
 * behalf.
 */
const AWAITING_ITS_SCREEN: Partial<Record<keyof typeof ipcContract, string>> = {
  // Empty, and that is the bargain working rather than the list being
  // forgotten. `items:assign` was the one entry: "the people picker,
  // platform phase 7b — until the server brings colleagues there is
  // nobody on this machine to hand an item to". Phase 7b is where the
  // server brings them, and EO-326 is where the picker landed —
  // the assignee picker, drawn only where there is more than one
  // person, which is the same invariant-12 condition the entry named.
  // The entry left with the screen it was waiting for, which is what
  // the case below enforces.
  //
  // Memory's seven channels (EO-478, EO-480) waited here for the panel a
  // person reads and corrects memory in, and left with it: EO-481's
  // `memory/memoryPanel.ts`, drawn in the project and workspace
  // settings.
};

/**
 * A channel whose caller is *another EO*, and why that counts (EO-323).
 *
 * The exception this test grew when managed mode did. `auth:signIn` is
 * not a screen and never will be one: it is what a desktop's main
 * process asks an organisation server over HTTP, out of
 * `ipc/sessionCommands.ts`, on behalf of the sign-in screen a person is
 * actually looking at. The screen calls `session:signIn`; that handler
 * calls this; and a renderer calling it directly would be a renderer
 * signing in to the process it is already inside.
 *
 * So it is reachable — more thoroughly than most, since two processes
 * and a socket sit on the path — and the rule below is still the rule it
 * always was: a caller has to exist somewhere a person's action leads.
 * The entry names where, and the check under it holds the claim to being
 * true rather than remembered.
 */
const REACHED_BY_A_DESKTOP: Partial<Record<keyof typeof ipcContract, string>> = {
  "auth:signIn": "ipc/sessionCommands.ts — a desktop asks its organisation server, over HTTP, for the sign-in screen a person is looking at",
  // The record contract (EO-324). Every one of these is asked by a
  // *device* rather than by a screen, which is the point of them: the
  // renderer draws the board and the machine underneath it is what
  // talks to the record. `record/remoteRecord.ts` sends the three
  // questions, `record/drain.ts` sends the commands and pulls the
  // changes, and both are main.
  "record:work": "record/remoteRecord.ts — the device's tick asks the record what it may run",
  "record:renew": "record/remoteRecord.ts — the device says its claims still stand, and at boot which are no longer its",
  "record:release": "record/remoteRecord.ts — the device gives a claim back when its dispatch ends",
  "record:apply": "record/drain.ts — the device replays what it did, in the order it did it",
  "record:changes": "record/drain.ts — the device pulls what the record has that it has not seen",
  // EO-328. Asked by the device's *dispatch*, immediately before it
  // starts a run: the design's budget is a person's rather than a machine's,
  // so the figure has to be the record's — a device summing its own
  // replica gave each of one person's desktops the whole ceiling.
  "record:spend": "record/remoteRecord.ts — the device asks the record what this person has spent today, before dispatching",
  "record:createItem": "record/remoteRecord.ts — a module's run on a device asks the record to create the work item ctx.createItem named",
  "record:attachment": "record/drain.ts — the device fetches a file the record told it about",
  // EO-471. Asked by `projects:thread` on a desktop whose project the
  // organisation holds: the thread is the record's to make.
  "record:projectThread": "record/remoteRecord.ts — a desktop asks the record for a moved project's thread when a person opens its notes",
  // EO-600. Asked by `items:update` on a desktop whose project the
  // organisation holds: what its items wait for is the record's to change.
  // EO-726. A message about a project the organisation holds lives on
  // its record: sent, answered and dismissed there, and pulled by its
  // recipients' desktops.
  "record:sendMessage": "record/remoteRecord.ts — a desktop asks the record to send EO's message about a project it holds to each admin",
  "record:handleMessage": "record/remoteRecord.ts — a desktop asks the record to mark a message it holds answered or dismissed when a person presses in the Inbox",
  "record:messages": "record/drain.ts — the device pulls its person's messages the record holds",
  "record:changeDependencies": "record/remoteRecord.ts — a desktop asks the record to change what an item waits for when a person or item_update sends addDependsOn or removeDependsOn",
  // EO-533. Asked by `assist:openUpdateConflict` on a desktop whose
  // admin pressed Fix with assistant on a notice the record posted.
  "record:updateConflictChat": "record/remoteRecord.ts — a desktop asks the record for the chat about a conflict it holds when a person presses Fix with assistant",
  // EO-534. Asked by `pipeline:updateConflict`, `pipeline:keepOwnVersion`
  // and `assist:publishOnRecord` on a desktop whose pipeline the record holds.
  "record:updateConflict": "record/remoteRecord.ts — a desktop asks the record for a held template update when its assistant reads one",
  "record:resolveUpdateConflict": "record/remoteRecord.ts — an admin's desktop resolves a held template update on the record when a person publishes a draft or keeps their pipeline",
  // EO-536. Asked by `pipeline:templateStatus` on a desktop whose
  // pipeline the record holds, when its board or Graph view is open.
  "record:templateStatus": "record/remoteRecord.ts — a desktop asks the record for a pipeline's template origin and update state when a person opens its board or graph",
  // EO-482. Asked by the memory_note path, extraction and the memory
  // panel on a desktop whose project the organisation holds.
  "record:memory": "record/remoteRecord.ts — a desktop asks the record to write to a moved project's memory: a run's note, or a person's edit",
  "record:memoryConsolidations": "record/remoteRecord.ts — the memory panel lists a moved project's consolidations, which ran on the record",
  "record:restoreMemoryConsolidation": "record/remoteRecord.ts — a person undoes one of those consolidations from the memory panel",
  // EO-325. Sent by `ipc/handlers.ts` on behalf of the keep-or-move
  // sheet a person is looking at: the screen presses
  // `projects:moveToRecord`, and that handler is what talks to the
  // organisation. A renderer calling this directly would be a renderer
  // handing a project to a server it has no client for.
  "record:adopt": "ipc/handlers.ts — a desktop hands a project's history to its organisation, page by page",
  // EO-331. `auth:signIn`'s case exactly, one story over: the screen
  // presses *Suggest my change*, which is `pipelines:suggest`, and that
  // handler is what sends the document to the organisation. A renderer
  // calling this one directly would be a renderer filing a suggestion
  // into the process it is already inside.
  "suggestions:create": "ipc/suggestionCommands.ts — a desktop sends its copy of a pipeline to the organisation as a change to review",
};

/**
 * A channel whose caller is a button on an assistant card (EO-529).
 *
 * The exception the classic layout's removal made. Item types are
 * changed through the assistant (EO-523): it proposes, a person presses
 * the card's Apply, and `assist:applyCard` carries the change out
 * through the very channel the classic editor's Types section used to
 * call — so its refusals are the editor's. That section was the
 * renderer's only caller, and it went with the layout; the person's
 * press still leads here, one handler further in.
 *
 * Held the way `REACHED_BY_A_DESKTOP` is: the entry names where main
 * sends it, and the check below fails an entry main no longer names.
 */
const REACHED_BY_A_CARD: Partial<Record<keyof typeof ipcContract, string>> = {
  "itemTypes:create": "ipc/assistCommands.ts — Apply on an itemTypeCreate card",
  "itemTypes:update": "ipc/assistCommands.ts — Apply on an itemTypeUpdate card",
  "itemTypes:delete": "ipc/assistCommands.ts — Apply on an itemTypeDelete card",
  // EO-534. The pipeline editor never had a button for this: a held
  // template update is resolved only from its assistant chat.
  "pipeline:keepOwnVersion": "ipc/assistCommands.ts — Keep my pipeline on a pipelineKeepMine card",
};

describe("every IPC channel is reachable", () => {
  it("has a renderer that calls it, or a tool that offers it", () => {
    // A channel nobody calls is a capability that exists everywhere
    // except where someone could use it.
    const unreachable = Object.keys(ipcContract).filter(
      (channel) =>
        !renderer.includes(`"${channel}"`) &&
        !catalogued.has(channel) &&
        !(channel in AWAITING_ITS_SCREEN) &&
        !(channel in REACHED_BY_A_DESKTOP) &&
        !(channel in REACHED_BY_A_CARD),
    );

    expect(unreachable).toEqual([]);
  });

  it("is actually asked by a desktop, where it says so", () => {
    // The other half of `REACHED_BY_A_DESKTOP`. An entry claiming main
    // asks a server for this channel, where main names it nowhere, is a
    // capability nothing reaches wearing an excuse.
    const unasked = Object.keys(REACHED_BY_A_DESKTOP).filter((channel) => !main.includes(`"${channel}"`));

    expect(unasked).toEqual([]);
  });

  it("is actually sent by a card's button, where it says so", () => {
    const unsent = Object.keys(REACHED_BY_A_CARD).filter((channel) => !main.includes(`dispatched(doors, "${channel}"`));

    expect(unsent).toEqual([]);
  });

  it("does not wait on a screen it already has", () => {
    // The other half of the exception: an entry that has been overtaken
    // by the screen it was waiting for is a line the next reader would
    // take for a capability still missing.
    const arrived = Object.keys(AWAITING_ITS_SCREEN).filter((channel) => renderer.includes(`"${channel}"`) || catalogued.has(channel));

    expect(arrived).toEqual([]);
  });

  it("has a handler registered for it", () => {
    // The other direction: a channel the renderer calls and the main
    // process never answers fails at runtime, not at build time.
    // Matched across newlines, because a handler with a body is written
    // over several lines.
    const registered = new Set([...main.matchAll(/registerHandler\(\s*"([^"]+)"/g)].map((match) => match[1]));
    const unhandled = Object.keys(ipcContract).filter((channel) => !registered.has(channel));

    expect(unhandled).toEqual([]);
  });
});

describe("every push channel is used", () => {
  it("is emitted by the main process and subscribed to by the renderer", () => {
    const pushes = Object.keys(ipcPushContract);

    const neverEmitted = pushes.filter((channel) => !main.includes(`emitPush("${channel}"`) && !main.includes(`"${channel}"`));
    const neverHeard = pushes.filter((channel) => !renderer.includes(`"${channel}"`));

    expect({ neverEmitted, neverHeard }).toEqual({ neverEmitted: [], neverHeard: [] });
  });
});
