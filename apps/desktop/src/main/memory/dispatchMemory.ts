import {
  MEMORY_DELIVERED_EVENT,
  MEMORY_SELECT_TIMEOUT_MS,
  MemorySelectionSchema,
  type Agent,
  type Comment,
  type Item,
  type MemoryDeliveredEvent,
  type MemoryEntryView,
  type MemoryReadScope,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { activeMemoriesIn, getProject, getWorkspace, listAgents, listCommentsForItem, listRunsForItem, workspaceLabel } from "../db/repos/index.js";
import type { SideCaller } from "../sideCalls/sideCall.js";
import { lastRunOf } from "../supervisor/stepAttribution.js";
import { skillRunScope } from "../supervisor/workspaceResolution.js";
import { containerScopeOf } from "./containerScope.js";
import { chooseMemory, MEMORY_SELECT_SYSTEM, newestWithin, renderMemorySection, selectionInput, type MemoryChoice, type MemoryScopeInfo, type MemoryTask } from "./selection.js";

/**
 * The memory a dispatch is given (EO-478, ARCHITECTURE.md, "What an agent
 * is given") — the database half of `selection.ts`.
 */

/**
 * The scopes a dispatch draws from: the item's project, the workspace
 * its step works in, and the container it is filed under (EO-596).
 *
 * `worksInWorkspace` is false for a step that has none — a conversation,
 * or the `none` kind — which is given the project's entries only. Which
 * workspace a step works in is `skillRunScope`'s answer, the same one
 * the skills a run is given are decided by, so a run's skills and its
 * memory cannot be about different disks. Empty for an item with no
 * project.
 *
 * The container's scope is there for an item whose parent is a container
 * item on a project — whatever its step works in, since what it holds is
 * about the work under the container rather than a disk — and for no
 * other item: not the container itself, nor an item filed under nothing.
 */
export function memoryScopesFor(db: Db, item: Item, options: { worksInWorkspace: boolean }): MemoryScopeInfo[] {
  const where = skillRunScope(db, item);
  const scopes: MemoryScopeInfo[] = [];
  const project = where.projectId === null ? undefined : getProject(db, where.projectId as Uuid);
  if (project) scopes.push({ scope: { kind: "project", id: project.id }, name: project.name });
  if (options.worksInWorkspace && where.workspaceId !== null) {
    const workspace = getWorkspace(db, where.workspaceId as Uuid);
    if (workspace) scopes.push({ scope: { kind: "workspace", id: workspace.id }, name: workspaceLabel(workspace) });
  }
  const container = containerScopeOf(db, item);
  if (project && container) scopes.push(container);
  return scopes;
}

/**
 * The scopes as the `eo` server is told them, so `memory_read` reads these
 * and no others, and `memory_note` is listed for them. Where a note goes
 * is not the server's to know: it hands every note to EO over the agent
 * write bridge, and EO writes it through whichever record holds the
 * project (EO-543).
 */
export function memoryReadScopes(scopes: readonly MemoryScopeInfo[]): MemoryReadScope[] {
  return scopes.map((info) => ({ ...info.scope, name: info.name }));
}

function authorOf(comment: Comment, agentNames: Map<string, string>): string {
  if (comment.authorType === "human") return "a person";
  if (comment.authorType === "agent") return (comment.authorId ? agentNames.get(comment.authorId) : undefined) ?? "an agent";
  if (comment.authorType === "engine") return "EO";
  return comment.authorType;
}

/**
 * What the selection is told the task is.
 *
 * On a step: the item's title and body, the action, and the comments
 * since this agent last ran on the item — everyone's but its own, which
 * it wrote. On a conversation turn: the latest message, because there the
 * message is the task and the item is only the room it is said in.
 */
export function memoryTaskFor(db: Db, item: Item, agent: Agent, action: string, conversation: boolean): MemoryTask {
  const comments = listCommentsForItem(db, item.id).filter((comment) => !(comment.authorType === "agent" && comment.authorId === agent.id));
  if (conversation) {
    const latest = comments.filter((comment) => comment.authorType === "human").at(-1) ?? comments.at(-1);
    return { kind: "conversation", latestMessage: latest?.body ?? item.title };
  }
  const priorRun = lastRunOf(listRunsForItem(db, item.id), agent.id);
  const since =
    priorRun === undefined || priorRun.endedAt === null
      ? comments
      : comments.filter((comment) => comment.createdAt > priorRun.endedAt! || (comment.createdAt === priorRun.endedAt && comment.id > priorRun.id));
  const agentNames = new Map(listAgents(db).map((candidate) => [candidate.id as string, candidate.name]));
  return {
    kind: "step",
    title: item.title,
    body: item.body ?? "",
    action,
    comments: since.map((comment) => ({ author: authorOf(comment, agentNames), body: comment.body })),
  };
}

export interface DeliveredMemory {
  /** The section to add to the turn's context, or null when no scope holds anything. */
  section: string | null;
  /** What the run's events record: the delivered ids, and whether selection ran. */
  event: MemoryDeliveredEvent;
  choice: MemoryChoice;
}

/**
 * Whether a run on this item wrote the entry, by `memory_note` or by
 * extraction (EO-611). Such a note is not a candidate for the item's later
 * runs: on the same thread the agent wrote it, and on any other it is the
 * item's own account of itself, which the next step is meant to check
 * rather than read. A person's entry is not one, and nor is a note from
 * any other item, a sibling under the same container included.
 */
function writtenOnItem(entry: MemoryEntryView, item: Item): boolean {
  return entry.source.type === "run" && entry.source.itemId === item.id;
}

/**
 * Chooses and renders a dispatch's memory.
 *
 * The selection, when there is one, is one `memory_select` side call on
 * the dispatched agent's backend, inside the run being dispatched — so it
 * uses that run's slot and spends against its item and day — with a
 * 20-second limit. Never rejects: whatever goes wrong with the call
 * becomes the fallback, and the dispatch proceeds. Synchronous when no
 * selection is needed.
 */
export function deliverMemory(input: {
  db: Db;
  item: Item;
  agent: Agent;
  action: string;
  runId: Uuid;
  /** The backend the run is on: the agent's, or `fake` for a preview. */
  backend: string;
  scopes: readonly MemoryScopeInfo[];
  conversation: boolean;
  thresholdChars: number;
  sideCall: SideCaller["sideCall"];
  now: number;
  signal?: AbortSignal;
}): DeliveredMemory | Promise<DeliveredMemory> {
  const { db, item, agent, action, scopes } = input;
  const activeCandidates = (): MemoryEntryView[] =>
    activeMemoriesIn(
      db,
      scopes.map((info) => info.scope),
    ).filter((entry) => !writtenOnItem(entry, item));
  const candidates = activeCandidates();
  const projectId = (scopes.find((info) => info.scope.kind === "project")?.scope.id as Uuid | undefined) ?? null;
  const choice = chooseMemory({
    candidates,
    thresholdChars: input.thresholdChars,
    select: (all) =>
      input.sideCall({
        purpose: "memory_select",
        backend: input.backend,
        schema: MemorySelectionSchema,
        system: MEMORY_SELECT_SYSTEM,
        input: selectionInput(memoryTaskFor(db, item, agent, action, input.conversation), all, scopes),
        itemId: item.id,
        projectId,
        timeoutMs: MEMORY_SELECT_TIMEOUT_MS,
        insideRunId: input.runId,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
  });
  const finish = (chosen: MemoryChoice, current: readonly MemoryEntryView[]): DeliveredMemory => ({
    section: renderMemorySection({ scopes, candidates: current, choice: chosen, now: input.now }),
    event: {
      type: MEMORY_DELIVERED_EVENT,
      entryIds: chosen.delivered.map((entry) => entry.id),
      candidateCount: current.length,
      mode: chosen.mode,
      selectionRan: chosen.selectionRan,
      reason: chosen.reason,
    },
    choice: chosen,
  });
  // A promise only when a selection was asked for (`chooseMemory`).
  if (!(choice instanceof Promise)) return finish(choice, candidates);
  return choice.then((chosen) => {
    // Read again: up to twenty seconds have passed, and an entry a person
    // retired or edited meanwhile is not active any more (EO-478 review).
    // What is delivered is held to the rows as they are now — a picked
    // entry still active, in its current text, or the newest current
    // entries on a fallback — and the section's counts are the current
    // ones too.
    const current = activeCandidates();
    const byId = new Map(current.map((entry) => [entry.id, entry]));
    const delivered =
      chosen.mode === "fallback"
        ? newestWithin(current, input.thresholdChars)
        : chosen.delivered.flatMap((entry) => byId.get(entry.id) ?? []);
    return finish({ ...chosen, delivered }, current);
  });
}
