import { z } from "zod";

/**
 * What a workspace is, as it crosses every boundary (KAN-130,
 * ARCHITECTURE.md, "A workspace is a kind, attached to the project").
 *
 * A workspace is the disk a run happens on, attached to a project. It
 * replaces `repositories` — which was four things at once: the item key
 * prefix (moved to the project in KAN-128), the test, lint and build
 * commands, eight Jira columns and five forge columns. Only the commands
 * and the forge settings were ever facts about the *workspace*; the Jira
 * columns were a connector binding on the project and live in
 * `connector_bindings` now.
 *
 * The row is `(id, projectId, kind, config, position)` and the *kind*
 * says how to read `config`. One kind exists today — `git-worktree`,
 * exactly the behaviour `repositories` described. `folder`, `scratch`
 * and `none` arrive with the kinds that implement the interface EO-295
 * introduced, which is why `config` is JSON rather than columns: a
 * second kind must cost a registry entry and no migration.
 */

/**
 * The slug a workspace row names its kind by.
 *
 * A plain string, and that is the whole of what the core may say about
 * it (EO-295): a kind is a *value an installed pack contributes* —
 * `WorkspaceKind` in `supervisor/workspaceKind.ts`, five methods and a
 * slug — so the set of legal slugs is whatever is installed at the
 * moment the row is read. It was a closed `z.enum` for one story, while
 * `git-worktree` was the only kind and the interface did not exist yet;
 * keeping it closed now would mean a pack could contribute a kind the
 * database refuses to describe, which is the same mistake the migration
 * declined to make when it left the column without a CHECK constraint.
 *
 * Unresolvable slugs are therefore a runtime fact rather than a parse
 * error, and the supervisor is where one is met: a workspace naming a
 * kind nothing installed prepares no disk of its own.
 */
export type WorkspaceKindSlug = string;

/** The kind the developer pack ships. Named, so that a reader is never comparing to a loose string. */
export const GIT_WORKTREE_KIND: WorkspaceKindSlug = "git-worktree";

/**
 * The `git-worktree` kind's configuration — a repository EO drives.
 *
 * Every field is one of the `repositories` columns that genuinely
 * described the checkout: where it is, what it branches from, how work
 * in it is verified, and how a pull request is opened. The names are the
 * column names so that the migration is a transcription and a reader of
 * either can find the other.
 *
 * Defaults spelled here rather than at the call sites: `config` is JSON,
 * so nothing in the database refuses a row that leaves a key out, and a
 * workspace written by an older version of EO must still parse.
 */
export const GitWorkspaceConfigSchema = z.object({
  name: z.string(),
  /**
   * Prose describing what this repository is, for the product owner
   * (KAN-17).
   *
   * On a project spanning several workspaces this is the whole basis on
   * which a story is routed to one, so it wants to read like "the Go
   * payments service", not "backend".
   */
  description: z.string().nullable().default(null),
  repoPath: z.string(),
  baseBranch: z.string().default("main"),
  testCommand: z.string().nullable().default(null),
  lintCommand: z.string().nullable().default(null),
  buildCommand: z.string().nullable().default(null),
  /**
   * Opening pull requests (F-06). Off by default: pushing to a
   * repository other people share is not something an upgrade should
   * start doing unasked.
   */
  forgeOpenPr: z.boolean().default(false),
  /** null = work it out from the remote. Set explicitly when the guess is wrong. */
  forgeKind: z.enum(["github", "gitlab"]).nullable().default(null),
  forgeRemote: z.string().default("origin"),
  forgeDraft: z.boolean().default(false),
  /** Only for a template directory holding several choices. */
  forgeTemplatePath: z.string().nullable().default(null),
  /**
   * Who is asked to review a pull request EO opens here, unless the item
   * names its own (EO-741). Forge handles — a GitHub login, a GitHub
   * `org/team`, a GitLab username — stored as `normaliseReviewers` left
   * them. Empty asks nobody, which is what EO did before the field.
   */
  forgeReviewers: z.array(z.string()).default([]),
});

export type GitWorkspaceConfig = z.infer<typeof GitWorkspaceConfigSchema>;

/**
 * A list of pull request reviewers as it is stored (EO-741).
 *
 * Each entry is trimmed, blanks are dropped and a repeat is dropped in
 * favour of its first appearance. An entry with whitespace or a comma
 * inside it refuses the whole list rather than being split or skipped:
 * a forge CLI takes the list comma-separated, so `alice,bob` saved as one
 * reviewer would ask for two people nobody listed apart, and dropping it
 * quietly would leave a person believing somebody is being asked.
 */
export function normaliseReviewers(entries: readonly string[]): { ok: true; reviewers: string[] } | { ok: false; problem: string } {
  const reviewers: string[] = [];
  for (const entry of entries) {
    const handle = entry.trim();
    if (handle === "") continue;
    if (/[\s,]/.test(handle)) {
      return {
        ok: false,
        problem:
          `"${handle}" is not a reviewer EO can ask for: a reviewer is one forge handle — a GitHub login, a GitHub ` +
          `org/team or a GitLab username — with no space or comma in it. Give each reviewer as its own entry.`,
      };
    }
    if (!reviewers.includes(handle)) reviewers.push(handle);
  }
  return { ok: true, reviewers };
}

/**
 * How a `git-worktree` workspace is used by one step (EO-296,
 * ARCHITECTURE.md, "The four kinds").
 *
 * A mode of the git kind rather than a fifth kind, and the reason is a
 * person's mental model: what they attached is *their repository*, and
 * two entries in a picker called "Repository" and "Repository (read
 * only)" read like a mistake somebody made rather than like a choice.
 * So the picker offers one repository and the step editor offers a
 * segmented control over it — "Works on a branch" or "Reads only".
 *
 * - `isolated` is exactly today's behaviour: a branch cut per item, a
 *   worktree of its own, verification against that tree.
 * - `read` is the repository's own checkout, handed over as it stands
 *   with no branch cut. Discussions, the assistant and a container item
 *   have worked this way since issue #148; until this story it was three
 *   unnamed branches inside `createWorktreeWorkspace` rather than a mode
 *   anybody could choose.
 *
 * Read mode is not enforced *here*: the working copy is shared with the
 * person, and what stops an agent writing to it is its own tool
 * allowlist, exactly as before.
 */
export const WorkspaceModeSchema = z.enum(["isolated", "read"]);
export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>;

/** What a step means when it says nothing: a branch of its own, which is what every step did before modes existed. */
export const DEFAULT_WORKSPACE_MODE: WorkspaceMode = "isolated";

/**
 * No disk at all — a real kind, not the absence of one (EO-296,
 * ARCHITECTURE.md, "The four kinds").
 *
 * The agent works through MCP servers and connectors, and its cwd is an
 * empty directory of its own. Until this story a run with nowhere to
 * work fell to *EO's own launch directory* with a note in the thread
 * explaining that it had: for a packaged app that is not a checkout of
 * anything and frequently not a git repository at all, so a provider
 * that checks it is inside a trusted repository refused before the agent
 * started.
 *
 * Naming it makes the absence something the person sees on the card —
 * the "no disk" badge — rather than something an agent discovers, which
 * is invariant 12's spirit applied to a workspace.
 *
 * The one kind the core ships itself. Every other kind is a pack's, and
 * a core with no pack installed still has somewhere to put a run.
 */
export const NONE_KIND: WorkspaceKindSlug = "none";

/**
 * A directory that is already there — the shared drive, the reports
 * folder (EO-299, ARCHITECTURE.md, "The four kinds").
 *
 * The kind for work that is not code: a marketing manager's report
 * drafted from a folder of CSVs, a content team writing on a drive
 * everyone can see. Nothing is cut, branched or cloned; the agent is
 * pointed at a directory that exists and writes in it, and what it wrote
 * is the deliverable rather than a commit describing one.
 *
 * `perItemSubfolder` is the difference between a team's drive and one
 * item's drawer in it. Off, every item on this workspace works in the
 * same directory — which is what a shared drive *is*, and why the
 * capacity key is the workspace rather than the item. On, each item gets
 * `<path>/<its key>`, so two reports being drafted at once do not
 * overwrite one another's files; the capacity key stays the workspace
 * all the same, because the subfolders share a filesystem and the cap
 * exists for what two runs would collide in rather than for what they
 * usually do not.
 *
 * Off by default, because that is the folder somebody attached rather
 * than a layout EO invented under it.
 */
export const FolderWorkspaceConfigSchema = z.object({
  /** An absolute path to a directory that exists. Checked when the workspace is created, not when a run reaches it. */
  path: z.string(),
  perItemSubfolder: z.boolean().default(false),
});

export type FolderWorkspaceConfig = z.infer<typeof FolderWorkspaceConfigSchema>;

/** The kind that works in a directory somebody already has. */
export const FOLDER_KIND: WorkspaceKindSlug = "folder";

/**
 * A directory per run, and nothing afterwards (EO-299,
 * ARCHITECTURE.md, "The four kinds").
 *
 * Somewhere to work when the work itself is the answer rather than
 * something to keep: a report drafted from what the agent was told, a
 * chart rendered to be looked at once. What it produced becomes the
 * item's output and the directory goes, so nothing accumulates on a
 * disk nobody chose and no second run inherits the first one's mess.
 *
 * No configuration at all, which is why there is no schema for it. A
 * temporary directory has nothing for a person to decide: where it is
 * is EO's business, how long it lasts is "until the run's output is
 * posted", and a setting for either would be a promise to honour it.
 */
export const SCRATCH_KIND: WorkspaceKindSlug = "scratch";

/**
 * What a *step* means when it names no workspace of its own (EO-301).
 *
 * A step picks among the project's workspaces (ARCHITECTURE.md, "A workspace is a kind, attached to
 * the project"), and the
 * picker has three answers rather than two. Two of them are ordinary —
 * a workspace id, or this sentinel — and the third is the absence of
 * either: `null`, "whatever the ticket is on", which is what every step
 * did before a step could pick at all and therefore what every existing
 * row means. Making `null` mean "no disk" would have been a migration
 * that silently took the repository away from every step in every
 * installation.
 *
 * So "no disk, deliberately" needs a value of its own, and it is the
 * `none` kind's slug stored where a workspace id goes. A sentinel in an
 * id column is not a new idea here: `step_routes.target` has held
 * `user_attention` and `terminal` beside step ids since routing was
 * data, and for the same reason — the column answers "where", and two
 * of the answers are not rows.
 *
 * That is also why `pipeline_steps.workspace_id` carries no foreign
 * key: a constraint would reject this value outright. What a key would
 * have bought — no step left pointing at a workspace that is gone — is
 * bought instead by `deleteWorkspace`, which clears the picks it
 * orphans, so the step falls back to the ticket's workspace rather than
 * to nothing.
 */
export const NO_WORKSPACE: WorkspaceKindSlug = NONE_KIND;

/**
 * Which workspace a step's run happens on, given what the step picked.
 *
 * Three answers and one function, because the picker, the resolver and
 * the validator have to agree about them: a step editor offering "No
 * disk" over a resolver that read the same value as an id would be two
 * readings of one column, which is the shape of bug the design spent a
 * paragraph on for the cwd fallback.
 *
 * - `inherit` — the step said nothing. The ticket's own workspace
 *   answers, then its project's first, exactly as before EO-301.
 * - `none` — the step said "no disk" out loud. No workspace, whatever
 *   the ticket is on.
 * - `{ workspaceId }` — the step named one.
 */
export type StepWorkspaceChoice = { pick: "inherit" } | { pick: "none" } | { pick: "workspace"; workspaceId: string };

export function stepWorkspaceChoice(workspaceId: string | null): StepWorkspaceChoice {
  if (workspaceId === null) return { pick: "inherit" };
  if (workspaceId === NO_WORKSPACE) return { pick: "none" };
  return { pick: "workspace", workspaceId };
}

/**
 * What an input on a step names when it lists the files that step is
 * expected to leave behind (EO-299).
 *
 * The `folder` kind's verifier reads it: relative paths, separated by
 * newlines or commas, and each one becomes a check that says whether
 * that file is there and whether this run is what put it there. It
 * rides on `pipeline_steps.inputs` — the JSON a step already carries for
 * the module it runs — rather than on a column of its own, because
 * "what this step produces" is a property of the step's *configuration*
 * in exactly the way an input is, and a column would have to be
 * explained to every kind that has no use for it.
 *
 * Named here rather than spelled at the two sites that read it so that
 * the verifier and the editor that will one day offer the field cannot
 * drift apart over a string.
 */
export const STEP_OUTPUTS_INPUT = "outputs";

/**
 * A kind's configuration as it comes off the row, parsed by whichever
 * kind named it (EO-299).
 *
 * Three shapes and a fourth that is deliberately not a shape. Git and
 * folder have schemas; `scratch` and `none` have nothing to configure;
 * and a kind an installed pack contributed has a configuration this
 * package has never heard of, which is kept exactly as it was found —
 * see `parseWorkspaceConfig` for why that last one matters more than it
 * looks.
 */
export type UnknownWorkspaceConfig = Record<string, unknown>;

export type WorkspaceConfig = GitWorkspaceConfig | FolderWorkspaceConfig | UnknownWorkspaceConfig;

/**
 * The `config` column, read as the kind that wrote it means it
 * (EO-299).
 *
 * Every workspace row was parsed with the git schema until this story,
 * which was true while `git-worktree` was the only kind and becomes a
 * row that cannot be *read* the moment a second one exists: the git
 * schema requires a name and a repository path, and a folder has
 * neither. So the slug picks the parser, exactly as it picks the five
 * methods that will act on the result.
 *
 * **An unknown kind keeps its configuration rather than losing it.** A
 * pack may contribute a kind with settings of its own, and this package
 * has no schema for one — but `updateWorkspace` is a read-modify-write
 * over this value, so a parser that answered `{}` for anything it did
 * not recognise would quietly empty a pack kind's config the first time
 * somebody changed that workspace's position. Unrecognised config is
 * therefore passed through as it was found, and a row holding something
 * that is not an object at all reads as `{}` — the honest answer for a
 * value nothing can be made of.
 */
export function parseWorkspaceConfig(kind: WorkspaceKindSlug, raw: unknown): WorkspaceConfig {
  if (kind === GIT_WORKTREE_KIND) return GitWorkspaceConfigSchema.parse(raw);
  if (kind === FOLDER_KIND) return FolderWorkspaceConfigSchema.parse(raw);
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as UnknownWorkspaceConfig) : {};
}

/**
 * The relative paths a step declares as what it produces (EO-299).
 *
 * Newlines or commas, because a person typing three filenames into a
 * text field will use whichever they reach for first and neither is
 * wrong. Blank entries are dropped rather than checked: a trailing
 * newline is not a file somebody forgot to write.
 *
 * Anything that is not a string — a number, a boolean, an input that was
 * never set — declares nothing. A step on a folder workspace that names
 * no outputs is verified with no checks, which is the same silence a
 * `none` workspace keeps and for the same reason: EO says what it
 * checked, and "nothing" is a thing it may have checked.
 */
export function declaredOutputs(inputs: Record<string, unknown> | undefined): string[] {
  const declared = inputs?.[STEP_OUTPUTS_INPUT];
  if (typeof declared !== "string") return [];
  return declared
    .split(/[\n,]/)
    .map((path) => path.trim())
    .filter((path) => path !== "");
}
