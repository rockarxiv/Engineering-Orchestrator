import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NONE_KIND, type Item } from "@eo/core";
import { NOTHING_ATTACHED, type PrepareWorkspaceOutcome, type WorkspaceKind } from "./workspaceKind.js";

/** Where the empty directories live. `~/.eo/no-disk`, beside the worktrees, for the same reason they are not in the repository. */
export function defaultNoDiskRoot(): string {
  return join(homedir(), ".eo", "no-disk");
}

/**
 * No disk at all, as a workspace kind (EO-296,
 * ARCHITECTURE.md, "The four kinds").
 *
 * The kind for an agent whose work is entirely through MCP servers and
 * connectors: a support reply that lives in a helpdesk, a report that is
 * posted rather than written to a file. It prepares an empty directory,
 * lends nothing, checks nothing and produces nothing — four of the five
 * methods are honestly empty, and that is the point of the interface
 * having five rather than the supervisor having eight hooks that all
 * assumed a checkout.
 *
 * **This is what the process working directory used to be**, and the
 * difference is the whole story. A run with nowhere to work was handed
 * whatever directory EO itself was launched from, with a note in the
 * thread explaining that it had: for a packaged app that is not a
 * checkout of anything and frequently not a git repository at all, so a
 * provider that checks it is inside a trusted repository refused before
 * the agent started, naming itself rather than the directory. An empty
 * directory of EO's own making is a *stated* absence — the card says
 * "no disk" — rather than an accident an agent discovers.
 *
 * **The core's own kind, not a pack's.** Every other kind arrives with a
 * pack, and the fold refuses two packs claiming one slug; this one is
 * built into the supervisor because a core with no pack installed still
 * has to have somewhere to put a run, and "somewhere" cannot be a thing
 * only an installed pack can supply.
 */
export function noneWorkspaceKind(root: string = defaultNoDiskRoot()): WorkspaceKind {
  /**
   * One directory per item, made if it is not there.
   *
   * Per item rather than per run, and derived rather than random, for
   * two reasons that pull the same way. A resumed run is handed the
   * `cwd` its run row recorded and must find it still there — a session
   * resumed from a directory that has been swept is not the same
   * session. And `prepare` is idempotent by contract: preparing twice
   * for one item is the ordinary case, not a mistake.
   *
   * Not shared between items, which is what makes the null capacity key
   * below safe: two `none` runs at once are two directories, so there is
   * nothing for them to tread on.
   */
  const directoryFor = (item: Item): string => {
    const path = join(root, item.key);
    mkdirSync(path, { recursive: true });
    return path;
  };

  return {
    slug: NONE_KIND,

    async prepare(item: Item): Promise<PrepareWorkspaceOutcome> {
      return { ok: true, workspace: { cwd: directoryFor(item), kind: NONE_KIND, workspaceId: null } };
    },

    /** Nothing. Whatever this agent reaches, it reaches through its own servers and its connectors. */
    async attach() {
      return NOTHING_ATTACHED;
    },

    /**
     * Nothing to check, for any action, and saying so is the answer
     * rather than a gap.
     *
     * There is no tree to read, no commit to count and no command to
     * run. What a run on `none` claimed is judged by whoever reads it,
     * which is what the column head's line says out loud (ARCHITECTURE.md, "What 'EO checks' means
     * on a step") instead
     * of leaving a person to assume EO checked something. An empty table
     * rather than a verifier that passes: a tick beside a run nothing
     * looked at would be the one lie this kind could tell.
     */
    verifiers: {},

    /**
     * The directory goes when the item settles; the sweep leaves it
     * alone.
     *
     * A settled item is the one moment nothing on it will be resumed
     * again. The stale sweep is deliberately not the other half of that
     * here: it is handed which *item keys* still have a run behind them,
     * and an item parked between two steps looks exactly like one that
     * is finished — EO-177 is the story about what treating those as the
     * same thing cost. An empty directory is worth nothing, so there is
     * nothing to be gained by guessing.
     */
    async release(request) {
      if (request.what === "settled") rmSync(join(root, request.item.key), { recursive: true, force: true });
      return {};
    },

    /** Nothing was produced on disk. What the run has to say is what it said. */
    async artifacts() {
      return [];
    },

    /**
     * In no bucket at all: two items on `none` are two empty
     * directories, and there is nothing for them to collide in.
     *
     * The global cap still applies — invariant 10 holds and concurrency
     * is still 1 — so this changes what the cap is keyed on rather than
     * how much runs at once.
     */
    capacityKeyOf(): string | null {
      return null;
    },
  };
}
