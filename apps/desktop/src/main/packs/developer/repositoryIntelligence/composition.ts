import type { Db } from "../../../db/client.js";
import { CODEWIKI } from "./binary/catalog.js";
import {
  fallbackRepositoryIntelligenceRoot,
  installCodeWiki,
  pruneSupersededInstalls,
  repositoryIntelligenceRoot,
  type FetchLike,
} from "./binary/install.js";
// The two imports in this tree that name the implementation, and the
// reason this file is exempt from the scan in
// `architecturalInvariants.test.ts`. See the note below.
import { createCodeWikiProvider, CODEWIKI_INDEX_DIRECTORY, CODEWIKI_PROVIDER_ID } from "./codewiki/provider.js";
import { codeWikiExecutable } from "./codewiki/run.js";
import { readRepositoryIntelligenceConfig } from "./gate.js";
import type { RepositoryIntelligenceProvider } from "./port.js";
import { createRepositoryIntelligenceService, type RepositoryIntelligenceService } from "./service.js";

/**
 * The composition root: the one place that turns a configured provider
 * id into a running provider (EO-149).
 *
 * **Why this file is allowed to name the implementation, and nothing
 * else is.** Something has to call the constructor. A port keeps every
 * *consumer* ignorant of what is underneath it, which is the property
 * EO-141 exists to protect, but it cannot make the object appear —
 * somewhere a concrete name is written down, and the choice is only
 * whether that place is one file you can point at or a habit spread
 * through the tree. `db/architecturalInvariants.test.ts` settles the
 * same question the same way: exactly one file may write
 * `items.stepId`, named in the test, and everything else goes through
 * it.
 *
 * So this is the named exception, and it is deliberately the *whole*
 * exception. It hands back a `RepositoryIntelligenceService` and a
 * couple of sentences; no caller of it can tell what was constructed,
 * and adding a second implementation means another row in `PROVIDERS`
 * below rather than another file that knows.
 *
 * The alternative considered and rejected: reaching the constructor
 * through a dynamic import with a computed specifier, which the
 * scanner's regex does not match. That would have kept the test green
 * while doing the exact thing the test exists to catch, and a check you
 * have learned to slip past is worse than no check.
 *
 * Nothing here is long-lived. A runtime is built per call, because the
 * gate is read at call time (EO-148) and because the signal that
 * cancels the work belongs to one run.
 */

/** Everything a caller needs to index a checkout, once there is one. */
export interface RepositoryIntelligenceRuntime {
  /** Metadata and status transitions. The only half that touches `eo.db`. */
  service: RepositoryIntelligenceService;
  /**
   * Puts the implementation's binary on disk if it is not there already
   * (A-08: EO fetches, it does not bundle).
   *
   * Separate from the service because the port has no `install` — an
   * implementation might need no binary at all, and a method every
   * future provider had to stub would be the port describing this one.
   * Answers rather than throws, like everything else in this subsystem:
   * a machine upstream publishes nothing for is an ordinary outcome.
   */
  ensureInstalled(): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface RepositoryIntelligenceOptions {
  db: Db;
  /**
   * Where a fetched binary is cached. `userData/repositoryIntelligence`
   * in production, and never inside a worktree — `verify.ts` requires
   * one to be clean before anything merges.
   */
  root: string;
  /** Ends the work when a person cancels the run, or EO shuts down. */
  signal?: AbortSignal;
  /** Narration, straight through to the run's transcript. */
  onProgress?: (text: string) => void;
  /** Injected so the tests never reach the network. */
  fetchImpl?: FetchLike;
  /** Injectable so a test can assert on timestamps without racing the clock. */
  now?: () => number;
}

/**
 * The shape the engine hands the builtin step.
 *
 * A function rather than a built object, so the gate is consulted on the
 * dispatch that needs an answer rather than on the launch that happened
 * to come first.
 */
export type RepositoryIntelligenceFactory = (options: Omit<RepositoryIntelligenceOptions, "root">) => RepositoryIntelligenceRuntime | null;

/** How often a download says how it is doing. Ten lines, not one per chunk. */
const PROGRESS_STEP = 0.1;

/**
 * The configured runtime, or null when there is nothing to run.
 *
 * Null for two reasons and a caller need not tell them apart, because
 * it does the same thing either way: the feature is switched off, or
 * the configured provider id names something this build does not have.
 * The second is not an error to report — a database can outlive the
 * build that wrote it, and a settings value naming a provider that has
 * since been removed should leave EO working, not stop it.
 */
export function repositoryIntelligenceFor(options: RepositoryIntelligenceOptions): RepositoryIntelligenceRuntime | null {
  const config = readRepositoryIntelligenceConfig(options.db);
  if (!config.enabled) return null;
  return providerFor(config.provider, options);
}

function providerFor(id: string, options: RepositoryIntelligenceOptions): RepositoryIntelligenceRuntime | null {
  const entry = PROVIDERS.find((candidate) => candidate.id === id);
  if (entry === undefined) return null;

  return {
    service: createRepositoryIntelligenceService({
      db: options.db,
      provider: entry.create(options),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    ensureInstalled: () => entry.ensureInstalled(options),
  };
}

/**
 * Everything EO has to know about an implementation to run one, and
 * the whole of it (EO-163).
 *
 * A row per provider, in the one file already allowed to name one. What
 * shipping a second implementation costs is a directory beside
 * `codewiki/` and an entry here — and *nothing* above this line: not the
 * port, not the service, not the gate, not the checks that step over an
 * index, and not a role prompt. That was always the claim the port made;
 * until EO-163 it was one string short of true, because the directory
 * this implementation writes into was written down in the shared layer
 * where a second provider would have had to go and edit it.
 */
interface ProviderEntry {
  /** What `repository_indexes.provider` records, and what a settings row names. */
  id: string;
  /**
   * The directory this implementation writes an index into, relative to
   * the checkout it describes.
   *
   * Here because EO's own cleanliness checks have to recognise one and
   * cannot ask a provider — `verify.ts` runs on a worktree with no
   * database handle, no configuration and nothing constructed. The
   * answer still comes *from* the implementation; this is only where the
   * implementations' answers are collected, which is what keeps
   * `indexPaths.ts` ignorant of whose directory is whose.
   */
  indexDirectory: string;
  /** Builds the provider for one run, with that run's cancellation and clock. */
  create: (options: RepositoryIntelligenceOptions) => RepositoryIntelligenceProvider;
  /** Puts whatever it needs on this machine, or says why it could not. */
  ensureInstalled: (options: RepositoryIntelligenceOptions) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

const PROVIDERS: readonly ProviderEntry[] = [
  {
    id: CODEWIKI_PROVIDER_ID,
    indexDirectory: CODEWIKI_INDEX_DIRECTORY,
    create: (options) =>
      createCodeWikiProvider({
        binary: { root: options.root },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
    ensureInstalled: (options) => ensureCodeWikiInstalled(options.root, options),
  },
];

/**
 * Every directory an index can land in, for the checks that have to
 * step over one.
 *
 * Every known provider's rather than the configured one's, and that is
 * the safe direction rather than a shortcut: a checkout indexed before
 * somebody changed the setting still has the old implementation's
 * directory sitting in it, and a `clean` check that had stopped
 * recognising it would fail a run for work nobody did. Nothing is
 * committed or deleted on the strength of this list — it only decides
 * what EO declines to call somebody's work.
 */
export const REPOSITORY_INDEX_DIRECTORIES: readonly string[] = PROVIDERS.map((entry) => entry.indexDirectory);

/**
 * Downloads the binary, unless there is already one to use.
 *
 * Resolution first, and it is not just an optimisation: a path somebody
 * set by hand wins outright, and a machine that has already fetched the
 * pinned version must not fetch it again on every item.
 *
 * A platform upstream publishes nothing for never reaches the network —
 * `installCodeWiki` answers that from the catalogue — so the reason a
 * caller reports on an Intel Mac names the platform rather than a
 * download that was never going to happen.
 *
 * Also where a superseded copy is collected on the second attempt
 * (EO-158). The install that supersedes one prunes it itself; this is
 * the path that picks up the copy that install could not delete.
 */
async function ensureCodeWikiInstalled(root: string, options: RepositoryIntelligenceOptions): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Asked through the runner rather than the resolver, and not by
  // preference: `codewiki/importSites.test.ts` allows exactly two files
  // in the tree to hold a resolved binary path, and this is not one of
  // them. `codeWikiExecutable` is the sanctioned way to ask where the
  // binary is without starting one, which is the whole question here.
  if (codeWikiExecutable({ root }).path !== null) {
    // Not belt-and-braces over the prune the install already does. On
    // Windows that one can refuse outright — the superseded executable
    // is locked open by the `serve --mcp` process of a run that has not
    // finished — and without a second place to try, the copy that
    // survived would sit there until the *next* version bump. Here it
    // waits for the next item instead.
    //
    // The precondition pruning has is that a complete current version
    // exists, and a non-null path is that fact by construction:
    // resolution is handed nothing but the root, so the only thing it
    // can have found is EO's own cache at the pinned version. (Wire a
    // configured path through here one day and this needs revisiting —
    // that path says nothing about what EO downloaded.)
    pruneSupersededInstalls(root);
    return { ok: true };
  }

  // Cancellation reaches a download the only way it can: through the
  // request. `installCodeWiki` takes no signal because it is a sequence
  // of fetches and a file rename, and aborting the fetch is what ends
  // the sequence.
  const base = options.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const fetchImpl: FetchLike = (url, init) => base(url, options.signal === undefined ? init : { ...init, signal: options.signal });

  // Said only when there is something to download. A machine upstream
  // publishes nothing for gets no "Downloading…" line it will never
  // follow up on — `installCodeWiki` answers that case from the
  // catalogue without a request, and its `problem` names the platform.
  if (CODEWIKI.assetFor(process.platform, process.arch) !== null) {
    options.onProgress?.(`Downloading ${CODEWIKI.label} ${CODEWIKI.version}, which EO has not fetched on this machine yet.`);
  }
  let announced = 0;
  const result = await installCodeWiki({
    root,
    fetchImpl,
    onProgress: (received, total) => {
      if (total <= 0) return;
      const fraction = received / total;
      if (fraction < announced + PROGRESS_STEP) return;
      announced = Math.floor(fraction / PROGRESS_STEP) * PROGRESS_STEP;
      options.onProgress?.(`Downloaded ${Math.round(fraction * 100)}% of ${CODEWIKI.label} ${CODEWIKI.version}.`);
    },
  });

  if (!result.ok) return { ok: false, reason: result.problem ?? `EO could not download ${CODEWIKI.label} ${CODEWIKI.version}.` };
  options.onProgress?.(`${CODEWIKI.label} ${CODEWIKI.version} is installed.`);
  return { ok: true };
}

export { repositoryIntelligenceRoot, fallbackRepositoryIntelligenceRoot };
