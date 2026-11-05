import type { Item, StepInputs, Uuid, WatchNews } from "@eo/core";
import type { Db } from "../db/client.js";
import type { PrepareWorkspaceOutcome, PrepareWorkspaceRequest } from "./workspaceKind.js";

/**
 * What EO hands a function it runs itself, and what one hands back
 * (KAN-144).
 *
 * The *contract*, with none of the functions: the three shipped runners
 * moved into the developer pack, and this is what stayed behind,
 * because the supervisor and the module host are both typed on it and
 * neither may import from a pack (ARCHITECTURE.md, "Where the seams are"). A pack contributes
 * runners of this shape through `CodePack.builtins`; a module's runner
 * is the same shape with its results declared in a manifest instead.
 *
 * The workspace types it re-exports are `workspaceKind.ts`'s, which is
 * where "prepare somewhere to work and tell me where, or say why not"
 * became one method of the `WorkspaceKind` interface (EO-295) rather
 * than a hook shaped like `git worktree add`. Re-exported rather than
 * redeclared so that a builtin, a module and an agent dispatch are all
 * handed the same prepared workspace — a `{cwd, kind, workspaceId}`
 * value — instead of three descriptions of a directory that agree
 * today.
 */
export type { PrepareWorkspaceOutcome, PrepareWorkspaceRequest };

export interface BuiltinContext {
  db: Db;
  item: Item;
  /** The same idempotent preparation an agent dispatch does. */
  prepareWorkspace: (item: Item, action: string, options?: PrepareWorkspaceRequest) => Promise<PrepareWorkspaceOutcome>;
  /**
   * The run this is happening under.
   *
   * Neither shipped builtin needs it — what they did fits in the run's
   * result. A custom module does (KAN-105): it produces output as it
   * goes, and that output is the transcript, which has to be filed
   * against a run to be readable at all.
   */
  runId: Uuid;
  /**
   * Where this run says what it is doing, as it does it.
   *
   * Each call is one `output` event on `run_events`, which is what the
   * transcript panel reads — so this is the difference between a run a
   * person can watch and one whose panel says "No events recorded for
   * this run", which is what every builtin's said until EO-77. Both
   * shipped builtins now narrate the steps that can take time or go
   * wrong: which ref a branch was cut from, which push was retried and
   * why.
   *
   * Deliberately not a comment. Invariant #4 is about having a channel,
   * not about narrating into it, and "fetching origin/main" in every
   * item thread would bury what agents actually read. A transcript is
   * the place a run's own story belongs.
   */
  report: (text: string) => void;
  /**
   * Aborted when a person cancels the run, pauses with cancellation, or
   * shuts EO down.
   *
   * The worktree does not watch it: `git worktree add` is local and
   * finishes in well under a second. The pull request does, since it
   * opened one rather than queueing it (EO-77) — it talks to a remote and
   * to a forge, and without this `cancelRun` would be a no-op against the
   * one builtin that can sit there for minutes. A module needs it for the
   * same reason (KAN-105).
   */
  signal?: AbortSignal;
  /**
   * Makes sure the run named by `runId` has its row (EO-456).
   *
   * A check of a step that keeps checking has no run row until it has
   * something worth recording — a check that comes back waiting with
   * nothing new writes only the item's watch. Anything that writes a row
   * naming the run — a comment, an attachment, a created item — calls
   * this first, so the row exists to be named. Absent on every ordinary
   * run, whose row was made before it started.
   */
  ensureRun?: () => void;
  /**
   * What the step running this set for its inputs (EO-459) — the same
   * `pipeline_steps.inputs` a module step's are.
   *
   * The developer pack's three read none of theirs. The core's
   * `wait_until` reads which moment it waits for here. Absent where no
   * step is in hand, which a function reads as nothing set.
   */
  inputs?: StepInputs;
}

/**
 * What a builtin returns.
 *
 * `result` is a declared result key, exactly as an agent's structured
 * output produces one — the routing table is what decides where it goes,
 * so a builtin has no more say in the matter than a reviewer does.
 *
 * Parameterised by the keys this particular runner may report (EO-77).
 * The default is `string`, which is what the supervisor holds a returned
 * outcome as and the only thing a *module* could be: a module's results
 * are declared in its own manifest, so nothing here can narrow them. A
 * pack's own runner narrows it to exactly what that pack declared the
 * function can return — `BuiltinRunners` in `packs/developer/builtins.ts`
 * is the shipped example.
 */
export type BuiltinOutcome<R extends string = string> =
  /**
   * `news` is for a check of a step that keeps checking (EO-456), which
   * answers `result: "waiting"` (`WAITING_RESULT`) while what it waits on
   * has not happened yet. Each entry is something that changed since EO
   * last looked, with an id that stays the same for as long as it is
   * true; EO posts each id once per watch. A check's result key may carry
   * news too — the failed job behind a failure (EO-460) — and it is posted
   * the same way before the result routes. Ignored on a step that does
   * not keep checking.
   *
   * `stay` names the stay on the step this answer was given on
   * (`watchStayOf`). It is kept with the outcome on the run, so a later check
   * can tell that this stay has had an answer, and from an older stay's
   * (EO-620).
   */
  | { ok: true; result: R; detail: string; news?: readonly WatchNews[]; stay?: string }
  /**
   * `options` are the answers EO would accept, when the failure is a
   * question it is asking rather than a fact it is reporting — they
   * become the buttons on the escalation comment.
   */
  | { ok: false; reason: string; options?: string[] };

export type BuiltinRunner<R extends string = string> = (context: BuiltinContext) => Promise<BuiltinOutcome<R>>;
