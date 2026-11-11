import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isDispatchable,
  LOCAL_PERSON_ID,
  MEMORY_CONSOLIDATE_MAX_OUTPUT_TOKENS,
  MEMORY_CONSOLIDATE_TIMEOUT_MS,
  MEMORY_CONSOLIDATION_INTERVAL_MS,
  type MemoryConsolidateNowResult,
  type MemoryConsolidationOperations,
  type MemoryConsolidationTrigger,
  type MemoryEntryView,
  type MemoryScope,
  type MessageSend,
  sideCallModelOfSystemAgent,
  type SideCallModelChoice,
  type SideCallResult,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { onTransitionApplied } from "../db/transitionEvents.js";
import {
  activeMemoriesIn,
  addConsolidationSlotTime,
  appendConsolidationNote,
  applyConsolidation,
  asFolderWorkspace,
  asGitWorkspace,
  closeAbandonedConsolidations,
  consolidationState,
  failConsolidation,
  getItem,
  getProject,
  getWorkspace,
  lastRestoredAt,
  listAgents,
  listSkills,
  markConsolidationStuckNoticed,
  memoryScopeProjectId,
  projectWorkspaceList,
  recordSkippedConsolidation,
  runsDeliveredFromScopeSince,
  skipConsolidation,
  scopeTallies,
  similarMemoryNeighbours,
  startConsolidation,
  workspaceLabel,
} from "../db/repos/index.js";
import type { ApplyConsolidationResult, ScopeTally } from "../db/repos/memoryConsolidationsRepo.js";
import { resolveMessagesAbout, sendMessage as sendMessageHere, type MessageSendAnswer } from "../messages/messages.js";
import { agentReasoningEffort } from "../providers/smallModels.js";
import type { SideCaller, SideCallRequest } from "../sideCalls/sideCall.js";
import { applySkillProposals, discardedSkillProposals } from "./skillProposals.js";
import {
  consolidationAnswerSchema,
  consolidationDue,
  containerDoneAnswerSchema,
  containerDoneDue,
  containerDoneInput,
  containerDoneOperations,
  MEMORY_CONTAINER_DONE_SYSTEM,
  consolidationInput,
  consecutiveFailures,
  consolidationTargets,
  CONSOLIDATION_DEFERRED_REASON,
  CONSOLIDATION_PAUSED_REASON,
  crossBatchMergeInput,
  MEMORY_CONSOLIDATE_SYSTEM,
  MEMORY_CROSS_BATCH_MERGE_SYSTEM,
  EXISTING_SKILLS_MAX,
  MEMORY_PROPOSE_SKILLS_SYSTEM,
  peopleAloneOverCap,
  peopleOverCapNote,
  reachesCap,
  retryAt,
  skillProposalsAnswerSchema,
  skillProposalsInput,
  stuckNoticeBody,
  stuckNoticeOwed,
  type ExistingSkill,
  type MemoryCaps,
  type RepositoryFile,
} from "./consolidation.js";
import {
  batchTargets,
  CONSOLIDATION_BATCH_LIMITS,
  MEMORY_MERGE_CANDIDATES_SYSTEM,
  mergeCandidatesInput,
  mergeCandidatesSchema,
  pickCandidateGroups,
  planBatches,
  type EntryNeighbours,
} from "./consolidationBatches.js";
import { containerOfScope, containerWorkFinishedAt } from "./containerScope.js";
import { exactDuplicateOperations, exactDuplicates, likelyDuplicatesOf, nearDuplicateGroups, type ExactDuplicates } from "./duplicates.js";

/**
 * Automatic memory consolidation, the scheduling half (EO-480,
 * ARCHITECTURE.md, "What an agent is given").
 *
 * Looks at every scope that holds memory, queues the ones that are due
 * (`consolidationDue`), and works the queue one consolidation at a time:
 * one `memory_consolidate` side call on the system agent's backend, model
 * and reasoning effort (EO-578), made on its own — no `insideRunId` — so it takes a global concurrency slot
 * and holds it while it runs (invariant 10). Nothing here is on a
 * dispatch's path: a dispatch never waits on it and never fails for it.
 *
 * And it never takes the slot from pipeline work (EO-577): a
 * consolidation, and each batch of one, starts only while the pipeline
 * is idle (`pipelineBusy`), each call is cut off at a minute and a half
 * or its output-token cap, a scope that keeps failing backs off an hour,
 * then four, then a day, and the third failure in a row is said in a
 * message.
 */
export interface MemoryConsolidatorOptions {
  db: Db;
  sideCall: SideCaller["sideCall"];
  /** The caps, read on every look so a settings change applies to the next one. */
  caps: () => MemoryCaps;
  now?: () => number;
  /** Whether a consolidation may start now — false while the engine is paused or stopping. Absent is "yes". */
  canStart?: () => boolean;
  /**
   * Whether pipeline work is waiting or going (EO-577): an item that may
   * be dispatched, or a run that is active. While it is, no consolidation
   * starts, no batch of one starts, and no call of one takes the slot —
   * it gives way, and is taken up once the pipeline is idle. Absent is
   * "never".
   */
  pipelineBusy?: () => boolean;
  /**
   * What consolidation runs on: the system agent's backend, model and
   * reasoning effort, with its consolidation override laid over the last
   * two (`systemAgentSetup`, EO-578). Read for every call — each batch,
   * the cross-batch pass's, and the skill proposal call after a run — so
   * a change to the agent applies to the next one. Null where there is no
   * enabled system agent, which fails the consolidation and backs it off
   * like any other failure.
   */
  systemAgent?: () => SystemAgentSetup | null;
  /** A workspace's CLAUDE.md and AGENTS.md as they are on disk. A seam for tests. */
  repositoryFiles?: (scope: MemoryScope) => RepositoryFile[];
  /** How often every scope is looked at. */
  intervalMs?: number;
  /**
   * Sends the message saying a scope's consolidation is stuck (EO-727):
   * `ItemRecord.sendMessage`, so on the organisation's record one about a
   * project it holds goes to each admin. Absent is this database's own
   * table, to this machine's person.
   */
  sendMessage?: (input: MessageSend) => Promise<MessageSendAnswer>;
  /**
   * Whether a project's memory is consolidated somewhere else (EO-482): a
   * project an organisation's record holds, seen from a desktop holding a
   * replica of it. Consolidation runs where the record schedules work, so
   * such a scope is never looked at here. Absent is "nowhere else".
   */
  heldElsewhere?: (projectId: string) => boolean;
  /**
   * Whether this process is an organisation's record, which holds the
   * memory of its projects' workspaces without the workspaces — those are
   * paths on the desktops that work in them (EO-482). Such a scope is then
   * placed by the project its entries say they are of. Absent, a
   * workspace with no row here is one that is gone.
   */
  workspacesElsewhere?: boolean;
  /**
   * For each entry, the others most like it, best first — what batches
   * are grouped by (EO-574). A seam for tests; absent is the full-text
   * index (`similarMemoryNeighbours`). Null, or throwing, groups by age.
   */
  neighbours?: (scope: MemoryScope, entries: readonly MemoryEntryView[]) => EntryNeighbours | null;
  /**
   * A scope's consolidation was queued, started or finished (EO-589): what
   * `pending` answers for it changed, and so may its history. Never
   * throws into the consolidator.
   */
  onPendingChanged?: (scope: MemoryScope) => void;
}

export interface MemoryConsolidator {
  /** Closes what a stopped process left running, looks once, and keeps looking on the interval. */
  start: () => void;
  stop: () => void;
  /** Looks at every scope and queues the due ones. Answers with what is queued now. */
  check: () => { scope: MemoryScope; trigger: MemoryConsolidationTrigger }[];
  /**
   * A person asking for one scope to be consolidated now (EO-589): queued
   * with the trigger `manual`, whether or not `consolidationDue` would say
   * it is due and however it is backing off. Everything else holds — one
   * per scope queued or running, one at a time, only while the pipeline
   * is idle, never while the engine is paused (`canStart`) — and it runs
   * as any other does, on the same rows. Answers with what happened.
   */
  requestNow: (scope: MemoryScope) => MemoryConsolidateNowResult;
  /** Whether a consolidation of the scope is queued or running here now, or neither (EO-589). */
  pending: (scope: MemoryScope) => "queued" | "running" | null;
  /** Something changed that may have made a scope due: look, and work the queue. */
  poke: () => void;
  /** Resolves when the queue is empty and nothing is running. */
  idle: () => Promise<void>;
  /**
   * Stops the consolidation that is running, if one is, and gives back
   * the slot its side call holds — what pausing the engine asks (EO-514).
   * `canStart` already keeps a new one from starting; this is the one
   * already going. It changes nothing and is recorded as `paused`, and
   * the scope is asked again once the engine is resumed.
   */
  abortRunning: () => void;
}

const DEFAULT_INTERVAL_MS = 60_000;
/** The most of a workspace's CLAUDE.md or AGENTS.md a consolidation is given. */
const REPOSITORY_FILE_MAX_CHARS = 30_000;
const REPOSITORY_FILE_NAMES = ["CLAUDE.md", "AGENTS.md"] as const;

const keyOf = (scope: MemoryScope) => `${scope.kind}:${scope.id}`;

/** The source of the message saying a scope's consolidation is stuck (EO-727); its subject is the scope's key. */
export const CONSOLIDATION_STUCK_SOURCE = "consolidation_stuck";

const PAUSED_NOTE = "EO was paused while this consolidation ran, so it was stopped and changed nothing. It is asked again once EO is resumed.";
const PAUSED_BETWEEN_NOTE = "EO was paused before this batch of the consolidation started, so it changed nothing; the batches before it stay applied. It is asked again once EO is resumed.";
/**
 * What a `container_done` whose container's work resumed says (EO-596):
 * nothing was changed, and the memory stays until the work ends again.
 */
function containerReopenedNote(label: string, afterEarlierBatches: boolean): string {
  return (
    `Work under ${label} is no longer finished — an item under it was reopened, or a new one filed — so nothing was changed${afterEarlierBatches ? " by this batch; the batches before it stay applied" : ""}. ` +
    "Its memory stays in use, and ends once every item under it is finished again."
  );
}

const DEFERRED_NOTE =
  "Pipeline work was waiting for the global slot when this part of the consolidation was to start, so it gave way and changed nothing; anything before it stays applied. It is taken up again once nothing is waiting to be dispatched and no run is going.";

/** What a consolidation's side calls are asked with; the purpose, backend, limits, signal and giving way are the consolidator's. */
type ConsolidationCall<T> = Omit<SideCallRequest<T>, "purpose" | "backend" | "model" | "timeoutMs" | "maxOutputTokens" | "signal" | "giveWay" | "onSlotHeld">;

/** No side call was made: there is no enabled system agent, whose backend consolidation runs on. */
const NO_SYSTEM_AGENT = Symbol("no system agent");
/** No side call was made: pipeline work was waiting for the slot it would have taken (EO-577). */
const GAVE_WAY = Symbol("gave way");

/** An answer that changes nothing: a cross-batch pass that found no candidates. */
const NO_OPERATIONS: MemoryConsolidationOperations = { retire: [], merge: [], rewrite: [] };

type Applied = Extract<ApplyConsolidationResult, { ok: true }>;

/**
 * A scope part-way through being consolidated in batches (EO-574): the
 * entries its batches so far were given or wrote, which a retry leaves
 * to the cross-batch pass rather than batching again, and how many
 * batches succeeded. Held in memory: after a restart a scope's sequence
 * starts again from its entries as they are.
 */
interface Sequence {
  done: Set<string>;
  /**
   * The entries its consolidations wrote by folding two or more into one,
   * or by rewriting one that was (EO-575): what the skills proposed after
   * it may cite without saying whether only the procedure is in them, so
   * applying a skill leaves them in memory (`coveringEntries`).
   */
  folded: Set<string>;
  batches: number;
  /** When a batch of it last succeeded. */
  at: number;
}

/**
 * How long an unfinished sequence is taken up where it stopped. Longer
 * than any backoff, so a retry finds it; past it, or once the scope's
 * last consolidation is not the failure that stopped it, a consolidation
 * starts again from every entry, so none is left out of the batches for
 * good because a sequence nobody finished once had it.
 */
const SEQUENCE_KEPT_MS = 2 * MEMORY_CONSOLIDATION_INTERVAL_MS;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The backend a consolidation runs on, and the model and reasoning effort it asks for there. */
export interface SystemAgentSetup extends SideCallModelChoice {
  backend: string;
}

/**
 * What consolidation runs on (EO-578): the system agent — the first
 * enabled agent holding the role, by the rule interpretation and
 * Discussions use (EO-181) — its backend, and its model and reasoning
 * effort, each replaced by its consolidation override where that is set
 * (`sideCallModelOfSystemAgent`). Null where there is no such agent.
 */
export function systemAgentSetup(db: Db): SystemAgentSetup | null {
  const agent = listAgents(db).find((candidate) => candidate.role === "system" && isDispatchable(candidate));
  if (!agent) return null;
  const own = { model: agent.model, reasoningEffort: agentReasoningEffort(agent) };
  return { backend: agent.provider, ...sideCallModelOfSystemAgent(own, agent.config) };
}

/** The folder a workspace keeps on disk, where it has one. */
function workspaceFolder(db: Db, workspaceId: string): string | null {
  const workspace = getWorkspace(db, workspaceId as Uuid);
  return asGitWorkspace(workspace)?.config.repoPath ?? asFolderWorkspace(workspace)?.config.path ?? null;
}

/**
 * A workspace's own CLAUDE.md and AGENTS.md, whichever are present at its
 * root. Read only: consolidation never edits them.
 *
 * A project's are its workspaces' (EO-514). A project entry is read on
 * every run in each of them, so one that contradicts a workspace's file
 * is as wrong there as a workspace entry would be — and leaving the
 * project out meant it was never flagged. Each file is named with its
 * workspace, and a project's files share the room one workspace's are
 * given, so a project with many repositories does not crowd out its
 * entries. On an organisation's record a project's workspaces are paths
 * on the desktops that work in them, so there is nothing here to read
 * and none is given.
 */
export function readRepositoryFiles(db: Db, scope: MemoryScope): RepositoryFile[] {
  if (scope.kind === "workspace") return filesIn(workspaceFolder(db, scope.id), REPOSITORY_FILE_MAX_CHARS);
  // A container's are its project's (EO-596): its entries are read on runs
  // in the project's workspaces, as the project's are.
  const projectId = scope.kind === "container" ? memoryScopeProjectId(db, scope) : scope.id;
  if (projectId === null) return [];
  const workspaces = projectWorkspaceList(db, projectId as Uuid).flatMap((workspace) => {
    const folder = workspaceFolder(db, workspace.id);
    return folder === null ? [] : [{ label: workspaceLabel(workspace), folder }];
  });
  if (workspaces.length === 0) return [];
  const share = Math.floor(REPOSITORY_FILE_MAX_CHARS / workspaces.length);
  return workspaces.flatMap(({ label, folder }) => filesIn(folder, share).map((file) => ({ ...file, workspace: label })));
}

/** The CLAUDE.md and AGENTS.md at a folder's root, each cut to `maxChars`. */
function filesIn(folder: string | null, maxChars: number): RepositoryFile[] {
  if (!folder) return [];
  return REPOSITORY_FILE_NAMES.flatMap((name) => {
    try {
      const text = readFileSync(join(folder, name), "utf8");
      return [{ name, text: text.slice(0, maxChars), truncated: text.length > maxChars }];
    } catch {
      return [];
    }
  });
}

/**
 * What the scope is called in a consolidation's input, and the project its
 * cost is recorded against — or null when the project or workspace is
 * gone. Its entries stay, retired or not, but nothing new can be written
 * to a scope that no longer exists, so it is never consolidated.
 */
function scopeFacts(db: Db, scope: MemoryScope, workspacesElsewhere = false): { label: string; projectId: Uuid | null } | null {
  if (scope.kind === "project") {
    const project = getProject(db, scope.id as Uuid);
    return project ? { label: `the project "${project.name}"`, projectId: project.id as Uuid } : null;
  }
  if (scope.kind === "container") {
    // A container item on a project (EO-596); one deleted, or on no
    // project, has nowhere for what outlasts it to go.
    const container = containerOfScope(db, scope.id);
    if (container === null || container.projectId === null) return null;
    return { label: `the container ${container.key} ${JSON.stringify(container.title)}`, projectId: container.projectId };
  }
  const workspace = getWorkspace(db, scope.id as Uuid);
  if (workspace) return { label: `the workspace "${workspaceLabel(workspace)}"`, projectId: (workspace.projectId as Uuid | null) ?? null };
  if (!workspacesElsewhere) return null;
  // A workspace of a project an organisation's record holds, on that
  // record (EO-482): the workspace is a path on the desktops that work in
  // it and never arrives here, but its memory does, and is consolidated
  // here, by the project its entries say they are of.
  const projectId = memoryScopeProjectId(db, scope);
  const project = projectId === null ? undefined : getProject(db, projectId as Uuid);
  return project ? { label: `a workspace of the project "${project.name}"`, projectId: project.id as Uuid } : null;
}

/**
 * The skills a consolidation of `scope` may propose an improvement to:
 * live ones in that scope, and global ones (EO-483).
 */
function existingSkills(db: Db, scope: MemoryScope): ExistingSkill[] {
  return listSkills(db).flatMap((skill) => {
    if (skill.scope.kind === "global") return [{ id: skill.id, slug: skill.slug, description: skill.description, scopeLabel: "global", body: skill.body }];
    const here = skill.scope.kind === "project" ? scope.kind === "project" && skill.scope.projectId === scope.id : scope.kind === "workspace" && skill.scope.workspaceId === scope.id;
    return here ? [{ id: skill.id, slug: skill.slug, description: skill.description, scopeLabel: `this ${scope.kind}`, body: skill.body }] : [];
  });
}

export function createMemoryConsolidator(options: MemoryConsolidatorOptions): MemoryConsolidator {
  const { db } = options;
  const now = options.now ?? Date.now;
  const systemAgent = options.systemAgent ?? (() => systemAgentSetup(db));
  const repositoryFiles = options.repositoryFiles ?? ((scope: MemoryScope) => readRepositoryFiles(db, scope));
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sendMessage = options.sendMessage ?? ((input: MessageSend): Promise<MessageSendAnswer> => Promise.resolve({ ok: true, messages: [sendMessageHere(db, input)] }));
  /** Whether pipeline work is waiting or going; a question that cannot be answered is "yes", so consolidation waits rather than takes the slot. */
  const pipelineBusy = (): boolean => {
    try {
      return options.pipelineBusy?.() ?? false;
    } catch (error) {
      console.warn(`[eo] whether the pipeline is idle could not be read, so memory consolidation waits: ${messageOf(error)}`);
      return true;
    }
  };
  /** Says a scope's place in the queue changed (`onPendingChanged`); never throws. */
  const pendingChanged = (scope: MemoryScope): void => {
    try {
      options.onPendingChanged?.(scope);
    } catch (error) {
      console.warn(`[eo] a memory consolidation's progress could not be announced: ${messageOf(error)}`);
    }
  };
  /** Due scopes, in the order they became due. One entry per scope: at most one consolidation per scope is queued or running. */
  const queue = new Map<string, { scope: MemoryScope; trigger: MemoryConsolidationTrigger }>();
  /** Scopes whose batches have not all run yet, by key (EO-574). */
  const sequences = new Map<string, Sequence>();
  let running: Promise<void> | null = null;
  /**
   * Whether the queue is being worked, cleared the moment the loop ends —
   * unlike `running`, which is cleared a turn later, so a request made
   * right after a look that found nothing to do is not mistaken for one
   * waiting behind work (EO-589).
   */
  let draining = false;
  /** The scope the running consolidation is of, by key (EO-589). */
  let runningKey: string | null = null;
  /** The running consolidation's way to stop its side call (`abortRunning`). */
  let current: AbortController | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let soon: ReturnType<typeof setTimeout> | undefined;
  /** Stops listening for moves (EO-596). */
  let stopWatchingMoves: (() => void) | undefined;
  let stopped = true;

  function check(): { scope: MemoryScope; trigger: MemoryConsolidationTrigger }[] {
    const caps = options.caps();
    const at = now();
    for (const tally of scopeTallies(db)) {
      const key = keyOf(tally.scope);
      if (queue.has(key)) continue;
      const facts = scopeFacts(db, tally.scope, options.workspacesElsewhere);
      if (facts === null) continue;
      if (facts.projectId !== null && options.heldElsewhere?.(facts.projectId) === true) continue;
      const state = consolidationState(db, tally.scope);
      // A container whose work has finished (EO-596): its memory ends,
      // once, before anything else is asked of it.
      if (
        tally.scope.kind === "container" &&
        containerDoneDue({
          tally,
          state,
          finishedAt: containerWorkFinishedAt(db, tally.scope.id),
          restoredAt: lastRestoredAt(db, tally.scope, "container_done"),
          now: at,
        })
      ) {
        queue.set(key, { scope: tally.scope, trigger: "container_done" });
        pendingChanged(tally.scope);
        continue;
      }
      const decision = consolidationDue({
        tally,
        state,
        caps,
        now: at,
        runsDeliveredSince: (since) => runsDeliveredFromScopeSince(db, tally.scope, since),
      });
      if (decision.kind === "consolidate") {
        queue.set(key, { scope: tally.scope, trigger: decision.trigger });
        pendingChanged(tally.scope);
      }
      else if (decision.kind === "skip") recordSkippedConsolidation(db, { scope: tally.scope, trigger: "cap", note: decision.note, now: at, caps });
    }
    return [...queue.values()];
  }

  /** Whether a scope's project is consolidated somewhere else, read fresh (EO-482). */
  function heldElsewhereNow(scope: MemoryScope): boolean {
    const facts = scopeFacts(db, scope, options.workspacesElsewhere);
    return facts !== null && facts.projectId !== null && options.heldElsewhere?.(facts.projectId) === true;
  }

  /** The scope's active entries an agent wrote: what a consolidation may be given. People's are never sent, and never retired by it. */
  function agentEntries(scope: MemoryScope): MemoryEntryView[] {
    return activeMemoriesIn(db, [scope]).filter((entry) => entry.source.type !== "person");
  }

  function tallyOf(scope: MemoryScope): ScopeTally | undefined {
    return scopeTallies(db).find((candidate) => keyOf(candidate.scope) === keyOf(scope));
  }

  /** For each entry, the others most like it by the full-text index (EO-545), or null where it cannot be asked — then batches go by age. */
  function neighboursOf(scope: MemoryScope, entries: readonly MemoryEntryView[]): EntryNeighbours | null {
    try {
      return options.neighbours ? options.neighbours(scope, entries) : similarMemoryNeighbours(db, entries, CONSOLIDATION_BATCH_LIMITS.maxEntries);
    } catch (error) {
      console.warn(`[eo] memory entries were batched by age, not likeness: ${messageOf(error)}`);
      return null;
    }
  }

  /**
   * A scope consolidated, start to finish: in one call where its agents'
   * entries fit one batch, and otherwise in batches, one call each, and
   * then the cross-batch pass (EO-574). Never throws; whatever went wrong
   * is on its row.
   *
   * Each batch is its own consolidation, applied on its own as soon as
   * its answer comes back, so a later one failing leaves it in place. A
   * failure ends the sequence there: its row backs the scope off, and the
   * retry takes up the entries no batch of this sequence has had yet
   * (`sequences`, for `SEQUENCE_KEPT_MS`), leaving those that had them to
   * the cross-batch pass.
   * A scope queued because it reached a cap stops as soon as it is under
   * its caps again, with or without the pass.
   *
   * What a run is given is read when it starts, before its first side
   * call waits for its slot. Entries written after that — an agent's note
   * while a call waited or ran — are not in its batches and are left as
   * they are; every row of the run has `started_at` at that moment, so
   * the next look counts them as a change and, if they took the scope
   * back to a cap, queues the next one. The cross-batch pass reads the
   * entries again, but stays on the run's moment for the same reason: it
   * sees a newer entry's first line only.
   *
   * Before any call, agents' entries that repeat another word for word are
   * folded with no model at all (EO-576, `foldExactDuplicates`): one
   * consolidation of its own, which a restore undoes like any other. A
   * scope queued for its cap that this alone brings under its caps asks
   * nothing more. Of what is left, those likely to say the same thing
   * (`nearDuplicateGroups`) share a batch and are marked as such in its
   * input, so the model's call about them is cheap.
   *
   * Once the run has succeeded — every batch it made applied, and the
   * cross-batch pass too where there was one, or the scope back under its
   * caps before them — one more call asks for skill proposals over the
   * scope as it now is (EO-575, `proposeSkills`). A run that failed or
   * stopped part-way asks for none: its retry will.
   */
  async function consolidate(scope: MemoryScope, trigger: MemoryConsolidationTrigger): Promise<void> {
    const key = keyOf(scope);
    const caps = options.caps();
    // The moment this run reads what it is given: every row it writes,
    // each batch's and the cross-batch pass's, starts then, so a write by
    // anyone else during any of them is a change since the scope was
    // settled, and the next look takes the scope up again if it is still
    // over a cap — though a later batch's row finished after it.
    const readAt = now();
    const read = agentEntries(scope);
    const facts = scopeFacts(db, scope, options.workspacesElsewhere);
    if (!facts || read.length === 0) {
      sequences.delete(key);
      return;
    }
    // Queued before its project was handed to a record (EO-482): the
    // record consolidates it now, and nothing here may touch the replica.
    if (heldElsewhereNow(scope)) return;
    if (trigger === "container_done") return finishContainer(scope, facts, caps, readAt, read);
    const kept = sequences.get(key);
    const resumes = kept !== undefined && now() - kept.at <= SEQUENCE_KEPT_MS && consolidationState(db, scope).failuresSince.length > 0;
    const sequence = resumes ? kept : { done: new Set<string>(), folded: new Set<string>(), batches: 0, at: now() };
    sequences.set(key, sequence);
    /** This run's last consolidation to succeed: what the skills proposed after it are posted under. */
    let last: Applied | null = null;
    const succeeded = async () => {
      sequences.delete(key);
      // A skill is the project's, a workspace's or everyone's; a
      // container's memory ends with its work (EO-596), so none is
      // proposed from it.
      if (last !== null && scope.kind !== "container") await proposeSkills(scope, facts, last.consolidation.id, [...sequence.folded]);
    };
    const record = (applied: Applied) => {
      last = applied;
      // In the order written, so a rewrite of an entry an earlier batch
      // folded, or the cross-batch pass merging two, is folded too.
      for (const written of applied.written) {
        if (written.from.length > 1 || written.from.some((id) => sequence.folded.has(id))) sequence.folded.add(written.id);
      }
    };

    // Word-for-word duplicates, folded before anything is asked (EO-576).
    let entries = read;
    const duplicates = exactDuplicates(read);
    if (duplicates.length > 0) {
      const folded = await foldExactDuplicates(scope, trigger, caps, readAt, duplicates);
      if (folded === null) return;
      record(folded);
      const gone = new Set(folded.consolidation.retiredIds);
      entries = read.filter((entry) => !gone.has(entry.id));
      const next = mayContinue(scope, trigger, caps, readAt);
      if (next === "done") return succeeded();
      if (next !== "continue") return;
    }

    const pending = entries.filter((entry) => !sequence.done.has(entry.id));
    const neighbours = pending.length > 1 ? neighboursOf(scope, pending) : null;
    // Likely duplicates, by the full-text index: each set shares a batch, marked in its input.
    const alike = nearDuplicateGroups(pending, neighbours);
    const likelyDuplicates = likelyDuplicatesOf(alike);
    const fitsOne = pending.length <= CONSOLIDATION_BATCH_LIMITS.maxEntries && pending.reduce((sum, entry) => sum + entry.body.length, 0) <= CONSOLIDATION_BATCH_LIMITS.maxChars;
    const plan = fitsOne ? (pending.length === 0 ? [] : [pending]) : planBatches(pending, neighbours, CONSOLIDATION_BATCH_LIMITS, alike);
    const batched = plan.length > 1 || sequence.batches > 0;

    for (const [at, batch] of plan.entries()) {
      if (at > 0) {
        const next = mayContinue(scope, trigger, caps, readAt);
        if (next === "done") return succeeded();
        if (next !== "continue") return;
      }
      const applied = await consolidateBatch(scope, trigger, facts, caps, readAt, batch, batched ? { index: at + 1, count: plan.length } : undefined, likelyDuplicates);
      if (applied === null) return;
      record(applied);
      sequence.batches += 1;
      sequence.at = now();
      for (const entry of batch) sequence.done.add(entry.id);
      for (const written of applied.written) sequence.done.add(written.id);
    }

    if (sequence.batches > 1) {
      const next = mayContinue(scope, trigger, caps, readAt);
      if (next === "done") return succeeded();
      if (next !== "continue") return;
      const passed = await crossBatchPass(scope, trigger, facts, caps, readAt);
      if (passed === null) return;
      if (passed !== "nothing") record(passed);
    }
    return succeeded();
  }

  /**
   * Whether the next call of a sequence runs (EO-574): not once EO is
   * stopping, nor for a project handed to a record meanwhile, nor while
   * the engine is paused — which is recorded as the next batch stopped by
   * pausing, so the scope is asked again once it is resumed — nor while
   * pipeline work is waiting or going (EO-577), recorded as the next
   * batch deferred, so it is taken up again once the pipeline is idle. A
   * scope queued for its cap that is under its caps again is done.
   */
  function mayContinue(scope: MemoryScope, trigger: MemoryConsolidationTrigger, caps: MemoryCaps, readAt: number): "continue" | "stop" | "done" {
    if (stopped || heldElsewhereNow(scope)) return "stop";
    if (!(options.canStart?.() ?? true)) {
      const row = startConsolidation(db, { scope, trigger, now: readAt });
      failConsolidation(db, row.id, { reason: CONSOLIDATION_PAUSED_REASON, note: PAUSED_BETWEEN_NOTE, now: now() });
      return "stop";
    }
    const tally = tallyOf(scope);
    if (trigger === "cap" && (tally === undefined || !reachesCap(tally, caps))) return "done";
    if (pipelineBusy()) {
      const row = startConsolidation(db, { scope, trigger, now: readAt });
      failConsolidation(db, row.id, { reason: CONSOLIDATION_DEFERRED_REASON, note: DEFERRED_NOTE, now: now() });
      return "stop";
    }
    return "continue";
  }

  /**
   * One side call of a consolidation, on its row: the answer, or null
   * with the row failed — by the backend, by its schema, or by pausing
   * EO (EO-514), when nothing it answered is applied and the failure says
   * why rather than reading as the backend's.
   */
  async function ask<T>(rowId: string, controller: AbortController, request: ConsolidationCall<T>): Promise<T | null> {
    const answer = await sideCallOf(rowId, controller, request);
    if (answer === GAVE_WAY) {
      failConsolidation(db, rowId, { reason: CONSOLIDATION_DEFERRED_REASON, note: DEFERRED_NOTE, now: now() });
      return null;
    }
    if (answer === NO_SYSTEM_AGENT) {
      failConsolidation(db, rowId, { reason: "error", note: "There is no enabled system agent, whose backend consolidation runs on, so nothing was changed.", now: now() });
      return null;
    }
    if (controller.signal.aborted) {
      failConsolidation(db, rowId, { reason: CONSOLIDATION_PAUSED_REASON, note: PAUSED_NOTE, now: now() });
      return null;
    }
    if (!answer.ok) {
      failConsolidation(db, rowId, { reason: answer.reason, note: answer.message, now: now() });
      return null;
    }
    return answer.value;
  }

  /**
   * One side call of consolidation's — a consolidation's own, or the skill
   * proposal call after one (EO-575) — on the system agent's backend,
   * model and reasoning effort, or its consolidation override (EO-578), or
   * `NO_SYSTEM_AGENT` with no call made where there is none.
   *
   * Held to a minute and a half and an output-token cap (EO-577), and
   * giving way to pipeline work at the moment it would take the slot:
   * `GAVE_WAY`, with no call made. The time it held the slot is added to
   * the consolidation `rowId` names.
   */
  async function sideCallOf<T>(rowId: string, controller: AbortController, request: ConsolidationCall<T>): Promise<SideCallResult<T> | typeof NO_SYSTEM_AGENT | typeof GAVE_WAY> {
    const system = systemAgent();
    if (system === null) return NO_SYSTEM_AGENT;
    let gaveWay = false;
    const answer = await options.sideCall({
      ...request,
      purpose: "memory_consolidate",
      backend: system.backend,
      model: { model: system.model, reasoningEffort: system.reasoningEffort },
      timeoutMs: MEMORY_CONSOLIDATE_TIMEOUT_MS,
      maxOutputTokens: MEMORY_CONSOLIDATE_MAX_OUTPUT_TOKENS,
      signal: controller.signal,
      giveWay: () => {
        gaveWay = pipelineBusy();
        return gaveWay;
      },
      onSlotHeld: (ms) => {
        try {
          addConsolidationSlotTime(db, rowId, ms);
        } catch (error) {
          console.warn(`[eo] how long a memory consolidation held its slot could not be recorded: ${messageOf(error)}`);
        }
      },
    });
    return gaveWay && !answer.ok ? GAVE_WAY : answer;
  }

  /** An answer applied as its row's consolidation, or null with the row failed. `said` is put on its row, before anything else it says. */
  function apply(
    rowId: string,
    scope: MemoryScope,
    tally: ScopeTally,
    caps: MemoryCaps,
    sent: readonly MemoryEntryView[],
    answer: MemoryConsolidationOperations,
    said: string | null = null,
    writeTo?: MemoryScope,
  ): Applied | null {
    // Asked again now, after the wait: a project handed to a record while
    // the call ran is the record's, and its answer is not applied to a
    // replica. Checked in the same synchronous stretch as the write, so
    // nothing can hand the project over in between.
    if (heldElsewhereNow(scope)) {
      failConsolidation(db, rowId, {
        reason: "changed",
        note: "This project was moved to your organisation's record while it ran, so nothing was changed here. The record consolidates its memory now.",
        now: now(),
      });
      return null;
    }
    const applied = applyConsolidation(db, {
      id: rowId,
      sent,
      answer: { retire: answer.retire, merge: answer.merge, rewrite: answer.rewrite },
      note: [said, peopleAloneOverCap(tally, caps) ? peopleOverCapNote(tally, caps) : null].filter((part) => part !== null).join(" ") || null,
      caps,
      now: now(),
      ...(writeTo === undefined ? {} : { writeTo }),
    });
    if (!applied.ok) {
      failConsolidation(db, rowId, { reason: "changed", note: applied.problem, now: now() });
      return null;
    }
    return applied;
  }

  /**
   * Runs one consolidation on its own row, started when its run read its
   * entries (`readAt`), and makes sure a failure is recorded whatever is
   * thrown.
   */
  async function onRow<T>(
    scope: MemoryScope,
    trigger: MemoryConsolidationTrigger,
    readAt: number,
    work: (rowId: string, controller: AbortController) => Promise<T | null>,
  ): Promise<T | null> {
    const row = startConsolidation(db, { scope, trigger, now: readAt });
    const controller = new AbortController();
    current = controller;
    try {
      return await work(row.id, controller);
    } catch (error) {
      try {
        failConsolidation(db, row.id, { reason: "error", note: messageOf(error), now: now() });
      } catch (recording) {
        console.warn(`[eo] a memory consolidation's failure could not be recorded: ${messageOf(recording)}`);
      }
      return null;
    } finally {
      if (current === controller) current = null;
    }
  }

  /**
   * The agents' entries that repeat another word for word (EO-576), folded
   * as one consolidation with no side call: each set keeps its newest
   * entry, and the rest are retired as `consolidated` under the row, so a
   * restore puts them back. Never a person's: they are never given here.
   */
  async function foldExactDuplicates(
    scope: MemoryScope,
    trigger: MemoryConsolidationTrigger,
    caps: MemoryCaps,
    readAt: number,
    sets: readonly ExactDuplicates<MemoryEntryView>[],
  ): Promise<Applied | null> {
    const tally = tallyOf(scope);
    if (!tally) return null;
    const retired = sets.reduce((sum, set) => sum + set.retired.length, 0);
    const said = `${retired} ${retired === 1 ? "entry that repeated another" : "entries that repeated another"} word for word ${retired === 1 ? "was" : "were"} retired without asking a model, keeping the newest of each.`;
    return onRow(scope, trigger, readAt, async (rowId) =>
      apply(rowId, scope, tally, caps, sets.flatMap((set) => [set.kept, ...set.retired]), exactDuplicateOperations(sets), said),
    );
  }

  /** One batch — or a scope's whole set, where it fits one — as one consolidation: asked and applied. */
  async function consolidateBatch(
    scope: MemoryScope,
    trigger: MemoryConsolidationTrigger,
    facts: { label: string; projectId: Uuid | null },
    caps: MemoryCaps,
    readAt: number,
    sent: readonly MemoryEntryView[],
    part: { index: number; count: number } | undefined,
    likelyDuplicates: ReadonlyMap<string, readonly string[]>,
  ): Promise<Applied | null> {
    const tally = tallyOf(scope);
    if (!tally) return null;
    return onRow(scope, trigger, readAt, async (rowId, controller) => {
      const scopeTargets = consolidationTargets(tally, caps);
      const answer = await ask(rowId, controller, {
        schema: consolidationAnswerSchema(sent),
        system: MEMORY_CONSOLIDATE_SYSTEM,
        input: consolidationInput({
          scopeLabel: facts.label,
          entries: sent,
          targets: part ? batchTargets(sent, { entries: tally.agentEntries, chars: tally.agentChars }, scopeTargets) : scopeTargets,
          ...(part ? { batch: { ...part, scopeEntries: tally.agentEntries, scopeChars: tally.agentChars } } : {}),
          repositoryFiles: repositoryFiles(scope),
          likelyDuplicates,
          now: now(),
        }),
        projectId: facts.projectId,
      });
      return answer === null ? null : apply(rowId, scope, tally, caps, sent, answer);
    });
  }

  /**
   * A container's memory, ended (EO-596): the `container_done`
   * consolidation, queued once every item filed under the container has
   * finished. The model is told the work is over and answers with the
   * facts that will still hold; each is written to the container's project
   * as a new entry, keeping the source and age of what it is drawn from,
   * and every other entry it was given is retired as `consolidated` — all
   * under the consolidation's row, so a restore puts the container's
   * entries back and retires what it wrote in the project.
   *
   * In batches where the entries do not fit one call, as any scope is, and
   * held to the same rules between them (`mayContinue`): never while EO is
   * paused or pipeline work waits, and stopping where one fails. Each batch
   * is applied on its own, so a retry finds only the entries no batch has
   * had yet — the scope's agent entries as they are — and there is no
   * cross-batch pass: nothing is left in the scope to compare, and what was
   * kept is the project's, whose own consolidation folds it with the rest.
   * Whether the work is still finished is asked again before each batch
   * starts and before each answer is applied (`containerStillFinished`):
   * an item reopened under the container while this was queued, or while a
   * call ran, makes it stale, and it is recorded as `skipped` having changed
   * nothing — no backoff, and queued again once the work finishes again.
   * No skills are proposed from it. People's entries are never sent, so
   * they stay in the container's scope as written.
   */
  async function finishContainer(scope: MemoryScope, facts: { label: string; projectId: Uuid | null }, caps: MemoryCaps, readAt: number, read: readonly MemoryEntryView[]): Promise<void> {
    if (facts.projectId === null) return;
    const project = getProject(db, facts.projectId);
    if (!project) return;
    const into: MemoryScope = { kind: "project", id: project.id };
    const neighbours = read.length > 1 ? neighboursOf(scope, read) : null;
    const alike = nearDuplicateGroups(read, neighbours);
    const fitsOne = read.length <= CONSOLIDATION_BATCH_LIMITS.maxEntries && read.reduce((sum, entry) => sum + entry.body.length, 0) <= CONSOLIDATION_BATCH_LIMITS.maxChars;
    const plan = fitsOne ? [read] : planBatches(read, neighbours, CONSOLIDATION_BATCH_LIMITS, alike);
    for (const [at, batch] of plan.entries()) {
      if (at > 0 && mayContinue(scope, "container_done", caps, readAt) !== "continue") return;
      // Before every batch, the first included: queued is not finished,
      // and an item reopened while this waited for the pipeline, or while
      // an earlier batch ran, means the container's memory is still in use.
      if (!containerStillFinished(scope)) {
        recordSkippedConsolidation(db, { scope, trigger: "container_done", note: containerReopenedNote(facts.label, at > 0), now: now(), caps });
        return;
      }
      const tally = tallyOf(scope);
      if (!tally) return;
      const part = plan.length > 1 ? { index: at + 1, count: plan.length, scopeEntries: read.length } : undefined;
      const applied = await onRow(scope, "container_done", readAt, async (rowId, controller) => {
        const answer = await ask(rowId, controller, {
          schema: containerDoneAnswerSchema(batch),
          system: MEMORY_CONTAINER_DONE_SYSTEM,
          input: containerDoneInput({ containerLabel: facts.label, projectLabel: `the project "${project.name}"`, entries: batch, ...(part ? { batch: part } : {}), now: now() }),
          projectId: facts.projectId,
        });
        if (answer === null) return null;
        // And again with the answer in hand, in the same synchronous
        // stretch as the write: work reopened while the call ran makes the
        // answer stale, and it is dropped rather than applied.
        if (!containerStillFinished(scope)) {
          skipConsolidation(db, rowId, { note: containerReopenedNote(facts.label, at > 0), now: now(), caps });
          return null;
        }
        const kept = answer.keep.length;
        const retired = batch.length - answer.keep.reduce((sum, keep) => sum + keep.from.length, 0);
        const said = `Every item filed under ${facts.label} is finished, so its memory ended: ${kept} ${kept === 1 ? "fact was" : "facts were"} kept as entries of the project "${project.name}", and ${retired} ${retired === 1 ? "entry that was" : "entries that were"} only true while the work was in progress ${retired === 1 ? "was" : "were"} retired.`;
        return apply(rowId, scope, tally, caps, batch, containerDoneOperations(batch, answer), said, into);
      });
      if (applied === null) return;
    }
  }

  /**
   * Whether a container's work is still finished, as it was when its
   * `container_done` was queued (EO-596): every item under it terminal, and
   * no person's restore of one since. Asked again before each batch starts
   * and before each answer is applied, because the queue holds a scope as
   * it was when it was looked at, and work can resume under a container at
   * any moment — a rejection reopens an item, an item is filed under it.
   */
  function containerStillFinished(scope: MemoryScope): boolean {
    const finishedAt = containerWorkFinishedAt(db, scope.id);
    if (finishedAt === null) return false;
    const restoredAt = lastRestoredAt(db, scope, "container_done");
    return restoredAt === null || restoredAt < finishedAt;
  }

  /**
   * The cross-batch pass (EO-574), as one consolidation: duplicates that
   * fell into different batches. Its first call is shown only each
   * remaining entry's id and first line and answers with groups that may
   * be duplicates; its second is given those groups' full bodies — as
   * many as fit one batch — and answers with operations, applied as any
   * batch's are. No candidates is a consolidation that changed nothing.
   * Its consolidation when it succeeded, `"nothing"` when there were too
   * few entries to ask about, and null when it failed.
   */
  async function crossBatchPass(
    scope: MemoryScope,
    trigger: MemoryConsolidationTrigger,
    facts: { label: string; projectId: Uuid | null },
    caps: MemoryCaps,
    readAt: number,
  ): Promise<Applied | "nothing" | null> {
    const tally = tallyOf(scope);
    const entries = agentEntries(scope);
    if (!tally || entries.length < 2) return "nothing";
    return onRow(scope, trigger, readAt, async (rowId, controller) => {
      const candidates = await ask(rowId, controller, {
        schema: mergeCandidatesSchema(entries),
        system: MEMORY_MERGE_CANDIDATES_SYSTEM,
        input: mergeCandidatesInput({ scopeLabel: facts.label, entries }),
        projectId: facts.projectId,
      });
      if (candidates === null) return null;
      const groups = pickCandidateGroups(candidates.groups, entries);
      if (groups.length === 0) return apply(rowId, scope, tally, caps, [], NO_OPERATIONS);
      const sent = groups.flat();
      const answer = await ask(rowId, controller, {
        schema: consolidationAnswerSchema(sent),
        system: MEMORY_CROSS_BATCH_MERGE_SYSTEM,
        input: crossBatchMergeInput({ scopeLabel: facts.label, groups, now: now() }),
        projectId: facts.projectId,
      });
      return answer === null ? null : apply(rowId, scope, tally, caps, sent, answer);
    });
  }

  /**
   * Skill proposals, asked for in a call of their own once a consolidation
   * of the scope has succeeded (EO-483, EO-575), and applied under it
   * (EO-719).
   *
   * The call is given the scope's agent-written entries as the
   * consolidation left them — never a person's — the skills a proposal may
   * improve, and every proposal a person discarded in the scope, and
   * answers with at most three proposals. The consolidation has done what
   * it was for by now and stays applied whatever happens here: a call that
   * fails, or a proposal that cannot be applied, is a sentence added to its
   * note, never its failure. An evidence entry the run's consolidations
   * folded from several (`folded`) is one applying a skill leaves in
   * memory, since it may hold other facts. Not asked once EO is
   * stopping or paused, nor for a project handed to a record meanwhile, nor
   * for a scope with no agent-written entry left to cite.
   */
  async function proposeSkills(scope: MemoryScope, facts: { label: string; projectId: Uuid | null }, consolidationId: string, folded: readonly string[]): Promise<void> {
    const say = (note: string) => {
      try {
        appendConsolidationNote(db, consolidationId, note);
      } catch (error) {
        console.warn(`[eo] a memory consolidation's note could not be written: ${messageOf(error)}`);
      }
    };
    if (stopped || heldElsewhereNow(scope)) return;
    if (!(options.canStart?.() ?? true)) {
      say("EO was paused before skills were proposed from this scope, so none were; the next consolidation asks again.");
      return;
    }
    if (pipelineBusy()) {
      say("Pipeline work was waiting when skills were to be proposed from this scope, so none were and the work went first; the next consolidation asks again.");
      return;
    }
    const controller = new AbortController();
    current = controller;
    try {
      const entries = agentEntries(scope);
      if (entries.length === 0) return;
      // What an improvement's target slug means is what the call was shown.
      const shown = existingSkills(db, scope);
      const answer = await sideCallOf(consolidationId, controller, {
        schema: skillProposalsAnswerSchema(entries, {
          scope,
          sourceItems: new Map(entries.map((entry) => [entry.id, entry.source.type === "run" ? entry.source.itemId : null])),
        }),
        system: MEMORY_PROPOSE_SKILLS_SYSTEM,
        input: skillProposalsInput({
          scopeLabel: facts.label,
          scope,
          entries,
          skills: shown,
          discarded: discardedSkillProposals(db, scope),
          now: now(),
        }),
        projectId: facts.projectId,
      });
      if (answer === NO_SYSTEM_AGENT) return say("Skills were not proposed: there is no enabled system agent to ask.");
      if (answer === GAVE_WAY) return say("Pipeline work was waiting when skills were to be proposed from this scope, so none were and the work went first; the next consolidation asks again.");
      if (controller.signal.aborted) return say("EO was paused while skills were being proposed from this scope, so none were; the next consolidation asks again.");
      if (!answer.ok) return say(`Skills were not proposed: ${answer.message}`);
      if (answer.value.skills.length === 0) return;
      // Asked again after the wait, as applying an answer is: a project
      // handed to a record while the call ran is the record's to propose for.
      if (heldElsewhereNow(scope)) return;
      // Evidence names entries as the consolidation left them; one it
      // folded from several may hold more than the procedure, and applying it
      // leaves it in memory rather than lose what else it says.
      const posted = applySkillProposals({
        db,
        consolidationId,
        scope,
        proposals: answer.value.skills,
        folded,
        // Only those the call was shown: one past the cap, or made while it
        // ran, is not a target its draft was written for.
        shown: new Map(shown.slice(0, EXISTING_SKILLS_MAX).map((skill) => [skill.slug, skill.id])),
        now: now(),
      });
      if (posted.notes.length > 0) say(posted.notes.join(" "));
    } catch (error) {
      console.warn(`[eo] skills were not proposed after a memory consolidation: ${messageOf(error)}`);
    } finally {
      if (current === controller) current = null;
    }
  }

  /**
   * Says, once, that a scope's consolidation is stuck (EO-577, EO-727):
   * at its third failure in a row, a message to the project's person — on
   * the organisation's record, each admin — naming the scope, what it
   * holds against its caps and why the last one failed. Nothing waits on
   * it; the scope keeps working as it is. Marked on the failure it was
   * said at, so the same run of failures is not said again, and only once
   * the message is written: one that could not be sent is tried again at
   * the next failure. Its subject is the scope, and once the run of
   * failures has ended — a later consolidation of the scope succeeded —
   * EO marks it resolved. Never throws.
   */
  async function noticeIfStuck(scope: MemoryScope): Promise<void> {
    try {
      const state = consolidationState(db, scope);
      if (state.failuresSince.length === 0) {
        resolveMessagesAbout(db, CONSOLIDATION_STUCK_SOURCE, keyOf(scope), now());
        return;
      }
      const owed = stuckNoticeOwed(state);
      if (owed === null) return;
      const facts = scopeFacts(db, scope, options.workspacesElsewhere);
      const tally = tallyOf(scope);
      if (facts === null || tally === undefined || heldElsewhereNow(scope)) return;
      const body = stuckNoticeBody({ scopeLabel: facts.label, tally, caps: options.caps(), failures: consecutiveFailures(state).length, last: owed, retryAt: retryAt(state) });
      const sent = await sendMessage({ recipientId: LOCAL_PERSON_ID, projectId: facts.projectId, source: CONSOLIDATION_STUCK_SOURCE, subject: keyOf(scope), body });
      if (!sent.ok) {
        // Not marked: the next failure tries again.
        appendConsolidationNote(db, owed.id, `Consolidation of this scope is stuck, and the message saying so could not be sent: ${sent.problem}`);
        return;
      }
      markConsolidationStuckNoticed(db, owed.id, now());
    } catch (error) {
      console.warn(`[eo] that memory consolidation is stuck could not be said: ${messageOf(error)}`);
    }
  }

  /**
   * Works the queue, one at a time, for as long as it may — and never
   * while pipeline work is waiting or going (EO-577): what is queued
   * stays queued, and is worked once the pipeline is idle (`poke`, or the
   * next look).
   */
  /** Whether the queue may be worked now: something in it, EO going and not paused, and the pipeline idle. */
  function mayWork(): boolean {
    return !stopped && queue.size > 0 && (options.canStart?.() ?? true) && !pipelineBusy();
  }

  function drain(): void {
    if (draining || !mayWork()) return;
    draining = true;
    const work: Promise<void> = (async () => {
      try {
        while (mayWork()) {
          const [key, next] = queue.entries().next().value!;
          runningKey = key;
          pendingChanged(next.scope);
          try {
            await consolidate(next.scope, next.trigger);
          } finally {
            queue.delete(key);
            runningKey = null;
            pendingChanged(next.scope);
          }
          await noticeIfStuck(next.scope);
          // Looked at again at once: what was written while it ran may have
          // taken the scope back to a cap, and that is due now, not at the
          // next interval.
          if (!stopped) {
            try {
              check();
            } catch (error) {
              console.warn(`[eo] memory was not checked for consolidation: ${messageOf(error)}`);
            }
          }
        }
      } finally {
        // In the same turn as the loop's last look, so nothing asked in
        // between finds the queue claimed by a loop that has ended.
        draining = false;
      }
    })()
      .catch((error: unknown) => console.warn(`[eo] memory consolidation stopped: ${messageOf(error)}`))
      .finally(() => {
        if (running === work) running = null;
      });
    running = work;
  }

  function requestNow(scope: MemoryScope): MemoryConsolidateNowResult {
    const key = keyOf(scope);
    if (stopped) return { outcome: "refused", reason: "unavailable", message: "EO is stopping, so no consolidation was queued." };
    const facts = scopeFacts(db, scope, options.workspacesElsewhere);
    if (facts === null) return { outcome: "refused", reason: "unknown_scope", message: `No ${scope.kind} has the id "${scope.id}", so there is nothing to consolidate.` };
    const label = facts.label;
    const Label = label.charAt(0).toUpperCase() + label.slice(1);
    // Consolidated where the record schedules work (EO-482); routing the
    // request there is not this desktop's to do.
    if (heldElsewhereNow(scope)) {
      return {
        outcome: "refused",
        reason: "held_by_record",
        message: `${Label} is of a project your organisation's record holds. The record consolidates its memory, and this desktop leaves it alone.`,
      };
    }
    if (!(options.canStart?.() ?? true)) {
      return { outcome: "refused", reason: "paused", message: "EO is paused, and no consolidation starts while it is, so none was queued. Resume EO and ask again." };
    }
    if (queue.has(key)) {
      const state = runningKey === key ? "running" : "queued";
      return { outcome: "already", state, message: `A consolidation of ${label} is already ${state}, so nothing was added.` };
    }
    if (agentEntries(scope).length === 0) {
      return {
        outcome: "refused",
        reason: "no_agent_entries",
        message: `${Label} holds no active entry an agent wrote, so there is nothing to consolidate: a person's entries are never consolidated.`,
      };
    }
    queue.set(key, { scope, trigger: "manual" });
    pendingChanged(scope);
    // Started here and now if nothing is ahead of it and the pipeline is
    // idle: `drain` takes it up before it yields.
    drain();
    if (runningKey === key) return { outcome: "started", message: `Consolidation of ${label} has started.` };
    if (pipelineBusy() || !draining) {
      return {
        outcome: "queued",
        behind: "pipeline",
        message: `Consolidation of ${label} is queued behind pipeline work. It starts once nothing is waiting to be dispatched and no run is going.`,
      };
    }
    return {
      outcome: "queued",
      behind: "consolidation",
      message: `Consolidation of ${label} is queued behind another consolidation, since they run one at a time. It starts when the one before it ends.`,
    };
  }

  /**
   * Looks soon. Off the caller's path — a dispatch that just delivered
   * memory does not wait for every scope to be looked at — and coalesced.
   */
  function poke(): void {
    if (stopped || soon) return;
    soon = setTimeout(() => {
      soon = undefined;
      look();
    }, 0);
    soon.unref?.();
  }

  /** Whether a moved item is filed under a container (EO-596). */
  function containerOfMoved(itemId: string): boolean {
    const item = getItem(db, itemId as Uuid);
    return item !== undefined && item.parentId !== null && containerOfScope(db, item.parentId) !== null;
  }

  function look(): void {
    if (stopped) return;
    try {
      check();
    } catch (error) {
      console.warn(`[eo] memory was not checked for consolidation: ${messageOf(error)}`);
      return;
    }
    drain();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      try {
        closeAbandonedConsolidations(db, now());
      } catch (error) {
        console.warn(`[eo] unfinished memory consolidations could not be closed: ${messageOf(error)}`);
      }
      timer = setInterval(look, intervalMs);
      timer.unref?.();
      // An item filed under something moved (EO-596): it may have been
      // the last under a container to finish, and that container's memory
      // is due to end now, not at the next look. Whether it is, is the
      // look's to say.
      stopWatchingMoves = onTransitionApplied(db, (transition) => {
        try {
          if (containerOfMoved(transition.itemId)) poke();
        } catch (error) {
          console.warn(`[eo] a move was not looked at for memory consolidation: ${messageOf(error)}`);
        }
      });
      look();
    },
    stop() {
      stopped = true;
      stopWatchingMoves?.();
      stopWatchingMoves = undefined;
      if (timer) clearInterval(timer);
      if (soon) clearTimeout(soon);
      timer = undefined;
      soon = undefined;
      queue.clear();
    },
    check,
    requestNow,
    pending(scope) {
      const key = keyOf(scope);
      if (runningKey === key) return "running";
      return queue.has(key) ? "queued" : null;
    },
    poke,
    async idle() {
      while (running) await running;
    },
    abortRunning() {
      current?.abort();
    },
  };
}
