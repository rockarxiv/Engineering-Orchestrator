import { developerRegistry } from "@eo/core";
import type { Db } from "../../db/client.js";
import type { CodePack } from "../pack.js";
import { createBuiltinRunners } from "./builtins.js";
import { developerConnectors } from "./connectors.js";
import { gitWorkspaceKind } from "./workspace/gitKind.js";
import { fallbackRepositoryIntelligenceRoot, repositoryIntelligenceFor, type RepositoryIntelligenceFactory } from "./repositoryIntelligence/index.js";
import { createPosters } from "./posters.js";
import { createRoleWiring } from "./wiring.js";
import { createDispatchGate } from "./scheduling.js";
import { developerSectionRenderers } from "./sections.js";

/**
 * What the developer pack needs from the process to build its hooks.
 *
 * A subset of `EngineOptions` by shape rather than by import, so that
 * the pack is not typed on the composition root that composes it: each
 * of these is a path the app resolves under `userData`, and a caller
 * with none of them — the v1 gate, a test — gets the same fallbacks the
 * pack has always used.
 */
export interface DeveloperPackOptions {
  db: Db;
  /** Where item worktrees are cut. `~/.eo/worktrees` when nobody says. */
  worktreeRoot?: string;
  /**
   * Where the fetched repository-index binary is cached (EO-149).
   *
   * Resolved here rather than by the caller so that the step that
   * builds an index, the dispatch that hands one to an agent and the
   * sync at handover cannot disagree about which index exists — the
   * reason `engine.ts` had one `intelligenceFor` and passed it to three
   * options. That reason now lives with the pack that owns all three.
   */
  repositoryIntelligenceRoot?: string;
  /**
   * The wrapper that bounds a delivered MCP server's life by the backend
   * that started it (EO-151). Absent means a server is handed over as the
   * provider composed it.
   */
  mcpServerSupervisorPath?: string;
}

/**
 * EO as a developer tool, as one value (ARCHITECTURE.md, "The core is domain-neutral", KAN-144).
 *
 * The git worktree, the verifier, the forge, Jira, repository
 * intelligence, the three functions a `builtin` step can run, the role
 * wiring and the roles, actions and item types the registry holds —
 * everything that makes this installation about writing software rather
 * than about drafting a weekly report. `createEngine` folds it into the
 * supervisor's options; the core has no import of any of it (KAN-177's
 * allowlist is what keeps that true as the remaining importers shrink).
 *
 * A function rather than a constant because the git kind, the wiring
 * and the builtins all close over the database and over paths the app
 * resolves at startup. Called once, by the composition root.
 */
export function developerPack(options: DeveloperPackOptions): CodePack {
  const { db, worktreeRoot } = options;

  // One spelling of the index cache's fallback, shared with the
  // builtins' own default, and a scratch directory rather than `~/.eo`:
  // a test that turns the feature on and passes no root should not
  // download into the developer's home.
  const cache = options.repositoryIntelligenceRoot ?? fallbackRepositoryIntelligenceRoot();
  // One spelling, used by the step that builds an index, the dispatch
  // that hands one to an agent, and the sync at handover (EO-149,
  // EO-151, EO-153). A second copy pointed at a different root would
  // have them disagree about which index exists — the step building one
  // nobody could query.
  const intelligenceFor: RepositoryIntelligenceFactory = (intelligence) => repositoryIntelligenceFor({ ...intelligence, root: cache });

  return {
    id: "developer",
    registry: developerRegistry(),
    // Built here rather than shared from the module-level constant,
    // because two of them need something only this file has resolved.
    // The pull request needs `worktreeRoot`, so a send told to look
    // elsewhere for EO's own checkout of the branch does (EO-156); the
    // index needs the cache its binary is fetched into, which lives
    // beside the app's other state rather than in the bundle (EO-149).
    builtins: createBuiltinRunners(undefined, worktreeRoot, intelligenceFor),
    // What this pack's item types name when they say who writes the
    // record of a `refine` (KAN-163): the plan for a container, the note
    // for work that arrived written. The same table the wiring posts
    // through, declared here so the fold can refuse an override naming a
    // poster nothing registers.
    posters: createPosters(db),
    wiring: createRoleWiring(db),
    // What the scheduler and the prompt assembly used to know by
    // themselves, taken out of `packages/engine` and handed back as data
    // (platform ARCHITECTURE.md, "The core is domain-neutral", KAN-161). A step that judges an
    // item needs criteria to judge it against, and the three prompt
    // sections are this pack's words about what work is and how it is
    // checked. Which bucket a run consumes was here too until EO-296;
    // it is the git kind's `capacityKeyOf` now, because the bucket is
    // the checkout rather than anything the pack as a whole knows.
    dispatchGate: createDispatchGate(db),
    sectionRenderers: developerSectionRenderers,
    // The words around the one server this pack has anything to say
    // about (EO-315). See `connectors.ts` for why its setup kind is
    // `none` and why it is on the list at all.
    connectors: developerConnectors,

    // The disk this installation works on, as one value rather than
    // eight options on the supervisor (EO-295). Every method wraps a
    // function this pack already had; what changed is that the
    // supervisor now looks the kind up by the slug an item's workspace
    // row names, and calls nothing on an item whose workspace is of
    // another kind.
    kinds: [
      gitWorkspaceKind({
        db,
        ...(worktreeRoot ? { worktreeRoot } : {}),
        intelligenceFor,
        ...(options.mcpServerSupervisorPath ? { mcpServerSupervisorPath: options.mcpServerSupervisorPath } : {}),
      }),
    ],
  };
}
