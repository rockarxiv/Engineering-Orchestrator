import { z } from "zod";

/**
 * A repository index, as it crosses every boundary (EO-145).
 *
 * The row in `repository_indexes` and the object the renderer is handed
 * are the same object, defined once here, for the reason the
 * conventions give: anything crossing IPC is described by a zod schema
 * in this package rather than by a hand-written interface on each side
 * that has to be kept in step.
 *
 * What this describes is *metadata* and nothing else. The index itself
 * — the graph of symbols, callers and imports — is a directory on disk
 * under the provider's control, disposable, and never in `eo.db`. This
 * is the note saying that directory exists, what built it, what commit
 * it was built from and whether it can be trusted; throwing it away and
 * rebuilding is always a legal answer, which is why nothing here is
 * worth migrating.
 *
 * Deliberately absent: any word about *which* implementation is
 * underneath. `provider` is an opaque identifier, `providerVersion` an
 * opaque string, and neither is compared to a constant anywhere outside
 * the implementation that wrote it.
 */

/**
 * Where an index is in its life.
 *
 * Six states, and the pairs matter. `indexing` is a first build from
 * nothing; `updating` is an incremental pass over an index that is
 * already usable, which is why an agent dispatched during one still
 * gets answers and an agent dispatched during the other does not.
 * `stale` and `failed` are likewise different: `stale` means the note
 * is out of date and a rebuild will fix it, `failed` means the last
 * attempt did not produce anything and the reason is in `errorMessage`.
 *
 * Lowercase because that is what every other status column in this
 * schema holds (`runs.status`, `comment_mentions.status`), not because
 * the states are named differently from how EO-145 wrote them.
 */
export const RepositoryIndexStatusSchema = z.enum(["not_indexed", "indexing", "ready", "updating", "stale", "failed"]);
export type RepositoryIndexStatus = z.infer<typeof RepositoryIndexStatusSchema>;

/** The one status in which an index may be queried. Named, because three modules ask the same question. */
export const REPOSITORY_INDEX_QUERYABLE: RepositoryIndexStatus = "ready";

export const RepositoryIndexSchema = z.object({
  id: z.string(),
  /**
   * The workspace whose checkout this index describes.
   *
   * The workspace and not the project, settled on EO-141 and unchanged
   * by KAN-130: a story carries `items.workspaceId` while a feature does
   * not, and a project spanning three checkouts would index them as one
   * and leave a story unable to find its own.
   */
  workspaceId: z.string(),
  /**
   * Which item's checkout this index describes, or null for the
   * repository's own baseline.
   *
   * Nullable and unused in this version. It is here so that adding a
   * baseline later is a new row rather than a migration that changes
   * what an existing row means.
   */
  itemId: z.string().nullable(),
  /**
   * Which implementation built it — an opaque identifier.
   *
   * Stored rather than assumed, because an index built by one
   * implementation is not readable by another: a row whose `provider`
   * is not the one now configured is not a stale index, it is somebody
   * else's index, and the answer is to remove it.
   */
  provider: z.string(),
  /** The directory the index lives in. Owned by the provider and disposable. */
  indexPath: z.string(),
  status: RepositoryIndexStatusSchema,
  /** The commit the index was built from, when the provider records one. */
  indexedCommitSha: z.string().nullable(),
  /** When a build last succeeded. Null until one has. */
  indexedAt: z.number().nullable(),
  /** When this row last changed, whatever the change was. */
  updatedAt: z.number().nullable(),
  /**
   * The version of the implementation that built it.
   *
   * The whole of EO's answer to version skew. An index is disposable,
   * so a binary that has moved on from what this says is answered by
   * rebuilding rather than by any logic that reads an old index's
   * shape — which is why there will never be a migration for one.
   */
  providerVersion: z.string().nullable(),
  /**
   * Why the last attempt did not work, in the words shown to a person.
   *
   * Null while nothing has gone wrong. Carried by `failed`, which is a
   * build that produced no index at all, and by the `stale` a failed
   * handover sync leaves behind (EO-153) — there the index is still on
   * disk and the sentence says why EO stopped vouching for it.
   */
  errorMessage: z.string().nullable(),
  /**
   * How long the last sync took, in milliseconds, and how many files it
   * reported changing (EO-153).
   *
   * Here because the question this whole feature exists to answer — is a
   * persistent index worth what rediscovering the repository every time
   * costs — is a question about numbers, and the measurement story cannot
   * ask it of something nobody wrote down. `scripts/index-benefit.mts`
   * is the command that asks it.
   *
   * A handover sync is the recurring cost: the initial build happens
   * once per worktree, and this is what is paid at every handover after
   * it.
   *
   * Both null until a sync has succeeded, and both describe the *last*
   * one rather than accumulating. A total would be a second thing to
   * keep in step with a row that is rewritten whenever the index is
   * rebuilt, and a running sum nobody can attribute to a handover is not
   * a measurement — it is a number.
   *
   * Written only by a sync. A build from nothing reports no changed-file
   * count on purpose (there, "changed" means "all of them" and answers
   * nothing anyone asked), so recording its duration under a name that
   * says sync would make the two indistinguishable to whoever reads
   * this next.
   */
  lastSyncDurationMs: z.number().nullable(),
  /**
   * How many files the last sync reported changing.
   *
   * The implementation's count, never EO's. A worktree carries
   * uncommitted work that a commit-to-commit diff would miss entirely,
   * and the thing that just walked the tree already knows the answer —
   * so EO records what it is told rather than computing a second number
   * that would disagree.
   */
  lastSyncChangedFiles: z.number().nullable(),
  /**
   * How long the last build *from nothing* took, in milliseconds
   * (EO-155).
   *
   * The other half of what a sync records, and separate from it for the
   * reason `lastSyncDurationMs` gives at length: the two are different
   * costs and a single column would make them indistinguishable to
   * whoever read it. `indexing` is a build from nothing and
   * `updating` is a pass over one that already exists — the same pair
   * the status enum draws — so the two durations are named after the
   * two statuses rather than after the one method that returns both.
   *
   * It is the *once per worktree* cost. An item pays it at
   * `create_worktree` time and then pays `lastSyncDurationMs` at every
   * handover after it, and the measurement cannot say whether the
   * feature is worth its wall-clock without both.
   *
   * Null until a build has succeeded, and left standing by a sync — a
   * handover does not rebuild anything, so it has nothing to say here.
   */
  lastIndexDurationMs: z.number().nullable(),
  /**
   * How much disk the index occupies, in bytes, as of the last
   * successful build or sync (EO-155).
   *
   * Recorded rather than measured on demand, because the directory is
   * inside an item's worktree and the worktree is released when the
   * item finishes. A report that stat'ed the path would answer for
   * every live index and for none of the ones worth comparing.
   *
   * The implementation's own account of the directory it owns. What
   * counts as "the index" is the provider's business — EO never composes
   * that path itself and never walks it.
   */
  indexSizeBytes: z.number().nullable(),
});

export type RepositoryIndex = z.infer<typeof RepositoryIndexSchema>;

/**
 * The rollout switch, as it crosses IPC (EO-148).
 *
 * The whole feature ships behind this and it defaults off, so the
 * shipped behaviour of a build carrying every story in EO-141 is the
 * behaviour of a build carrying none of them until somebody says
 * otherwise.
 *
 * Two fields rather than one: whether EO does this at all, and which
 * implementation it does it with. The second is not a convenience — a
 * flag that could only be on or off would make "replace the provider"
 * an edit to a constant, which is the thing this feature's architecture
 * exists to avoid.
 *
 * It is not part of `settings:get`/`settings:set`, and `mcpHost/gate.ts`
 * gives the reason in full: that channel carries a closed object of
 * preferences shared with the inbox's Do Not Disturb toggle, and a
 * screen should only be able to change the setting it is showing.
 */
export const RepositoryIntelligenceConfigSchema = z.object({
  /**
   * Off until somebody turns it on, on the machine EO is running on.
   *
   * Read at call time everywhere, never cached at startup, so flipping
   * it takes effect on the next dispatch rather than the next launch.
   */
  enabled: z.boolean(),
  /**
   * Which implementation builds and answers the index.
   *
   * A free string rather than an enum, matching `RepositoryIndex.provider`
   * and for the same reason: EO stores this, hands it to whatever is
   * registered under that name, and never interprets it. An enum here
   * would put the list of possible implementations in the one package
   * that is supposed to know least about them.
   */
  provider: z.string().min(1),
});

export type RepositoryIntelligenceConfig = z.infer<typeof RepositoryIntelligenceConfigSchema>;

/** A partial update, for the reason `settings:set` gives: a screen changes only what it is showing. */
export const RepositoryIntelligenceConfigPatchSchema = RepositoryIntelligenceConfigSchema.partial();

export type RepositoryIntelligenceConfigPatch = z.infer<typeof RepositoryIntelligenceConfigPatchSchema>;

/**
 * The implementation EO ships with, and the value `provider` defaults to.
 *
 * A string constant in a package that names no implementation anywhere
 * else. That is deliberate and it is the line the architectural test
 * draws: storing the id is data, importing the module is a dependency.
 * The default has to be *some* id — a config naming nothing would leave
 * an enabled feature with nowhere to send the work — and this is the
 * only one that exists.
 */
export const DEFAULT_REPOSITORY_INTELLIGENCE_PROVIDER = "codewiki";

/**
 * The ids a settings screen offers, which is not the same as the ids EO
 * would accept.
 *
 * Here so the one screen that sets this can render a choice rather than
 * a free-text box, and separate from the schema so that a provider
 * nobody has put in this list — one under a flag, one somebody is
 * trying out — is still a legal stored value.
 */
export const REPOSITORY_INTELLIGENCE_PROVIDER_IDS: readonly string[] = [DEFAULT_REPOSITORY_INTELLIGENCE_PROVIDER];

/**
 * One index as the settings screen is handed it (EO-154).
 *
 * The stored row plus the two things a person needs to know *which*
 * index they are looking at and the row cannot say on its own: the
 * item's key, because `itemId` is a uuid nobody recognises, and the
 * checkout it describes, because the row holds where the *index* is and
 * only the main process knows where the worktree that it came from
 * lives.
 *
 * Both nullable, and neither is an error. `itemKey` is null for a
 * repository's own baseline, which nothing writes yet. `workspacePath`
 * is null when the checkout has gone — a released worktree leaves the
 * note behind, and a screen that hid it would leave a person with no
 * account of an index they can still see failing.
 *
 * Still nothing here names an implementation. `provider` and
 * `providerVersion` travel because a debug area shows them; they are
 * opaque strings on this side of the wire as much as on the other.
 */
export const RepositoryIndexViewSchema = RepositoryIndexSchema.extend({
  /** The item whose checkout this describes, by its key. Null for a repository's own baseline. */
  itemKey: z.string().nullable(),
  /** The checkout the index describes, or null when EO can no longer say where it is. */
  workspacePath: z.string().nullable(),
  /**
   * Whether a run is working in that checkout right now.
   *
   * Here so the screen can say why Rebuild is refused *before* somebody
   * presses it. Rebuilding deletes the index directory out from under
   * whatever is querying it, so it waits for the run to finish — and a
   * disabled button with a sentence beside it is a better account of
   * that than a failure after the fact.
   */
  inUse: z.boolean(),
});

export type RepositoryIndexView = z.infer<typeof RepositoryIndexViewSchema>;

/**
 * A repository and every index EO holds a note about for it.
 *
 * A display grouping, and it keeps the word the screen shows: the id is
 * a workspace's, which the Repositories screen calls a repository
 * (KAN-130).
 */
export const RepositoryIndexGroupSchema = z.object({
  repositoryId: z.string(),
  repositoryName: z.string(),
  indexes: z.array(RepositoryIndexViewSchema),
});

export type RepositoryIndexGroup = z.infer<typeof RepositoryIndexGroupSchema>;

/**
 * The state of repository intelligence on this machine: the switch, and
 * what it has produced (EO-154).
 *
 * One object rather than two, and it is what both
 * `repositoryIntelligence:getConfig` and `:setConfig` answer with. The
 * screen showing the switch is the screen showing the statuses — they
 * are the same section, a person reading one is deciding about the other,
 * and a status list that arrived on a channel of its own would be a
 * second round trip for one screen's worth of state.
 *
 * It also keeps EO's whole index surface at three operations. The three
 * things a person can *do* to an index each have a channel; looking at
 * one is not one of them, and folding the read in here is what stops
 * "show me" turning into a fourth verb.
 *
 * `repositories` is every repository EO knows, including the ones with
 * no index at all. A listing of only what exists cannot say "this has
 * never been indexed", which is the state somebody opening this section
 * is most likely trying to explain.
 */
export const RepositoryIntelligenceStatusSchema = RepositoryIntelligenceConfigSchema.extend({
  repositories: z.array(RepositoryIndexGroupSchema),
});

export type RepositoryIntelligenceStatus = z.infer<typeof RepositoryIntelligenceStatusSchema>;

/**
 * What a repository index operation did.
 *
 * `problem` rather than a thrown error, for the reason the whole
 * subsystem gives: a missing binary, an unsupported platform and a build
 * that fell over are ordinary outcomes here. The screen shows the
 * sentence in place rather than blanking out, and `index` comes back so
 * it can render the new status without a second round trip.
 */
export const RepositoryIndexActionSchema = z.object({
  ok: z.boolean(),
  index: RepositoryIndexViewSchema.nullable(),
  problem: z.string().nullable(),
});

export type RepositoryIndexAction = z.infer<typeof RepositoryIndexActionSchema>;

/**
 * Which index an operation is about: EO's own note, by its id.
 *
 * Deliberately not a repository, an item, a path or a provider. The row
 * is what the screen was handed and the row is what it names back;
 * everything the operation needs — which checkout, which implementation
 * — is derived in the main process from that one id. A payload carrying
 * a path would let a screen point an indexer at a directory of its
 * choosing, and a payload carrying a provider would put the choice of
 * implementation in front of a person who was promised they would never
 * have to think about it.
 */
export const RepositoryIndexRefSchema = z.object({ id: z.string().min(1) });

export type RepositoryIndexRef = z.infer<typeof RepositoryIndexRefSchema>;
