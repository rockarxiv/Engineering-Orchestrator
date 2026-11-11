import { z } from "zod";

/**
 * Pack state on an item, keyed by the extension that owns it (KAN-148,
 * `ARCHITECTURE.md`, "One work entity").
 *
 * The item row carried four Jira columns — key, id, sync and
 * pull-pending — which are not facts about the item at all: they are one
 * tracker binding's state, kept on the row because the developer pack
 * was the only pack there was. A support pack mirroring to Zendesk would
 * have had to add four more columns to the same table.
 *
 * So an item's own row holds what every item has, and anything a pack
 * knows about it lives in `item_extensions(itemId, extension, data)` —
 * one row per (item, extension), loaded into this map by the read path
 * so that a caller holding an `Item` holds its extensions too.
 *
 * Deliberately `unknown` rather than a union of the shapes core happens
 * to know: core cannot enumerate the packs. Each extension's own
 * accessor is what turns its slot into something typed, which is why
 * nothing anywhere parses this JSON by hand.
 */
export type ItemExtensions = Readonly<Record<string, unknown>>;

/** No pack has said anything about this item. */
export const NO_ITEM_EXTENSIONS: ItemExtensions = Object.freeze({});

/** The developer pack's Jira binding, as it is spelled in `item_extensions.extension`. */
export const JIRA_EXTENSION = "jira";

/**
 * What the four columns became.
 *
 * Same four facts, same meanings, and the field names lose the `jira`
 * prefix the column names carried: inside the `jira` extension, saying
 * it twice is noise.
 *
 * Every field has a default, and the defaults are exactly what the
 * dropped columns defaulted to, because an item with no row here is an
 * item nobody has said anything Jira-shaped about. `sync` in particular
 * is `true` when absent — the column's default since 0054 — so an item
 * that has never touched Jira is not a silenced one.
 */
export const JiraItemStateSchema = z.object({
  /** Which issue this mirrors (J-02, J-03). Null is the normal state. */
  key: z.string().nullable().default(null),
  /** Jira's internal id for that issue. Null until a push or a pull has seen it. */
  id: z.string().nullable().default(null),
  /** Whether EO talks to Jira about this item at all (EO-122). */
  sync: z.boolean().default(true),
  /** Attached to an issue it has not read yet (EO-127) — a one-shot queue marker. */
  pullPending: z.boolean().default(false),
});

export type JiraItemState = z.infer<typeof JiraItemStateSchema>;

/** The state of an item no pack has bound to an issue. */
export const NO_JIRA_STATE: JiraItemState = Object.freeze(JiraItemStateSchema.parse({}));

/**
 * The `jira` extension's payload, typed (KAN-148).
 *
 * The accessor the story asked for, so that no caller reads the JSON
 * itself. Total: an item with no row, an item whose row predates a field
 * and an item whose row is corrupt all answer with the defaults rather
 * than throwing, because every caller of this is in the middle of doing
 * something else — queueing a push, drawing a rail, rendering an item
 * for an agent — and none of them can do anything useful with an
 * exception about a JSON column.
 *
 * **Why this is in `@eo/core` and not in the developer pack**, which is
 * where KAN-148 asked for it. Seven files outside the pack still read an
 * item's Jira state: four `db/repos` (the comment, attachment and
 * transition outbox gates and `itemsRepo`'s own link and sync writes),
 * `ipc/domainQueries.ts` (the detail rail's Jira line), `mcpHost/render.ts`
 * (the item view an agent is shown) and `roles/discussion.ts` (what it
 * says after linking one). None of them may import the pack — invariant
 * 13 and `packs/importAllowlist.test.ts`, which holds the set of files
 * that reach inside it to a list that may not grow — and a db repo
 * importing a pack would be the worst entry that list could gain. Core
 * already carries this vocabulary (`JiraIssueKeySchema`, `ItemView.jiraKey`,
 * the `jira:*` channels), and phase 6 moves all of it into the pack at
 * once when Jira becomes a connector (KAN-139, KAN-144). This goes with
 * it then.
 */
export function jiraStateOf(item: { readonly extensions: ItemExtensions }): JiraItemState {
  return readJiraState(item.extensions[JIRA_EXTENSION]);
}

/** The same read, for the paths that hold the stored payload rather than the item. */
export function readJiraState(data: unknown): JiraItemState {
  if (data === undefined || data === null) return NO_JIRA_STATE;
  const read = JiraItemStateSchema.safeParse(data);
  return read.success ? read.data : NO_JIRA_STATE;
}

/**
 * Whether this state is worth a row.
 *
 * The migration writes a `jira` row only for an item that had something
 * to say — a key, an id, sync switched off or a pull outstanding — and
 * the writes keep that true afterwards by deleting the row when an item
 * goes back to saying nothing. An all-defaults row would be a row
 * asserting silence, which is what the absence of one already means.
 */
export function isDefaultJiraState(state: JiraItemState): boolean {
  return state.key === null && state.id === null && state.sync && !state.pullPending;
}

/**
 * The extensions map for an item in this Jira state — the write side of
 * `jiraStateOf`.
 *
 * Anything absent takes the default the accessor would have given it, so
 * `jiraExtension({ key: "KAN-7" })` is an item attached to KAN-7,
 * syncing, with nothing outstanding. Exists so that the places building
 * an item rather than reading one — the fixtures, and whatever
 * constructs an item in memory next — do not spell the payload out and
 * drift from the schema above.
 */
export function jiraExtension(state: Partial<JiraItemState> = {}): ItemExtensions {
  return { [JIRA_EXTENSION]: { ...NO_JIRA_STATE, ...state } };
}

/** The git workspace kind's state, as it is spelled in `item_extensions.extension`. */
export const GIT_EXTENSION = "git";

/**
 * What the two git columns became (KAN-169, `ARCHITECTURE.md`,
 * "One work entity").
 *
 * The `branch` and `pr_url` columns on `items` are not facts about an
 * item. They
 * are facts about a *git* workspace: which branch was cut for this work
 * and which pull request it opened. An item whose step runs on `none`,
 * or on `folder`, or on `scratch` — three of the four kinds the design adds —
 * would have carried both of them null forever, and the kind that
 * wanted a third fact would have asked the table every item shares for
 * a third column.
 *
 * So they are the `git` slot, on exactly the terms the `jira` slot
 * above already has: one row per item that has something to say, no row
 * for the rest, and this schema's defaults are what an absent row
 * means.
 *
 * **`pr_url` is `pullRequest` here.** The column abbreviated the half
 * that carries the meaning and spelled out the half that does not —
 * everything a workspace publishes a link to is a URL. `currentView.ts`
 * and the MCP host's item view had both already renamed it on their way
 * to a person, which is the tell: the short name was never the one
 * anybody wrote when they had the choice.
 */
export const GitItemStateSchema = z.object({
  /**
   * The branch cut for this item's work, null until a dispatch cuts one.
   *
   * Null is the ordinary state for a container, for a discussion, and
   * for anything that has not been picked up yet — which is why nothing
   * treats its absence as a problem.
   */
  branch: z.string().nullable().default(null),
  /** The pull request EO opened (F-06). Written once; it is what stops a second one. */
  pullRequest: z.string().nullable().default(null),
  /**
   * The branch a person said this item's branch is to be cut from, and
   * its pull request opened against (EO-364). Null — the ordinary state —
   * means the repository's configured base branch, or an unmerged
   * same-feature dependency's branch when the item stacks on one.
   *
   * A person's word rather than EO's working-out, so it wins over
   * stacking: an item that names a base is cut from that base, measured
   * against it and opened against it, and the branch is never rebased
   * onto anything else before its pull request opens.
   *
   * Settable until the item's `branch` is cut and refused after, because
   * from then on where the branch started is in git history and changing
   * this would only make EO's account of it wrong.
   */
  baseBranch: z.string().nullable().default(null),
  /**
   * Whether `branch` is one a person named rather than one EO cut
   * (EO-365). False — the ordinary state — for every branch EO cut as
   * `<prefix>/<key>`.
   *
   * A named branch already exists, locally or on the remote, and it is
   * the person's: Worktree checks it out with every commit on it and
   * never creates, renames, deletes, rebases or force-pushes it. Named
   * until EO first attaches it (`attachedAt` still null) it can be
   * changed or cleared like a base branch; after that it is refused.
   */
  namedBranch: z.boolean().default(false),
  /**
   * The commit a named branch's tip was at when EO first checked it out
   * for this item (EO-365), null until then and for every branch EO cut.
   *
   * What the implementer's commits check counts from. A branch EO cut is
   * measured against its base, because every commit beyond that is this
   * item's work; a branch a person named may carry any number of commits
   * from before EO arrived, and counting those would pass a run that
   * committed nothing.
   */
  attachedAt: z.string().nullable().default(null),
  /**
   * The outside issue this item belongs to — a Jira key, a GitHub
   * issue, anything — as a plain label (EO-637). Null, the ordinary
   * state, means the item names none of its own; a story then reads its
   * feature's (`effectiveReference`).
   *
   * Not a tracker link: nothing about it is pushed to or pulled from any
   * tracker, and any number of items may hold the same value — which is
   * the whole difference from the Jira key, which only one item may
   * hold. Kept with the git state because what it names is the branch
   * and the pull request, and the developer pack reads it where it
   * already reads the branch. Always a value `referenceProblem` accepts.
   */
  reference: z.string().nullable().default(null),
  /**
   * Who is asked to review this item's pull request, in place of the
   * repository's default reviewers (EO-742). Null — the ordinary state —
   * means the item names none of its own: a story then reads its
   * feature's, and a feature or a story under none reads the
   * repository's (`effectiveReviewers`). An empty list means nobody is
   * asked, whatever the repository's default says. Always a list
   * `normaliseReviewers` left as it is.
   */
  reviewers: z.array(z.string()).nullable().default(null),
});

export type GitItemState = z.infer<typeof GitItemStateSchema>;

/** The state of an item no git workspace has touched. */
export const NO_GIT_STATE: GitItemState = Object.freeze(GitItemStateSchema.parse({}));

/**
 * The `git` extension's payload, typed.
 *
 * Total for the same reason `jiraStateOf` is: every caller is in the
 * middle of drawing a card, rendering an item for an agent or deciding
 * what to rebase onto, and none of them can do anything with an
 * exception about a JSON column.
 *
 * **Read by destructuring**, here and at every caller outside
 * `packs/developer/`. What proves this story finished is a grep for the
 * two dropped columns' names across `packages` and `apps/desktop/src`
 * with the pack excluded: a reader still reaching for a column that no
 * longer exists is the failure it is looking for, and text is all it
 * has to go on — a dotted read off this state looks exactly like a read
 * off the row that used to carry it. So the callers say
 * `const { branch } = gitStateOf(item)`, which is also what they would
 * have written anyway at the sites that want one field and name it
 * three times in a sentence.
 *
 * **Why this is in `@eo/core` and not in the git kind**, which is where
 * the story asked for it. The readers that are left outside
 * `packs/developer/` after this change are the ones that cannot import
 * a pack: four in the main process (`itemsRepo`, `domainQueries`,
 * `currentView`, `mcpHost/render`, the outbox's retirement notice) which
 * the import allowlist would have to grow an entry for, and — the one
 * that settles it — the renderer, which shares no module graph with the
 * main process at all and could not import the kind if the allowlist
 * said it might. `@eo/core` is the only place both halves can read, the
 * `jira` accessor above is already there for the narrower version of
 * this reason, and phase 6 moves both into their packs together.
 */
export function gitStateOf(item: { readonly extensions: ItemExtensions }): GitItemState {
  return readGitState(item.extensions[GIT_EXTENSION]);
}

/** The same read, for the paths that hold the stored payload rather than the item. */
export function readGitState(data: unknown): GitItemState {
  if (data === undefined || data === null) return NO_GIT_STATE;
  const read = GitItemStateSchema.safeParse(data);
  return read.success ? read.data : NO_GIT_STATE;
}

/**
 * Whether this state is worth a row.
 *
 * An item with no branch, no pull request, no base branch, no
 * Reference and no reviewers named has had nothing git-shaped happen to it, which is what
 * no row already says.
 */
export function isDefaultGitState(state: GitItemState): boolean {
  const { branch, pullRequest, baseBranch, namedBranch, attachedAt, reference, reviewers } = state;
  return (
    branch === null && pullRequest === null && baseBranch === null && !namedBranch && attachedAt === null && reference === null && reviewers === null
  );
}

/**
 * The branch that already exists for this item in git, or null while
 * none does (EO-365).
 *
 * A branch EO cut is in git the moment `branch` is written. A branch a
 * person named is a name on the item until Worktree first attaches it
 * (`attachedAt`), and until then it can still be changed or cleared, and
 * a base branch set beside it — the same "until a branch is cut" rule a
 * base branch has always had, asked of the one thing that answers it.
 */
export function branchInGit(state: GitItemState): string | null {
  const { branch, namedBranch, attachedAt } = state;
  if (branch === null) return null;
  return namedBranch && attachedAt === null ? null : branch;
}

/**
 * The branch a person named for this item, or null when EO cuts its own
 * (EO-365).
 */
export function namedBranchOf(state: GitItemState): string | null {
  const { branch, namedBranch } = state;
  return namedBranch ? branch : null;
}

/**
 * The extensions map for an item in this git state — the write side of
 * `gitStateOf`, and what the fixtures build items with.
 */
export function gitExtension(state: Partial<GitItemState> = {}): ItemExtensions {
  return { [GIT_EXTENSION]: { ...NO_GIT_STATE, ...state } };
}

/**
 * Why `name` cannot be a branch to cut from, or null when it could be
 * (EO-364).
 *
 * A subset of `git check-ref-format`'s rules — enough to turn away a
 * sentence, a path fragment or a control character typed where a branch
 * name was asked for, and permissive enough never to turn away a name
 * git would take. Whether the branch actually *exists* is not something
 * a string can say: the remote is asked that when the branch is cut, and
 * a name it does not have is refused there, naming the remote.
 *
 * Shared by every door a base branch arrives through — a proposal, a
 * submitted plan, an edit from the item screen or an agent — so that
 * the same name is not accepted by one and refused by another.
 */
export function branchNameProblem(name: string): string | null {
  const text = name.trim();
  if (text === "") return "A branch name cannot be empty.";
  const refused = `"${text}" is not a branch name git would accept`;
  if (text.length > 255) return `${refused}: it is longer than 255 characters.`;
  if (/\s/.test(text)) return `${refused}: it contains a space.`;
  if (/[~^:?*[\\]/.test(text)) return `${refused}: it contains one of ~ ^ : ? * [ \\.`;
  if (text.includes("..") || text.includes("@{") || text.includes("//")) return `${refused}: it contains "..", "@{" or "//".`;
  if (text.startsWith("/") || text.startsWith("-") || text.startsWith(".")) return `${refused}: it starts with "/", "-" or ".".`;
  if (text.endsWith("/") || text.endsWith(".") || text.endsWith(".lock")) return `${refused}: it ends with "/", "." or ".lock".`;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return `${refused}: it contains a control character.`;
  }
  return null;
}

/**
 * Why `value` cannot be an item's Reference, or null when it can be
 * (EO-637).
 *
 * A Reference stands inside a branch name — `<prefix>/<Reference>-<key>`
 * — so it is refused for anything that could not appear there: a space
 * or other whitespace, `..`, `~`, `^`, `:`, `?`, `*`, `[`, `\`, `@{`,
 * `//`, a leading `-` or `/`, a trailing `.` or `/`, or a part between
 * slashes that starts with `.` or ends with `.lock`. Asked of the trimmed value; an
 * empty one is clearing rather than a problem, and is the caller's to
 * read as such.
 */
export function referenceProblem(value: string): string | null {
  const text = value.trim();
  if (text === "") return null;
  const refused = `"${text}" cannot be a Reference, because a Reference has to fit in a git branch name`;
  if (/\s/.test(text)) return `${refused} and it contains ${text.includes(" ") ? "a space" : "whitespace"}.`;
  const character = /[~^:?*[\\]/.exec(text);
  if (character !== null) return `${refused} and it contains "${character[0]}".`;
  for (const sequence of ["..", "@{", "//"]) if (text.includes(sequence)) return `${refused} and it contains "${sequence}".`;
  if (text.startsWith("-") || text.startsWith("/")) return `${refused} and it starts with "${text[0] ?? ""}".`;
  if (text.endsWith(".") || text.endsWith("/")) return `${refused} and it ends with "${text.at(-1) ?? ""}".`;
  // Each part between slashes is a path component of the branch, and git
  // takes none that starts with "." or ends with ".lock".
  for (const part of text.split("/")) {
    if (part.startsWith(".")) return `${refused} and its part "${part}" starts with ".".`;
    if (part.endsWith(".lock")) return `${refused} and its part "${part}" ends with ".lock".`;
  }
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return `${refused} and it contains a control character.`;
  }
  return null;
}

/**
 * An item's Reference as it takes effect, and where it came from
 * (EO-637).
 *
 * `inheritedFrom` is null when the item names it itself, and otherwise
 * the key of the parent it is read from — which is what lets the item
 * page say a value is inherited, and what tells a later reader the
 * item's own Reference apart from its feature's when they rank
 * differently.
 */
export const ItemReferenceSchema = z.object({
  value: z.string(),
  inheritedFrom: z.string().nullable(),
});

export type ItemReference = z.infer<typeof ItemReferenceSchema>;

/**
 * The Reference that names this item's work: its own, or else its
 * parent's, or null when neither names one (EO-637).
 *
 * One level, and from the parent's *own* Reference: a container is the
 * top of the tree, so there is nothing for it to inherit in turn.
 * Read live rather than copied down, so changing a feature's Reference
 * changes what every story under it without one of its own reads.
 */
export function effectiveReference(
  item: { readonly extensions: ItemExtensions },
  parent: { readonly key: string; readonly extensions: ItemExtensions } | null | undefined,
): ItemReference | null {
  const { reference } = gitStateOf(item);
  if (reference !== null) return { value: reference, inheritedFrom: null };
  if (parent === null || parent === undefined) return null;
  const inherited = gitStateOf(parent).reference;
  return inherited === null ? null : { value: inherited, inheritedFrom: parent.key };
}

/**
 * `ItemReviewers.inheritedFrom` when the list is the repository's
 * default (EO-742). Never an item key, which always carries a dash.
 */
export const REVIEWERS_FROM_REPOSITORY = "repository";

/**
 * An item's pull request reviewers as they take effect, and where they
 * came from (EO-742).
 *
 * `inheritedFrom` is named as `ItemReference.inheritedFrom` is: null
 * when the item names the list itself, the parent's key when it is the
 * parent's, and `REVIEWERS_FROM_REPOSITORY` when it is the repository's
 * default. `value` may be empty, which asks nobody.
 */
export const ItemReviewersSchema = z.object({
  value: z.array(z.string()),
  inheritedFrom: z.string().nullable(),
});

export type ItemReviewers = z.infer<typeof ItemReviewersSchema>;

/**
 * Who is asked to review the pull request this item opens: its own
 * list, or else its parent's own, or else `repositoryDefault` (EO-742).
 *
 * Shaped as `effectiveReference` is — one level, the parent's *own*
 * list, read live — with the repository as the last place to look. A
 * list that is set and empty stops the search: it says nobody, which is
 * different from saying nothing. `repositoryDefault` is `[]` for an item
 * on no git repository.
 */
export function effectiveReviewers(
  item: { readonly extensions: ItemExtensions },
  parent: { readonly key: string; readonly extensions: ItemExtensions } | null | undefined,
  repositoryDefault: readonly string[],
): ItemReviewers {
  const { reviewers } = gitStateOf(item);
  if (reviewers !== null) return { value: [...reviewers], inheritedFrom: null };
  const inherited = parent === null || parent === undefined ? null : gitStateOf(parent).reviewers;
  if (inherited !== null && parent) return { value: [...inherited], inheritedFrom: parent.key };
  return { value: [...repositoryDefault], inheritedFrom: REVIEWERS_FROM_REPOSITORY };
}
