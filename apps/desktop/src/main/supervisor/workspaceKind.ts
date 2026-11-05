import type { Agent, Item, PipelineStep, RepositoryMcpServer, Skill, Uuid, WorkspaceKindSlug } from "@eo/core";

/**
 * What a workspace *is*, as five members (EO-295, EO-297,
 * ARCHITECTURE.md, "The interface").
 *
 * Until this file, "the disk a run happens on" was eight options on the
 * run supervisor, each typed on a worktree path or on git: a hook that
 * prepared one, three that checked what had been done in one, two that
 * released one, and two that lent the agent what the checkout had to
 * offer. Nothing named the thing they were all about, so a second kind
 * of workspace — a folder, a scratch directory, a helpdesk reached
 * through an MCP server and no disk at all — could not be added without
 * adding eight more, and the design counted the cost: one
 * method of the design's interface had no implementation, one was
 * missing entirely, and three hooks were one method wearing three names.
 *
 * So a kind is a *value* a pack contributes, keyed by its slug, and the
 * supervisor holds a map of them. The item's workspace row names the
 * slug; the supervisor looks it up and reaches for these five members
 * and no others — four of them methods, and `verify` a table of
 * verifiers keyed by action since EO-297. That is the whole of what
 * makes "this step drafts in a scratch directory and the next one
 * commits to a branch" a pipeline somebody can configure rather than a
 * change to TypeScript.
 *
 * **Every method leads with the item it is about**, which is the one
 * deviation from the design's shorthand: `attach(cwd, agent)` there is
 * `attach(item, agent, workspace)` here, because the git kind's query
 * server is pointed at *an item's* checkout and would otherwise have to
 * be handed the item through a closure it does not have.
 */
export interface WorkspaceKind {
  /**
   * How a workspace row names this kind, and how a pack's contribution
   * is keyed.
   *
   * The same string `workspaces.kind` holds. Two installed packs may not
   * claim one slug — `foldPacks` refuses it, on the same grounds it
   * refuses two packs claiming one builtin action.
   */
  readonly slug: WorkspaceKindSlug;

  /**
   * Somewhere for this run to work, or why there is nowhere.
   *
   * The second argument is the **action**, not the step the design names:
   * every caller has one at the moment it prepares — an agent dispatch,
   * a `builtin` step, a module run — and the step's own
   * workspace choice is EO-301's, arriving with the picker that lets a
   * person make one. `create_worktree` calling this is what makes it
   * idempotent by contract: preparing twice for one item is the ordinary
   * case, not a mistake.
   *
   * A refusal may carry `options`: the answers EO would accept when it
   * stopped to *ask* something — which dependency to stack on — rather
   * than to report something. They become the buttons on the escalation
   * comment.
   */
  prepare(item: Item, action: string, options?: PrepareWorkspaceRequest): Promise<PrepareWorkspaceOutcome>;

  /**
   * What this workspace lends the agent about to work in it.
   *
   * Three supervisor hooks until this story, and nothing named what they
   * had in common: the repository MCP server a dispatch hands the
   * backend, the sentence to post when there is none to hand, and the
   * index sync that keeps the first of those describing the code the
   * *next* agent will read rather than the code this one started from.
   *
   * Called on each of the three paths that reach a provider — a fresh
   * dispatch, a person's reply unparking a run, and a run recovered
   * after a crash — because each spawns the backend afresh and starts
   * the servers *that* invocation declares. A resumed reviewer that was
   * not asked again is a reviewer silently worse off than a fresh one.
   */
  attach(item: Item, agent: Agent, workspace: PreparedWorkspace): Promise<WorkspaceAttachment>;

  /**
   * What this kind can say for itself about what a run claims to have
   * done, keyed by the action of the run (G-02, invariant 5, EO-297).
   *
   * A list of checks rather than a verdict, because a workspace has more
   * than one thing to say: the git kind returns the mechanical
   * verification of the implementation, whether the tree was left clean,
   * and whether any file on the branch was copied out of another item's
   * unmerged work. Those were three hooks, reported at three call sites,
   * in three different voices.
   *
   * **Data rather than a method**, which is the difference EO-297 makes.
   * A single `verify` had to open with `if (run.action !== "implement")`
   * — the same sentence the implementation verifier already opened with
   * — so which actions a kind could vouch for was a fact buried two
   * functions deep in a pack, and nothing outside could ask it. Invariant
   * 5 now reads "verify where you can, and *say what you checked*", and
   * both halves of that need the question answerable from outside: the
   * supervisor asks it to decide whether `verification_failed` is a
   * result this step can route on, and a column head asks it to say what
   * was checked rather than implying something was.
   *
   * An action with no entry here, and no `ANY_ACTION` entry, is not
   * checked. That is a real answer and not a gap — `refine` produces stories the engine cannot invent or
   * judge and `review` is the reviewer's own opinion, so claiming to
   * verify either would be theatre — and the honest way to say it is to
   * register nothing, so that no tick appears beside a run nothing looked
   * at.
   */
  readonly verifiers: Readonly<Record<string, Verifier>>;

  /**
   * Let go of what a workspace was holding: one item's, because it has
   * settled, or every one nothing is working in any more.
   *
   * Both, through one method, because they are one question asked at two
   * moments — and the git kind answers both with the same removal. Never
   * called while a run is live: a settled item is one that will not be
   * dispatched again, and the sweep is handed the predicate that says
   * which keys still have a run behind them.
   */
  release(request: ReleaseRequest): Promise<ReleaseOutcome>;

  /**
   * What the run produced, as things a person can read.
   *
   * The diff over the verified range for git; the changed files for a
   * folder or a scratch directory.
   *
   * The supervisor posts what this returns as the item's output — a
   * comment of kind `output`, which a person's edit supersedes (EO-298,
   * ARCHITECTURE.md, "The output is a comment") — on every path a run ends on, which since EO-297
   * means an
   * agent's, a builtin's and a module's alike. Asked after the
   * verification and before anything routes on the result: EO does not
   * say a ticket has produced something on work its own workspace has
   * just refused to confirm.
   *
   * Nothing to produce is the ordinary answer, and an empty list posts
   * no comment at all.
   *
   * **What is returned has to outlive the call.** A `FileArtifact`
   * names a path the supervisor is about to read, so a kind that tidies
   * up after itself must do it in `release({ what: "collected" })` —
   * called once the files are safely copied — rather than here.
   */
  artifacts(item: Item, run: VerifiableRun): Promise<readonly Artifact[]>;

  /**
   * Which capacity bucket a run on this workspace consumes (EO-296,
   * ARCHITECTURE.md, "Capacity and concurrency").
   *
   * **Concurrency is per shared filesystem**, and only the kind knows
   * what sharing means for it. A git worktree answers with the workspace
   * id in either mode: one checkout, one index, one set of refs, and two
   * runs touching them at once is the collision the cap exists for.
   * `none` answers null — two empty directories tread on nothing — and
   * so will `scratch`, whose whole nature is a directory per run.
   *
   * Null is "in no bucket": the global cap is then the only one such a
   * run answers to. That is not a loosening. Invariant 10 stands and
   * concurrency is still 1; this changes what the cap is *keyed on*,
   * which until now was a pack-supplied hook reading the item's
   * workspace id directly, with an empty-string bucket that every item
   * with no workspace shared because they all ran in the same process
   * directory. There is no such directory any more.
   *
   * The one member beyond the design's five. It is not another
   * *lifecycle* — nothing prepares, checks or releases
   * anything here — it is the one question the scheduler asks before any
   * of the five are reachable, and it has to be answered without
   * preparing anything, on every item, on every tick.
   */
  capacityKeyOf(item: Item): string | null;

  /**
   * Why a turn may not start in this directory, or null when it may
   * (EO-386).
   *
   * Asked by the supervisor immediately before every call that reaches a
   * backend — a fresh dispatch, a resume, a corrective turn — and before
   * anything is spawned. A reason ends the run in a comment on the item
   * (invariant 8); it is posted as written, so it names the directory.
   *
   * **This is where "must this turn be inside a Git repository?" is
   * answered**, and it is a fact about the workspace rather than about
   * the agent's role or its backend. It used to be Codex's alone: a
   * check `codex exec` made, re-made in EO's client, and switched off by
   * role. So a Codex agent on a scratch directory was refused where a
   * Claude one ran, and a Claude implementer handed the wrong directory
   * for a checkout simply worked there. The git kind answers here; the
   * kinds whose disk is not a repository say nothing, and both adapters
   * are handed the same answer because neither of them is asked
   * (invariant 12).
   *
   * Optional, and absent is "any directory this kind prepared will do".
   * Synchronous because it sits between the last recheck a dispatch
   * makes and the provider call that recheck guards: an await here would
   * be one more moment for a pause to arrive unnoticed.
   */
  refusesTurn?(item: Item, workspace: PreparedWorkspace): string | null;

  /**
   * A temporary checkout of a branch of a repository on the item's
   * project, for the item's agents to read (EO-632).
   *
   * Not the item's workspace: it is never where a run works, it is
   * something a run may ask to look at — another repository on the
   * project, or another branch of the item's own. The git kind answers
   * with a detached checkout made for this item, fetched from the
   * repository's remote first. Asking again refreshes it.
   *
   * Optional, and absent is "this kind has no repositories to lend".
   */
  referenceCheckout?(item: Item, request: ReferenceCheckoutRequest): Promise<ReferenceCheckoutOutcome>;

  /**
   * Remove every reference checkout this item holds (EO-632).
   *
   * Called when the item settles, on every installed kind rather than
   * only the item's own: an item whose own workspace is not a checkout
   * may still have been lent one. The kind says on the item what was
   * written to any of them (invariant 8) and removes them regardless —
   * nothing in a reference checkout is anyone's work. The startup sweep
   * is `release({ what: "stale" })`'s, as it is for a workspace.
   */
  releaseReferenceCheckouts?(item: Item): Promise<void>;
}

/** Which repository and which branch an item is asking to read (EO-632). */
export interface ReferenceCheckoutRequest {
  /** A repository on the item's project, by the name a person gave it. */
  repository: string;
  branch: string;
  signal?: AbortSignal;
}

/** A reference checkout made, or why not — the reason names what was asked for and is shown as written. */
export type ReferenceCheckoutOutcome = { ok: true; checkout: ReferenceCheckout } | { ok: false; reason: string };

/** A detached checkout of one branch, made for one item. */
export interface ReferenceCheckout {
  /** Absolute; the same path every time this item asks for this branch of this repository. */
  path: string;
  /** The commit HEAD is detached at. */
  commit: string;
  /** Whether that commit is the remote branch's, freshly fetched, or the local branch's because the remote has no such branch. */
  source: "remote" | "local";
  repository: string;
  branch: string;
}

/**
 * Where a run is to happen, resolved.
 *
 * `cwd` is what the backend is pointed at and what the run row records.
 * The other two are what a later hook needs in order to find its way
 * back to this kind without asking the database again — and, more to the
 * point, what stops a downstream hook being handed a bare string it then
 * has to guess the meaning of. That guess is what the eight hooks were:
 * every one of them took a `worktreePath`, and every one of them was
 * therefore about git whether it meant to be or not.
 */
export interface PreparedWorkspace {
  /** The directory the run works in. */
  cwd: string;
  /**
   * The kind that prepared it.
   *
   * Never null since EO-296. It was, for one story, and what null meant
   * was the process working directory: an installation with no pack, or
   * an item whose project has no workspace attached. Both are the `none`
   * kind now — an empty directory and a "no disk" badge — so every
   * prepared workspace was prepared by something, and a downstream hook
   * reading this never has to ask what "no kind" would mean.
   */
  kind: WorkspaceKindSlug;
  /** The workspace row this came from, or null for an item that names none. */
  workspaceId: Uuid | null;
}

/** Where a run is to happen, or why nowhere. */
export type PrepareWorkspaceOutcome = { ok: true; workspace: PreparedWorkspace } | { ok: false; reason: string; options?: string[] };

/** What a caller may say about the preparation it is asking for: cancellation and narration. */
export interface PrepareWorkspaceRequest {
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}

/**
 * What a workspace lends one agent for one turn.
 *
 * Lists rather than single values, and nothing here is a process EO
 * started: a server is a *configuration* handed to the backend, which
 * starts it and takes it down with itself, so a cancelled run leaves no
 * handle for EO to have leaked.
 */
export interface WorkspaceAttachment {
  /**
   * The MCP servers this workspace lends the agent.
   *
   * At most one reaches the backend today, because `AgentTurnOptions`
   * carries one `repositoryMcp` per turn; widening that is a change to
   * the provider contract and to both adapters (invariant 12), which is
   * not this story's. A list here regardless, because it is the kind
   * that knows how many it has to lend and a shape that can only say
   * "one" is the shape the eight hooks had.
   */
  mcpServers: readonly RepositoryMcpServer[];
  /**
   * The skills this workspace lends, on top of the agent's own.
   *
   * Empty for git today: the worktree skills a Codex agent reads are
   * written into the checkout by the adapter at spawn, out of the
   * agent's attachments (EO-207), and moving that delivery here would be
   * moving a provider's business into a workspace's. The field is here
   * because the design counts skills among what a workspace lends, and
   * because the kind that lends one should have somewhere to put it
   * rather than a reason to add a ninth hook.
   */
  skills: readonly Skill[];
  /**
   * What to say in the thread about what this agent is working without.
   *
   * Invariant 8, and deliberately separate from the work: most of the
   * ways an agent goes without are not a guard dropping anything — the
   * feature is off, the item has no repository — and the kind decides
   * which of those is worth a sentence. The supervisor posts what it is
   * given and nothing when it is given nothing.
   */
  notices: readonly string[];
  /**
   * Brings what was lent up to date with the work the run just did, at
   * the handover before the item moves (EO-153).
   *
   * On the attachment rather than beside it because it is the same
   * lending seen from the other end: an index is worth handing the next
   * agent only if it describes the code that agent will actually read.
   *
   * **Called between the verification and the transition, and nowhere
   * else.** A run that failed verification produced nothing worth
   * indexing, and an item that has already moved is the next agent's
   * problem rather than the last one's. Absent is an ordinary answer,
   * and the supervisor's own rule stands over it: nothing here may stop
   * a transition, so a refusal becomes a comment and a throw becomes a
   * comment.
   */
  sync?: (signal: AbortSignal) => Promise<{ notice: string | null }>;
}

/** Nothing lent, which is what a run with no kind — and every supervisor built without one — gets. */
export const NOTHING_ATTACHED: WorkspaceAttachment = { mcpServers: [], skills: [], notices: [] };

/**
 * What one action's claim is checked by (EO-297).
 *
 * Handed the run rather than only the workspace, because two runs of the
 * same action in the same directory can deserve different checks: a run
 * that stopped to ask has claimed nothing, and the git kind has one
 * thing to say about it rather than three.
 *
 * **It says what it checks before it has checked anything** (EO-312).
 * `Check.describes` is a sentence about a run that happened — "Nothing
 * was left uncommitted in EO-1's worktree" — and a column head is read
 * by somebody deciding whether to put work on this pipeline at all,
 * before any run exists. So the verifier carries `describes` as well:
 * the short phrases a head joins into "EO checks: commits, tests ran".
 * Required rather than optional, because invariant 5 now reads "verify
 * where you can, and *say what you checked*", and a verifier that
 * cannot say what it looks at leaves a head with the choice of
 * inventing something or claiming nothing is checked when something is.
 */
export interface Verifier {
  (item: Item, run: VerifiableRun): Promise<readonly Check[]>;
  /**
   * What this verifier looks at *on this step*, as a column head says
   * it.
   *
   * Phrases rather than sentences, and in the order they are checked:
   * they are joined with commas after "EO checks: ", so each one has to
   * read as an item in a list.
   *
   * **Asked of the step, not declared as a list**, because for one kind
   * the answer genuinely differs per column and getting that wrong is
   * how a head lies. The folder kind checks the files a step *declares*
   * it produces, and a step that declares none is verified with no
   * checks at all — so a fixed phrase there put "EO checks: a file was
   * produced" over a column where nothing was ever going to be checked,
   * and offered a `verification_failed` route for a branch that could
   * never be taken. A kind whose checks do not depend on the step
   * ignores the argument, which is every other kind.
   *
   * Empty is the answer that means "nothing here is checked", and it is
   * read that way everywhere: the head says so, and the editor withholds
   * the route.
   */
  readonly describes: (step: VerifiedStep) => readonly string[];
}

/**
 * What a kind may read of a step in order to say what it would check
 * there (EO-312).
 *
 * A narrow view rather than the `PipelineStep` row, for the reason
 * `VerifiableRun` is a shape of its own: this is asked while a person is
 * *editing* a pipeline, of steps that may never run, and a kind reaching
 * for a step's routes or its position would be describing something
 * other than what it checks. `inputs` is the field this exists for — it
 * is where a folder step names the files it produces.
 */
export type VerifiedStep = Pick<PipelineStep, "id" | "entryAction" | "inputs">;

/**
 * A verifier and the words for it, in one declaration.
 *
 * So that the phrases sit beside the checks they stand for rather than
 * in a table one file away: the failure mode this exists to prevent is a
 * head that says "EO checks: tests ran" over a verifier that stopped
 * running them.
 *
 * A list or a function of the step. The list is the ordinary case — most
 * kinds check the same things wherever they are put — and it is written
 * out rather than made to look like a function so that the one kind
 * whose answer varies is visibly the exception.
 */
export function verifier(
  describes: readonly string[] | ((step: VerifiedStep) => readonly string[]),
  check: (item: Item, run: VerifiableRun) => Promise<readonly Check[]>,
): Verifier {
  return Object.assign((item: Item, run: VerifiableRun) => check(item, run), {
    describes: typeof describes === "function" ? describes : () => describes,
  });
}

/**
 * The key a kind registers under when what it checks does not depend on
 * which action ran (EO-299).
 *
 * A record keyed by action is exactly right for the git kind, whose
 * answer is different for `implement` than for `review` and empty for
 * everything else. It cannot express the `folder` kind, whose question
 * — did the run leave behind the files its *step* declares? — is the
 * same observable question whoever ran and whatever the step was
 * called, over a set of actions nobody can enumerate because a module
 * id is one.
 *
 * So a kind may name actions, or name this. Never both for one action:
 * a named entry wins, which is what lets a kind say "everything, except
 * that this one is special". `*` is not a legal action anywhere — they
 * are slugs and UUIDs — so nothing can claim it by accident.
 */
export const ANY_ACTION = "*";

/**
 * What this kind has to say about this run: the verifier its action
 * names, or nothing.
 *
 * The lookup lives here rather than on each kind so that "no verifier for
 * this action" is answered one way everywhere — a kind lists what it can
 * check and never has to remember to refuse what it cannot.
 */
export async function verifyRun(kind: WorkspaceKind, item: Item, run: VerifiableRun): Promise<readonly Check[]> {
  const verifier = kind.verifiers[run.action] ?? kind.verifiers[ANY_ACTION];
  return verifier === undefined ? [] : verifier(item, run);
}

/**
 * Can this kind check what a run of this action claims?
 *
 * Asked of a step rather than of a run: it is what decides whether
 * `verification_failed` is a result that step could ever report, and
 * therefore whether a route declared for it is wiring or wishful
 * thinking.
 */
export function verifies(kind: WorkspaceKind, action: string): boolean {
  return kind.verifiers[action] !== undefined || kind.verifiers[ANY_ACTION] !== undefined;
}

/**
 * What this kind says it checks for this action, before any run has
 * happened (EO-312, ARCHITECTURE.md, "What 'EO checks' means on a step").
 *
 * The same lookup `verifyRun` makes, answered in words instead of in
 * checks — one function so that a head cannot describe a verifier the
 * run would not reach. Empty for an action with no verifier *and* for a
 * step whose own configuration leaves its verifier nothing to check,
 * which are one answer on a head: "Not checked until Approve".
 */
export function describesChecks(kind: WorkspaceKind, step: VerifiedStep): readonly string[] {
  const action = step.entryAction;
  const named = action === null ? undefined : kind.verifiers[action];
  const found = named ?? kind.verifiers[ANY_ACTION];
  return found === undefined ? [] : found.describes(step);
}

/**
 * Can this kind vouch for anything at all (EO-312)?
 *
 * Asked of the kind rather than of one action, and that is what decides
 * whether a *board* explains itself. A git pipeline's review step has no
 * verifier and needs no explanation: the workspace under it is one EO
 * can speak for, and a developer's board is unchanged. A step on a
 * workspace that can vouch for nothing is a different matter, and it
 * makes every column on that pipeline say where it stands.
 */
export function verifiesAnything(kind: WorkspaceKind): boolean {
  return Object.keys(kind.verifiers).length > 0;
}

/**
 * One thing a kind checked, and how it came out.
 *
 * `describes` is the sentence: it names what was checked and says how it
 * came out, pass or fail, because the column head a person reads is
 * derived from these (ARCHITECTURE.md, "What 'EO checks' means on a step") and "clean" on its own
 * describes nothing.
 * The rest is what the supervisor needs in order to treat a failed check
 * the way the hook it replaced was treated.
 */
export interface Check {
  /** Stable across runs and unique within one `verify`, so a reader can follow one check over time. */
  key: string;
  passed: boolean;
  /** One sentence naming what this checked and how it came out. */
  describes: string;
  /**
   * Does failing this stop the run?
   *
   * True is G-02's verdict: the run fails, the item stays where it is,
   * and the next attempt reads the comment (E-06). False — the default —
   * is a report: the work stands, the item moves, and the thread carries
   * what was noticed. The two were `verifyRun` and the two guards beside
   * it, and the difference between them is exactly this flag.
   */
  blocks?: boolean;
  /**
   * What to post in the thread when it did not pass, where the sentence
   * alone is not enough.
   *
   * Absent leaves `describes` to be posted. The distinction is worth
   * keeping: a verification failure posts a formatted account of every
   * step it ran, and a column head cannot hold that.
   */
  comment?: string;
  /**
   * What the check actually saw, persisted on the run for inspection.
   *
   * `runs.verification` is this, merged over the checks that carry any —
   * which is the same object G-02 has always written there, since the
   * mechanical verification is the one check with anything this size to
   * say.
   */
  evidence?: Record<string, unknown>;
}

/**
 * The run a kind is being asked about.
 *
 * A shape of its own rather than the `Run` row, because two of its
 * fields are not on the row at the moment the question is asked: the run
 * has not been written as succeeded yet — that is the point, a check
 * that fails must be able to stop it — and `workspace` is the prepared
 * value rather than the bare path the row holds.
 */
export interface VerifiableRun {
  id: Uuid;
  action: string;
  /**
   * Whether `action` carries its pack's meaning on this run (EO-422).
   *
   * False when the role that ran it defined the action for itself. A
   * kind that vouches for an action *by name* — the git kind verifies
   * an `implement` against its branch and attaches the diff — is
   * vouching for what the pack means by that name, and a `qa` role's
   * own `implement` promised no commits and no branch. Such a kind asks
   * this beside the name; one registered under `ANY_ACTION` checks what
   * the step declares whoever ran it, and has no reason to.
   *
   * The supervisor's answer, handed in: a kind has no registry to ask.
   * Absent means yes, which is every run before a role could define an
   * action and every caller with no role in hand.
   */
  packAction?: boolean;
  /** Where it worked. */
  workspace: PreparedWorkspace;
  /** What the run claimed, validated against the action's schema. Null when it claimed nothing. */
  result: unknown;
  /**
   * How the run ended, which is what says which checks it deserves.
   *
   * `escalated` is a run that stopped to ask rather than to answer:
   * there is no claim to verify and nothing has moved, and the only
   * thing the git kind has to say about one is whether an implementer
   * asked to propose had written half the change while it proposed.
   */
  ended: "succeeded" | "escalated";
}

/** One item is finished with, everything nothing is working in is, or one run's output has been taken safely out. */
export type ReleaseRequest =
  | {
      what: "collected";
      /**
       * What this run produced is now EO's — copied into the attachment
       * store and posted as the item's output (EO-299).
       *
       * The moment a workspace that exists only to hold a run's output
       * has nothing left to hold. `scratch` removes the directory here,
       * which is the design's "artifacts posts the files and deletes
       * the directory" split in two: the files must still be readable
       * when `artifacts` returns, because the copy happens after it.
       *
       * Never a reason to remove anything a person owns. A folder is
       * somebody's shared drive and a worktree holds a branch, so both
       * ignore this — as does any kind whose disk is not its own to
       * throw away. And never sent at all where a file could not be
       * copied: what is on disk is then the only copy there is.
       */
      item: Item;
      /** Where that run worked, which is the only directory this may touch. */
      workspace: PreparedWorkspace;
    }
  | {
      what: "settled";
      /** The item that has reached a terminal step and will not be dispatched again (G-03). */
      item: Item;
      step: PipelineStep;
    }
  | {
      what: "stale";
      /**
       * Which item keys still have a run behind them.
       *
       * All the supervisor knows to offer. What counts as finished is
       * the kind's judgement — "no active run" is also what an item
       * parked between two steps looks like, and EO-177 is the story
       * about what it cost to treat the two as the same thing.
       */
      hasActiveRun: (itemKey: string) => boolean;
    };

/**
 * Why a release kept something.
 *
 * Posted on the item rather than logged, because a workspace that could
 * not be released usually means work nobody committed. Nothing to say is
 * the ordinary answer.
 */
export interface ReleaseOutcome {
  keptReason?: string;
}

/**
 * Something a run produced, as a person would read it.
 *
 * Deliberately small: a name, a media type and the bytes. EO-298 is what
 * turns one of these into the item's output — a comment of kind
 * `output`, with attachments — and the shape it needs is the shape an
 * attachment already has, not a second description of a file.
 */
interface ArtifactBase {
  /** What kind of thing this is, in the workspace kind's own words: `diff` for git, `file` for a folder or a scratch directory. */
  kind: string;
  /** What to call it where a person sees it. */
  name: string;
  /** IANA media type, so that whatever posts this does not have to guess. */
  mediaType: string;
}

/** Something the run produced that EO holds as text: the git kind's diff. */
export interface TextArtifact extends ArtifactBase {
  /** The thing itself. */
  body: string;
  path?: undefined;
}

/**
 * Something the run produced that is a file on disk (EO-299).
 *
 * The path rather than the bytes, and the difference is not an
 * optimisation. An attachment is a *file* — `attachments.storage_path`,
 * copied into EO's own store — and the things a folder or a scratch run
 * produces are a report, a spreadsheet, a rendered chart. Reading a
 * `.docx` into a JavaScript string and writing it back out again
 * corrupts it, so a shape that could only carry text would have meant
 * every binary deliverable arriving broken, which is the one thing this
 * kind exists to deliver.
 *
 * Whatever posts this copies the file; nothing here holds it open, and
 * the scratch kind deletes its directory only after `artifacts` has
 * been asked for what is in it.
 */
export interface FileArtifact extends ArtifactBase {
  /** An absolute path to the file, readable until whatever posts it has copied it. */
  path: string;
  body?: undefined;
}

export type Artifact = TextArtifact | FileArtifact;
