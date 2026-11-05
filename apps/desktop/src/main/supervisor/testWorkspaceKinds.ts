import { GIT_WORKTREE_KIND, NONE_KIND, type Item, type WorkspaceKindSlug } from "@eo/core";
import { NOTHING_ATTACHED, verifier, type Check, type PrepareWorkspaceOutcome, type VerifiableRun, type WorkspaceKind } from "./workspaceKind.js";

/**
 * A workspace kind for a test that is not about workspaces.
 *
 * The supervisor's tests care about one thing each: where a run was
 * pointed, what a check said, whether a server reached the backend. A
 * kind is five members, and spelling four empty ones out in forty test
 * files would make the interface expensive to change for no reason any
 * of those tests could state.
 *
 * So this is the honest no-op: it prepares a directory, lends nothing,
 * checks nothing, releases nothing and produces nothing, and a test
 * overrides exactly the member it is about — `verifying` for the common
 * case of one verifier on `implement`, `verifiers` when the action
 * matters. It lives beside the code rather than in a test file because
 * several of those files need it, the same bargain `db/testHelpers.ts`
 * and `providers/fixtures.ts` strike.
 *
 * The slug defaults to `git-worktree` deliberately: that is what the
 * workspace rows `attachWorkspace` seeds carry, so an item created by a
 * test resolves to this kind without the test having to know that the
 * lookup happens by slug at all.
 */
/**
 * A verifier without the words (EO-312).
 *
 * A real one says what it checks, because a column head is drawn from
 * it. A test's says nothing worth reading, so this takes the bare
 * function and `fakeWorkspaceKind` supplies a stand-in phrase — the
 * alternative being a sentence nobody reads written out at every one of
 * these sites, which is the cost the helper exists to avoid.
 */
export type FakeVerifier = (item: Item, run: VerifiableRun) => Promise<readonly Check[]>;

export interface FakeWorkspaceKindOptions extends Partial<Omit<WorkspaceKind, "slug" | "verifiers">> {
  slug?: WorkspaceKindSlug;
  /** Where `prepare` says the run happens. Ignored when `prepare` is given outright. */
  cwd?: string;
  /** Keyed by action, as a real kind's are. */
  verifiers?: Readonly<Record<string, FakeVerifier>>;
  /**
   * A verifier for `implement`, which is the action most of these tests
   * dispatch. Ignored when `verifiers` is given outright.
   */
  verifying?: FakeVerifier;
}

/** What a test's verifier says it checks, where no test is about the words. */
const SOMETHING = ["something"];

export function fakeWorkspaceKind(options: FakeWorkspaceKindOptions = {}): WorkspaceKind {
  const slug = options.slug ?? GIT_WORKTREE_KIND;
  // A directory nothing is in, rather than EO's own: since EO-296 no
  // code path reaches the process working directory to decide where a
  // run happens, and a stand-in that quietly did would be the one place
  // left where a test could pass for the old reason.
  const cwd = options.cwd ?? "/tmp/eo/a-workspace";
  return {
    slug,
    prepare: options.prepare ?? (async (item): Promise<PrepareWorkspaceOutcome> => ({ ok: true, workspace: { cwd, kind: slug, workspaceId: item.workspaceId } })),
    attach: options.attach ?? (async () => NOTHING_ATTACHED),
    verifiers: Object.fromEntries(
      Object.entries(options.verifiers ?? (options.verifying === undefined ? {} : { implement: options.verifying })).map(([action, check]) => [
        action,
        verifier(SOMETHING, check),
      ]),
    ),
    release: options.release ?? (async () => ({})),
    artifacts: options.artifacts ?? (async () => []),
    // The git kind's answer, because this stands in for the git kind: a
    // test that is not about capacity still wants two items in one
    // workspace to queue the way they do in the app (EO-296).
    capacityKeyOf: options.capacityKeyOf ?? ((item: Item): string | null => item.workspaceId),
  };
}

/**
 * The installed kinds, keyed the way the fold keys them — and the first
 * one also answers for `none`.
 *
 * The second half is the whole reason this is a function rather than a
 * `new Map`. Most items in most tests here are created with no workspace
 * row and no project, because most tests here are not about workspaces;
 * since EO-296 such an item resolves to `none`, which is a real kind
 * that prepares an empty directory. A test that installed a stand-in and
 * then watched its run happen somewhere else entirely would be a test
 * failing for a reason it has nothing to say about.
 *
 * So the stand-in answers for whichever kind the item turns out to be
 * on, which is the same bargain `fakeWorkspaceKind`'s default slug
 * strikes one level down. A test that *is* about `none` installs one
 * under that slug — or installs nothing at all, which is how the
 * supervisor's own built-in `none` is reached — and nothing is
 * overwritten either way.
 */
export function installedKinds(...kinds: readonly WorkspaceKind[]): ReadonlyMap<WorkspaceKindSlug, WorkspaceKind> {
  const installed = new Map(kinds.map((kind) => [kind.slug, kind]));
  const [first] = kinds;
  if (first && !installed.has(NONE_KIND)) installed.set(NONE_KIND, first);
  return installed;
}

/** The commonest case in one call: one kind, and every run works in `cwd`. */
export function kindsPreparing(cwd: string): ReadonlyMap<WorkspaceKindSlug, WorkspaceKind> {
  return installedKinds(fakeWorkspaceKind({ cwd }));
}

/** One prepared workspace, for a stub that decides the directory itself. */
export function preparedIn(item: Item, cwd: string): { ok: true; workspace: { cwd: string; kind: WorkspaceKindSlug; workspaceId: Item["workspaceId"] } } {
  return { ok: true, workspace: { cwd, kind: GIT_WORKTREE_KIND, workspaceId: item.workspaceId } };
}

/**
 * The same no-op preparation, as the function a `BuiltinContext` is
 * handed.
 *
 * A builtin and a module are given the preparation rather than the kind
 * — they ask for somewhere to work and are told where, which is the
 * whole of their interest in the question — so their tests stub this
 * instead of installing a kind.
 */
export function preparingAt(cwd: string): (item: Item, action: string) => Promise<PrepareWorkspaceOutcome> {
  return async (item: Item) => preparedIn(item, cwd);
}
