import {
  LOCAL_PERSON_ID,
  uuidv7,
  type RecordAdoptCounts,
  type RecordAdoptPage,
  type RecordProject,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { abandonAdoption, beginAdoption, getProject, markProjectOnTheRecord, type Project } from "../db/repos/projectsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { listActiveRuns } from "../db/repos/runsRepo.js";
import { createPerson, getPerson } from "../db/repos/peopleRepo.js";
import { markRunSynced } from "../db/repos/runsRepo.js";
import { asRecordWatch, listItemWatches } from "../db/repos/itemWatchesRepo.js";
import { enqueueWatchCommand } from "../db/repos/recordCommandsRepo.js";
import { highestRunEventSeq } from "../db/repos/runEventsRepo.js";
import { readProjectMemories } from "../db/repos/memoriesRepo.js";
import { readProjectSkills } from "../db/repos/skillsRepo.js";
import {
  adoptLocalPersonRows,
  keyCounterFor,
  readItemExtensions,
  readProjectDeps,
  projectAttachments,
  projectItemIds,
  readItemComments,
  readItemMentions,
  readItemRuns,
  readItemTransitions,
  countProjectRows,
  readProjectItemTypes,
  readProjectJobs,
  readProjectOccurrences,
  readProjectPipelines,
  readProjectAgents,
  readProjectItems,
  readRunTranscript,
  type MovedFile,
} from "../db/repos/projectMoveRepo.js";
import { asRunCommand } from "./runCommand.js";

/**
 * Moving a project to the record (EO-325,
 * `ARCHITECTURE.md`, "The record",
 * "What a person sees first", "Identity").
 *
 * The person signed in with work already on their board and chose, for
 * this project, to hand it over. What that means concretely:
 *
 *  1. **Everything on it goes up, in dependency order**, through
 *     `record:adopt` — the item types, the graphs, the items, the runs,
 *     the transcripts, the moves, the thread, the jobs and the files.
 *     Ids are preserved; the record assigns nothing but the owner, and
 *     it derives that from the device token rather than taking it from
 *     here.
 *  2. **Everything that named "you" goes up as the signed-in person.**
 *     Mentions first among them, because a mention is what puts a row
 *     in an inbox — the design's own sentence — and beside them the columns
 *     that mean the same thing: who filed an item, who it waits on, who
 *     owns a job, who waits at a human step.
 *  3. **Only when every page is accounted for** are the local rows
 *     rewritten and the project marked the record's.
 *
 * ## Nothing on this machine changes until the whole move has landed
 *
 * The first draft rewrote the local rows *before* sending anything, so
 * that what went up matched what stayed here. The review found what
 * that costs: a move that failed half way left a project that was still
 * local — still on the sheet, still the person's — with every mention,
 * assignee, creator, job owner and step owner already pointing at the
 * signed-in person. Pressing "keep" afterwards did not leave it
 * unchanged, which is the one thing the first acceptance criterion asks
 * for.
 *
 * So the rewrite is not a write at all until the end. The pages carry
 * the person *mapped on the way out* — `asPerson` below, applied to
 * the four columns and the mentions that can name the local person —
 * and the local rows are rewritten in one statement once the record has
 * confirmed everything. A failed move touches nothing: no rewrite, no
 * mark, no bookmark moved into a run. The project is exactly as it was,
 * which is the state it is safe to be left in, and the transfer is
 * idempotent by primary key so trying again is free.
 *
 * ## A page that half landed is a failed move
 *
 * Also the review's, and the sharper of the two. `RecordAdoptCounts`
 * was a report the screen displayed beside a move that had otherwise
 * succeeded — the project on the record irreversibly, three of its
 * items not, and the person handed a sentence and no way to act on it.
 * Every page is now checked against what it carried: each list's
 * accepted count must equal what was sent, and `skipped` must be empty.
 * Anything else ends the move here.
 *
 * That is also why the files travel on these pages rather than behind
 * them. They were queued for the ordinary attachment drain, which runs
 * later and on its own schedule — so a move could be finished, marked,
 * and irreversible while its attachments were still on this machine
 * only, and "a count comparison between the local database and the
 * server proves nothing was lost" could not be made at the moment it
 * was needed.
 *
 * ## Why this is not queued, and refuses when offline
 *
 * Every other thing a device does is durable the moment it is done and
 * replayed when the network comes back, because a person pressing
 * Approve must not be made to wait on a socket. A move is not that
 * shape. It is a long, ordered conversation about thousands of rows
 * whose *point* is that the far side ends up holding all of them, and
 * "your project will go up some time after you next come online" is a
 * promise about somebody's whole body of work that EO would have no way
 * to keep if they quit the app in between.
 */

/** How many of each kind of row one request carries. */
const PAGE = {
  /** Within the contract's two hundred (EO-476). */
  agents: 100,
  items: 100,
  runs: 50,
  /** Lines, not runs: a chatty agent writes thousands for one dispatch. */
  events: 500,
  transitions: 200,
  comments: 100,
  mentions: 500,
  /** Within the contract's five hundred (EO-482). */
  memories: 200,
  /** Within the contract's two hundred (EO-513). */
  skills: 100,
} as const;

/** What a page's worth of rows is sent by. Injected so a test can watch the order. */
export interface AdoptRequest {
  project: RecordProject;
  /** What the record's counter for this project's key prefix must be at least. */
  keyNextValue: number;
  /** The one request that makes the project live on the record (EO-325). */
  final: boolean;
  /** Give up on a transfer that did not finish, and take the partial project back off. */
  abandon: boolean;
  page: RecordAdoptPage;
}

export type SendAdoptPage = (
  request: AdoptRequest,
) => Promise<{ ok: true; accepted: RecordAdoptCounts } | { ok: false; problem: string }>;

/**
 * Where this machine keeps the files it is about to hand over.
 *
 * One method, named here rather than importing `AttachmentStorage`
 * whole, for `RecordAttachmentStore`'s reason: what this needs is the
 * bytes behind a path, and a class that knows about staging
 * directories, MIME sniffing and Electron's save dialog is not that.
 *
 * Absent is a process with no file store — a test that is not about
 * files. A project that *has* files is then refused rather than moved
 * without them, because a move that silently left the attachments
 * behind is the outcome this whole pass exists to make impossible.
 */
export interface MovedFileStore {
  read(path: string): Promise<Buffer | null>;
}

export interface MoveProjectOptions {
  db: Db;
  projectId: Uuid;
  /** Whose the project becomes: the person this machine signed in as. */
  personId: Uuid;
  /**
   * What to call them, for the row this machine may have to write.
   *
   * The people list lives on the server (EO-323) and a desktop reads it
   * rather than mirroring it, so a machine that has just signed in can
   * hold a person id it has no `people` row for — and
   * `items.created_by` and `items.assignee_id` are foreign keys. The
   * rewrite would fail on the first item. So the row is made if it is
   * missing, with whatever name the sign-in gave, and the next read of
   * the organisation's list corrects it.
   */
  personName?: string;
  send: SendAdoptPage;
  /** This machine's file store, so the attachments can travel with everything else. */
  files?: MovedFileStore;
  now?: () => number;
  /** The implicit local person, overridable only so a test can be explicit about what it means. */
  localPersonId?: Uuid;
}

export type MoveProjectResult =
  | {
      ok: true;
      project: Project;
      moved: RecordAdoptCounts;
      rewritten: number;
      files: number;
      /**
       * What was written here during the commit's own round trip and
       * has not reached the record yet, where that last pass could not
       * be sent.
       *
       * Absent in every ordinary move. The project *is* the
       * organisation's when this is set — the move happened — so this
       * is a sentence about a handful of rows still on their way rather
       * than a failure, and the ordinary queue carries them from here.
       */
      late?: string;
    }
  | { ok: false; problem: string };

/** The running total the pages add up to, so the caller can compare counts. */
function emptyCounts(): RecordAdoptCounts {
  return {
    itemTypes: 0,
    pipelines: 0,
    steps: 0,
    routes: 0,
    agents: 0,
    jobs: 0,
    occurrences: 0,
    items: 0,
    runs: 0,
    runEvents: 0,
    transitions: 0,
    comments: 0,
    mentions: 0,
    deps: 0,
    extensions: 0,
    attachments: 0,
    memories: 0,
    skills: 0,
    skipped: [],
  };
}

function add(total: RecordAdoptCounts, page: RecordAdoptCounts): void {
  total.itemTypes += page.itemTypes;
  total.pipelines += page.pipelines;
  total.steps += page.steps;
  total.routes += page.routes;
  total.agents += page.agents;
  total.jobs += page.jobs;
  total.occurrences += page.occurrences;
  total.items += page.items;
  total.runs += page.runs;
  total.runEvents += page.runEvents;
  total.transitions += page.transitions;
  total.comments += page.comments;
  total.mentions += page.mentions;
  total.deps += page.deps;
  total.extensions += page.extensions;
  total.attachments += page.attachments;
  total.memories += page.memories;
  total.skills += page.skills;
  total.skipped.push(...page.skipped);
}

/**
 * What one page carried, counted the way the record counts what it
 * holds.
 *
 * The two are compared row for row after every request, which is the
 * whole of "a count comparison between the local database and the
 * server proves nothing was lost" — made at the moment it can still be
 * acted on rather than reported afterwards.
 */
function sentInPage(page: RecordAdoptPage): Omit<RecordAdoptCounts, "skipped"> {
  return {
    itemTypes: page.itemTypes.length,
    pipelines: page.pipelines.length,
    steps: page.pipelines.reduce((total, one) => total + one.steps.length, 0),
    routes: page.pipelines.reduce((total, one) => total + one.routes.length, 0),
    agents: page.agents.length,
    jobs: page.jobs.length,
    occurrences: page.occurrences.length,
    items: page.items.length,
    runs: page.runs.length,
    runEvents: page.runEvents.reduce((total, batch) => total + batch.events.length, 0),
    transitions: page.transitions.length,
    comments: page.comments.length,
    mentions: page.mentions.length,
    deps: page.deps.length,
    extensions: page.extensions.length,
    attachments: page.attachments.length,
    memories: page.memories.length,
    skills: page.skills.length,
  };
}

/** The first list the record did not take whole, said in the person's terms. */
function shortfall(sent: Omit<RecordAdoptCounts, "skipped">, accepted: RecordAdoptCounts): string | null {
  for (const [what, count] of Object.entries(sent) as [keyof typeof sent, number][]) {
    const got = accepted[what];
    if (got < count) {
      return `The record took ${String(got)} of ${String(count)} ${what} EO sent it, so the move is not complete.`;
    }
  }
  return null;
}

function chunk<T>(rows: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let at = 0; at < rows.length; at += size) pages.push(rows.slice(at, at + size));
  return pages;
}

/**
 * Hands one project to the record.
 *
 * The order of the pages below *is* the dependency order of the
 * schema, and it is the only part of this that cannot be rearranged:
 * types and graphs before items (`items.type_id`, `items.step_id`),
 * items before runs (`runs.item_id`), runs before their transcripts and
 * before the moves and comments that name them
 * (`transitions.run_id`, `comments.run_id`), and comments before the
 * files that hang off them (`attachments.comment_id`).
 */
export async function moveProjectToRecord(options: MoveProjectOptions): Promise<MoveProjectResult> {
  const { db, projectId, personId } = options;
  const clock = options.now ?? ((): number => Date.now());
  const localPersonId = options.localPersonId ?? LOCAL_PERSON_ID;

  const found = getProject(db, projectId);
  if (found === undefined) return { ok: false, problem: "EO has no project with that id." };
  if (found.managedAt !== null) {
    return { ok: false, problem: `"${found.name}" is already on the record.` };
  }
  const project = found;

  /**
   * Nothing on it may be running.
   *
   * The one writer a frozen scheduler cannot stop is a dispatch that
   * had already started: it holds a worktree, it will post a comment
   * and route a result, and both would land after their page had been
   * read. Refused with a sentence the person can act on — waiting a
   * minute is a smaller ask than a move that quietly left the last
   * thing an agent said behind.
   */
  const busy = listActiveRuns(db).filter((run) => onThisProject(db, projectId, run.itemId));
  if (busy.length > 0) {
    return {
      ok: false,
      problem:
        `Something is still running on "${project.name}", so EO will not move it yet — ` +
        `a run that finished half way through would write its result somewhere the record could not follow. Try again when it is done.`,
    };
  }

  // The row the moved history will point at, here. Written whether or
  // not the move goes through — see `ensureLocalPerson` — because
  // nothing points at it until it does.
  ensureLocalPerson(db, personId, options.personName ?? "you", clock());

  /**
   * The middle of the move begins, and the local scheduler lets go.
   *
   * Durable, so a process that dies mid-transfer comes back with the
   * project still frozen rather than quietly dispatching work that is
   * half way to somewhere else. Cleared by the commit, or by the
   * failure path below.
   */
  if (beginAdoption(db, projectId, clock()) === undefined) {
    return { ok: false, problem: `EO is already moving "${project.name}".` };
  }

  /**
   * The implicit local person, as the record will know them.
   *
   * Applied on the way out and written down nowhere until the end —
   * see the file note. Only `LOCAL_PERSON_ID`: a project may already
   * name a real colleague, and rewriting those would be this machine
   * deciding that everybody it had ever named was in fact the person
   * holding the keyboard.
   */
  const asPerson = (id: string | null): string | null => (id === localPersonId ? personId : id);

  /**
   * The project row, read afresh on every request.
   *
   * Captured once at first, and the review found what that cost: a
   * rename during the transfer never reached the record, because the
   * name the pages carried was the one the move had started with. A
   * project row is four fields and a read of it is a single indexed
   * lookup, so there is nothing to hold.
   */
  function wireNow(): RecordProject {
    const current = getProject(db, projectId) ?? project;
    return {
      id: current.id,
      name: current.name,
      keyPrefix: current.keyPrefix,
      // A claim, and one the record ignores: it derives the owner from
      // the device token the door authenticated. Carried so a replica
      // reading this shape elsewhere has an answer, never so that a
      // client can choose one.
      ownerId: personId,
      // What it is about to become. The record stamps its own moment.
      managedAt: clock(),
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
    };
  }

  const total = emptyCounts();
  /**
   * What has already gone up, by table.
   *
   * A version rather than a tick, and that is the review's second
   * finding. "Have I sent this id" is the wrong question: a person can
   * edit an item whose page is already in flight, and a pass that
   * skipped it because it had seen the id once left the record holding
   * the title the snapshot happened to read — under a move that
   * reported success. So each row is remembered at the `updated_at` it
   * was sent at, a row is carried again when its stamp has moved, and
   * the record takes the newer of the two.
   *
   * The rows that genuinely cannot change carry `0` and are matched on
   * presence alone: a transition and a run event are append-only by
   * invariant #3, and a comment's body is immutable — its pin is not,
   * which is why a comment is re-sent when its `pinnedAt` moves.
   */
  const sent: SentVersions = {
    agents: new Map(),
    items: new Map(),
    runs: new Map(),
    transitions: new Set(),
    comments: new Map(),
    mentions: new Map(),
    files: new Set(),
    memories: new Map(),
    skills: new Map(),
  };
  /**
   * The dependency graph as it was last sent, written out.
   *
   * An edge has no version — `item_deps` is two ids and nothing else —
   * so "has this changed" is answered by comparing the whole set, which
   * is small. The empty string is a graph that has never been sent, and
   * is deliberately different from the empty *graph*: a project that
   * never had a dependency and one whose last one was just taken off
   * are two different things to tell the record.
   */
  let sentGraph = "\u0000never sent";

  /**
   * One request, and the check that makes it mean something.
   *
   * Answers a sentence for "stop" and null for "carry on". Three things
   * end a move here and they are one rule in three shapes: the record
   * did not answer, the record said it could not write something, or
   * the record took fewer rows than it was sent.
   */
  async function send(part: Partial<RecordAdoptPage>, final = false): Promise<string | null> {
    const page: RecordAdoptPage = { ...emptyPage(), ...part };
    const answer = await options.send({ project: wireNow(), keyNextValue: keyCounterFor(db, project.keyPrefix), final, abandon: false, page });
    if (!answer.ok) return answer.problem;
    add(total, answer.accepted);
    if (answer.accepted.skipped.length > 0) {
      return `The record could not take part of this project: ${answer.accepted.skipped.join("; ")}`;
    }
    return shortfall(sentInPage(page), answer.accepted);
  }

  /** Gives up: the project goes back to what it was, here and there. */
  async function giveUp(problem: string): Promise<MoveProjectResult> {
    abandonAdoption(db, projectId, clock());
    // Best effort, and deliberately not checked. The record's copy is
    // hidden and unschedulable either way; this is the tidying, and a
    // machine that has just failed to reach its record may well fail to
    // reach it again.
    try {
      await options.send({ project: wireNow(), keyNextValue: 0, final: false, abandon: true, page: emptyPage() });
    } catch {
      // Nothing to add: the sentence the person needs is `problem`.
    }
    return { ok: false, problem };
  }

  /**
   * Everything of this project the record has not been sent yet, in
   * dependency order.
   *
   * One function rather than a straight line through the tables,
   * because it is run more than once: a move takes seconds and the
   * person is still at their desk, so a pass that sent everything is
   * followed by a pass that sends whatever appeared while it ran, until
   * one of them finds nothing. That is the review's "durably capture
   * source-project writes throughout the snapshot window", done by
   * reading rather than by locking — the scheduler is already frozen,
   * so what is left is a human's own typing and it converges in one
   * more pass.
   *
   * Answers how many rows it sent, or a sentence if the record refused.
   */
  async function sweep(): Promise<number | string> {
    let carried = 0;

    // The structure, every pass. Cheap, idempotent, and it is what a
    // pipeline added mid-move would arrive on.
    const structural = await send({
      itemTypes: readProjectItemTypes(db, projectId),
      pipelines: readProjectPipelines(db, projectId).map((pipeline) => ({
        ...pipeline,
        steps: pipeline.steps.map((step) => ({ ...step, ownerPersonId: asPerson(step.ownerPersonId) })),
      })),
    });
    if (structural !== null) return structural;

    // The project's own skills and its workspaces' (EO-513), before the
    // agents attached to them: the record attaches an agent only to a
    // skill it holds. Never a global skill — that is the installation's,
    // and what an agent is attached to beyond the project's own is said
    // in a message by the record, once the project is live.
    const newSkills = readProjectSkills(db, projectId).filter((skill) => stale(sent.skills, skill.id, skill.updatedAt));
    for (const page of chunk(newSkills, PAGE.skills)) {
      const problem = await send({ skills: page });
      if (problem !== null) return problem;
      for (const skill of page) sent.skills.set(skill.id, skill.updatedAt);
      carried += page.length;
    }

    // The project's own agents (EO-476), after the graphs and before any
    // run that names one, so the moved runs and comments still say who
    // did them. Paged, because nothing bounds how many a project
    // collects — archived and deleted ones travel too — and a page is
    // held to `RecordAdoptPageSchema`'s limit. Sent again only when an
    // agent has changed since, as the items are.
    const newAgents = readProjectAgents(db, projectId).filter((agent) => stale(sent.agents, agent.id, agent.updatedAt));
    for (const page of chunk(newAgents, PAGE.agents)) {
      const problem = await send({ agents: page });
      if (problem !== null) return problem;
      for (const agent of page) sent.agents.set(agent.id, agent.updatedAt);
      carried += page.length;
    }

    const newItems = readProjectItems(db, projectId).filter((item) => stale(sent.items, item.id, item.updatedAt));
    for (const page of chunk(newItems, PAGE.items)) {
      const problem = await send({
        items: page.map((item) => ({ ...item, createdBy: asPerson(item.createdBy), assigneeId: asPerson(item.assigneeId) })),
      });
      if (problem !== null) return problem;
      for (const item of page) sent.items.set(item.id, item.updatedAt);
      carried += page.length;
    }

    const itemIds = projectItemIds(db, projectId);

    // The runs, then their transcripts. Two passes rather than one,
    // because a batch of events is refused by a record that has not got
    // the run — `run_events.run_id` is a foreign key on both sides — and
    // one run's transcript can be larger than every run row put together.
    const newRuns = readItemRuns(db, itemIds).filter((run) => stale(sent.runs, run.id, run.updatedAt));
    for (const page of chunk(newRuns, PAGE.runs)) {
      const problem = await send({
        // The same shape a run takes on the ordinary sync path, which is
        // what leaves this machine's `cwd`, pid and provider session
        // behind — none of them means anything on another machine.
        runs: page.map((run) => asRunCommand(run, uuidv7(), run.updatedAt)),
      });
      if (problem !== null) return problem;
      for (const run of page) sent.runs.set(run.id, run.updatedAt);
      carried += page.length;
    }
    // The transcripts of runs this pass has not sent lines for. Keyed
    // on the run rather than on the line, because `run_events` is
    // append-only and `(runId, seq)` makes a re-send free.
    for (const run of newRuns) {
      for (const page of chunk(readRunTranscript(db, run.id), PAGE.events)) {
        const problem = await send({ runEvents: [{ runId: run.id, events: page }] });
        if (problem !== null) return problem;
        carried += page.length;
      }
    }

    const newMoves = readItemTransitions(db, itemIds).filter((move) => !sent.transitions.has(move.id));
    for (const page of chunk(newMoves, PAGE.transitions)) {
      const problem = await send({ transitions: page });
      if (problem !== null) return problem;
      for (const move of page) sent.transitions.add(move.id);
      carried += page.length;
    }

    const newComments = readItemComments(db, itemIds).filter((comment) => {
      // A body cannot change and a pin can, so a comment goes again
      // only when somebody has pinned or unpinned it since.
      //
      // Compared rather than *ordered*, which is the review's second
      // finding. A pin is two states, not a version, and the monotonic
      // rule the other tables use read `false` as older than `true`: a
      // comment sent pinned and unpinned before the commit was never
      // re-sent, and the record kept a pin the person had taken off —
      // which is a thread whose important part is marked somewhere
      // else, and an agent's context keeping the wrong half of it (ARCHITECTURE.md, "What an agent
      // is given").
      const before = sent.comments.get(comment.commentId);
      return before === undefined || before !== comment.pinned;
    });
    for (const page of chunk(newComments, PAGE.comments)) {
      // The comments themselves. Their mentions travel on their own
      // list, below — see `RecordAdoptedMentionSchema`, which says why.
      const problem = await send({ comments: page });
      if (problem !== null) return problem;
      for (const comment of page) sent.comments.set(comment.commentId, comment.pinned);
      carried += page.length;
    }

    /**
     * Who those comments are asking, and whether it has been answered
     * (EO-325, review).
     *
     * After every comment, because `addressed_by` names one — a mention
     * is answered by a reply *later* than the comment it sits on, and a
     * page boundary between the two would leave a foreign key pointing
     * at a row the record had not reached yet.
     *
     * Versioned on the pair that can change. A body is immutable and a
     * target does not move, but an escalation is answered and a mention
     * is dismissed — and rebuilding the row as `open` was what made an
     * escalation somebody had closed a fortnight ago land back in the
     * signed-in person's inbox after a move.
     */
    const mentions = readItemMentions(db, itemIds).map((mention) =>
      mention.targetType === "human" ? { ...mention, targetId: asPerson(mention.targetId) } : mention,
    );
    const staleMentions = mentions.filter((mention) =>
      changed(sent.mentions, mentionKey(mention), `${mention.status}|${mention.addressedBy ?? ""}`),
    );
    for (const page of chunk(staleMentions, PAGE.mentions)) {
      const problem = await send({ mentions: page });
      if (problem !== null) return problem;
      for (const mention of page) sent.mentions.set(mentionKey(mention), `${mention.status}|${mention.addressedBy ?? ""}`);
      carried += page.length;
    }

    /**
     * What the packs know about those items, and the graph that decides
     * what may run (EO-325).
     *
     * The extensions are versioned like everything else. The edges are
     * not — `item_deps` is two ids and nothing else — so the whole set
     * travels on every pass that carries an item, and the record
     * replaces its own with it. That is what makes a dependency *taken
     * off* mid-transfer land as taken off, and it costs nothing: a
     * project's graph is small and this is one array.
     *
     * A dependency reaching out to work that stayed behind cannot be
     * written on the record at all, so the move stops and names it
     * rather than handing over a project the record will schedule
     * differently.
     */
    const extensions = readItemExtensions(db, itemIds);
    const graph = readProjectDeps(db, itemIds);
    if (graph.severed.length > 0) {
      return (
        `Moving "${project.name}" would cut a dependency it has on work that is staying here: ` +
        `${graph.severed.join("; ")}. Move those together, or take the dependency off first.`
      );
    }
    const staleExtensions = extensions.filter((one) => stale(sent.items, `${one.itemId}:${one.extension}`, one.updatedAt));
    // The graph goes when it is not what was last sent — *including*
    // when it has become empty, which is what a dependency taken off
    // mid-transfer looks like and what a length check would miss.
    const shape = graph.edges.map((edge) => `${edge.itemId}>${edge.dependsOnId}`).join(",");
    const graphChanged = shape !== sentGraph;
    if (staleExtensions.length > 0 || graphChanged) {
      const problem = await send({ extensions: staleExtensions, deps: graph.edges, graph: graphChanged });
      if (problem !== null) return problem;
      for (const one of staleExtensions) sent.items.set(`${one.itemId}:${one.extension}`, one.updatedAt);
      sentGraph = shape;
      carried += staleExtensions.length + (graphChanged ? 1 : 0);
    }

    // The project's memory and its workspaces' (EO-482), after the runs
    // and items an entry names as its source. Every entry, retired ones
    // too — memory travels with its project, history and all — and again
    // when one has changed since, as the items are.
    const newMemories = readProjectMemories(db, projectId).filter((entry) => stale(sent.memories, entry.id, entry.updatedAt));
    for (const page of chunk(newMemories, PAGE.memories)) {
      const problem = await send({ memories: page });
      if (problem !== null) return problem;
      for (const entry of page) sent.memories.set(entry.id, entry.updatedAt);
      carried += page.length;
    }

    // Then the jobs, because a job names the item its thread lives on —
    // and what they have already done, because an occurrence names the
    // job. Together, so a record never holds a schedule with no account
    // of it: it would fire an occurrence this machine had already
    // fired, and the skip somebody was told about would be gone from
    // the thread it was told in.
    const jobs = readProjectJobs(db, projectId);
    const occurrences = readProjectOccurrences(db, projectId);
    if (jobs.length > 0 || occurrences.length > 0) {
      const problem = await send({
        jobs: jobs.map((job) => ({ ...job, ownerId: asPerson(job.ownerId) ?? job.ownerId })),
        occurrences,
      });
      if (problem !== null) return problem;
    }

    // And last the files, one per request, because one fills a request —
    // and *before* the move is finished, because a move whose
    // attachments were still on this machine only is exactly what an
    // earlier review found reported as a success.
    const newFiles = projectAttachments(db, itemIds).filter((file) => !sent.files.has(file.id));
    const refused = await sendFiles(newFiles, options.files, send);
    if (refused !== null) return refused;
    for (const file of newFiles) sent.files.add(file.id);
    carried += newFiles.length;

    return carried;
  }

  /**
   * How many passes before EO gives up on the project going quiet.
   *
   * The scheduler is frozen, so the only writer left is the person who
   * pressed Move, and one more pass is enough for anything they typed
   * while the first ran. More than a handful means something is writing
   * to this project continuously, and finishing a move by outrunning it
   * is not something to attempt.
   */
  const PASSES = 5;
  let quiet = false;
  for (let pass = 0; pass < PASSES && !quiet; pass += 1) {
    const carried = await sweep();
    if (typeof carried === "string") return giveUp(carried);
    quiet = carried === 0;
  }
  if (!quiet) {
    return giveUp(`Work kept arriving on "${project.name}" while EO was moving it, so it has stopped rather than move an incomplete copy.`);
  }

  // The last request, and the only one that makes the project live
  // there. Nothing is carried on it: the pass above found nothing left,
  // which is what "quiet" means.
  const committed = await send({}, true);
  if (committed !== null) return giveUp(committed);

  /**
   * And the same instant, here.
   *
   * One synchronous block, deliberately: `better-sqlite3` is
   * synchronous and this process is single-threaded, so nothing of this
   * machine's own can write between these statements. The project
   * becomes the record's, which is what routes every write after this
   * line to the queue instead of to the local record.
   */
  const rewritten = adoptLocalPersonRows(db, projectId, localPersonId, personId);
  for (const run of readItemRuns(db, projectItemIds(db, projectId))) {
    // The record holds these runs and every line of them, so the
    // ordinary run sync must not offer them again. After the transfer
    // rather than during it, which is `markRunSynced`'s own rule said
    // one level up: a bookmark moved for a move that then failed is a
    // transcript with a hole in it that nothing goes back for.
    markRunSynced(db, run.id, highestRunEventSeq(db, run.id), run.status);
  }
  const moved = markProjectOnTheRecord(db, projectId, personId, clock());
  if (moved === undefined) return giveUp("EO lost track of that project part way through moving it.");
  // Where every watch on its items stands (EO-456), queued for the record
  // now that it owns them. A watch is shared state there — the record's
  // scheduler holds the item from its own copy of the row — and these
  // were written while the project was this machine's alone, when
  // nothing was queued. Without them the record would offer every
  // watching item at once and keep offering it until each next check
  // ran, and a device leased one would start a watch of its own.
  const movedItems = new Set(projectItemIds(db, projectId).map(String));
  for (const watch of listItemWatches(db)) {
    if (!movedItems.has(watch.itemId)) continue;
    enqueueWatchCommand(db, { kind: "watch", id: uuidv7(), ...asRecordWatch(watch), updatedAt: 0 }, watch.itemId, clock());
  }

  /**
   * One last look, for the round trip that made it live.
   *
   * The commit was a request, and a request takes time; a person
   * typing during it wrote rows that this machine held and the record
   * did not. Everything written *after* the line above is queued by
   * `queueOutbound`, because the project is the record's now — so this
   * covers exactly the window between the last sweep and the mark, and
   * covers it through the same idempotent door.
   *
   * Said rather than failed if it cannot be sent: the move itself is
   * done and the project is the organisation's, so the honest answer is
   * to name what is still on its way rather than to pretend the move
   * did not happen.
   */
  const late = await sweep();
  const files = sent.files.size;
  /**
   * What was moved, read from the database rather than added up from
   * the acknowledgements (EO-325, review).
   *
   * Adding them up double-counted, and a count comparison could not
   * see it: the sweep re-sends the structure on every pass so that a
   * pipeline added mid-transfer arrives, so an ordinary two-pass move
   * acknowledged its types, pipelines, steps and routes twice and
   * reported twice as many as exist. A number that says two of
   * something the record holds one of is a number nobody can check
   * anything against.
   *
   * Read *after* every page was accepted whole — which the per-page
   * shortfall check already proves — so this is what the record holds
   * as much as it is what this machine does, and it is directly
   * comparable to a count taken on either side.
   *
   * `skipped` keeps the running list, because a skip is an event rather
   * than a row: it belongs to the passes it happened in. In practice it
   * is always empty here, since anything said ends the move.
   */
  const counted: RecordAdoptCounts = { ...countProjectRows(db, projectId), skipped: total.skipped };
  if (typeof late === "string") {
    return { ok: true, project: moved, moved: counted, rewritten, files, late };
  }

  return { ok: true, project: moved, moved: counted, rewritten, files };
}

/** What has already gone up, by table, at the version it went up at. */
interface SentVersions {
  /** A project's own agents, at the `updated_at` they were sent at (EO-476). */
  agents: Map<string, number>;
  items: Map<string, number>;
  runs: Map<string, number>;
  /** Append-only by invariant #3: an id here has been sent and cannot have changed. */
  transitions: Set<string>;
  /**
   * The pin, which is the one thing about a comment that changes after
   * it is written — and the one field here that is a *state* rather
   * than a version.
   *
   * So it is compared for difference rather than for being newer.
   * `stale` reads a smaller number as older, which is right for a
   * timestamp and wrong for a boolean: unpinning would have looked like
   * going backwards, and the row would never have been sent again.
   */
  comments: Map<string, boolean>;
  files: Set<string>;
  /**
   * Mentions, by the pair of theirs that changes: the status and the
   * reply that answered it.
   *
   * A string rather than a number, so `stale` compares for difference
   * rather than for being newer — a status moves between `open`,
   * `addressed` and `dismissed` in no particular order, exactly as a
   * pin does.
   */
  mentions: Map<string, string>;
  /**
   * Memory entries (EO-482), at the `updated_at` they were sent at: an
   * entry retired or restored mid-move changes its stamp, and goes again.
   */
  memories: Map<string, number>;
  /** The project's own skills and its workspaces' (EO-513), at the `updated_at` they were sent at. */
  skills: Map<string, number>;
}

/** A mention's identity: the three columns its primary key is. */
function mentionKey(mention: { commentId: string; targetType: string; targetId: string | null }): string {
  return `${mention.commentId}|${mention.targetType}|${mention.targetId ?? ""}`;
}

/** Whether a row has to go again: never sent, or sent at a version that has since moved. */
function stale(seen: Map<string, number>, id: string, version: number): boolean {
  const sentAt = seen.get(id);
  return sentAt === undefined || version > sentAt;
}

/**
 * The same question for a row whose "version" is a *state*.
 *
 * A pin, and a mention's status, move in no particular order — so
 * "newer" is the wrong comparison and "different" is the right one. The
 * two are kept apart rather than folded into one generic, because
 * getting them the wrong way round is precisely the bug the review
 * found: `false` read as older than `true`, and an unpin was never
 * re-sent.
 */
function changed(seen: Map<string, string>, id: string, state: string): boolean {
  const before = seen.get(id);
  return before === undefined || before !== state;
}

/** A request that carries no rows — the commit, and the abandon. */
function emptyPage(): RecordAdoptPage {
  return {
    itemTypes: [],
    pipelines: [],
    agents: [],
    jobs: [],
    occurrences: [],
    items: [],
    runs: [],
    runEvents: [],
    transitions: [],
    comments: [],
    mentions: [],
    deps: [],
    graph: false,
    extensions: [],
    attachments: [],
    memories: [],
    skills: [],
  };
}

/** Whether this item is one of that project's. */
function onThisProject(db: Db, projectId: Uuid, itemId: Uuid): boolean {
  return getItem(db, itemId)?.projectId === projectId;
}

/**
 * Every file on the project, one request each.
 *
 * Answers a sentence for "stop" and null for "carry on", as `send`
 * does. A project with files and no store to read them from is refused
 * rather than moved without them; a file whose bytes have gone missing
 * from this machine's store is refused for the same reason. Both are
 * losses, and a move that is allowed to lose something is not a move.
 */
async function sendFiles(
  files: readonly MovedFile[],
  store: MovedFileStore | undefined,
  send: (part: Partial<RecordAdoptPage>) => Promise<string | null>,
): Promise<string | null> {
  if (files.length === 0) return null;
  if (store === undefined) {
    return `This project has ${String(files.length)} file(s) and EO has nowhere to read them from, so it will not move it without them.`;
  }
  for (const file of files) {
    const bytes = await store.read(file.storagePath);
    if (bytes === null) {
      return `EO could not find the file "${file.name}" on this machine, so it will not move this project without it.`;
    }
    const problem = await send({
      attachments: [
        {
          id: file.id,
          itemId: file.itemId,
          commentId: file.commentId,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          createdAt: file.createdAt,
          dataBase64: bytes.toString("base64"),
        },
      ],
    });
    if (problem !== null) return problem;
  }
  return null;
}

/**
 * Somebody for the moved rows to point at, where this machine has no
 * row for them yet.
 *
 * Called before the transfer rather than after it, and it is the one
 * write that happens either way. That is safe where the rewrite is not:
 * a `people` row for the person sitting at this machine is true whether
 * or not the move goes through, and it is the row the organisation's
 * list would have written on the next read anyway. Nothing points at it
 * until the move succeeds.
 */
export function ensureLocalPerson(db: Db, personId: Uuid, name: string, at: number): void {
  if (getPerson(db, personId) === undefined) createPerson(db, { id: personId, name, acceptedAt: at });
}
