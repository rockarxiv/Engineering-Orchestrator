import type { IpcPayload, IpcResponse, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getSetting, listProjects, setSetting } from "../db/repos/index.js";
import { previewProjectId } from "../gallery/commands.js";

/**
 * First run, as the main process holds it (EO-317,
 * `ARCHITECTURE.md`, "What a person sees first").
 *
 * The order is the story — "mode, then gallery, then optional Preview
 * with no sign-in, then the template's own blanks, then the needs check
 * … then the first real item" (the original design) — and almost all of
 * it is a screen. What lives here are the two facts that have to outlive
 * a window:
 *
 *  - **which mode somebody chose**, because 7b's sign-in reads it and
 *    because a person who answered step 1 must not be asked it again;
 *  - **whether the flow is behind them**, because the one exit that
 *    creates nothing real — "Continue with Preview only" — would
 *    otherwise put them back at step 1 on the next launch, which is the
 *    locked front door the design exists to remove.
 */

/** `solo` or `organisation`, as answered at step 1. */
const MODE_KEY = "firstRun.mode";
/** The server address an organisation signed in to at step 1. */
const ADDRESS_KEY = "firstRun.address";
/** When somebody left the flow, by either exit. */
const DONE_KEY = "firstRun.doneAt";
/**
 * The project first run itself installed, at step 4 of 6.
 *
 * Without this, the flow ends itself half way through: "a real project
 * exists" is what `firstRunDone` reads, and submitting the template's
 * blanks is what creates one — so the needs check, whose lines are that
 * submission's own answer, would be taken off the screen by the
 * submission that produced them. The project is not counted until an
 * exit is taken, which is what `DONE_KEY` records.
 *
 * Written only while first run is still open (see `noteFirstRunProject`),
 * so the fourth template somebody installs from Templates two months
 * later is nobody's first run.
 */
const INSTALLED_KEY = "firstRun.projectId";

/**
 * Is first run behind this installation?
 *
 * Two ways to be done, and both are needed.
 *
 * **A real project exists.** Which is every installation that predates
 * this story — a developer with work on their board must not be shown a
 * gallery — and every one that finished the flow by installing a
 * template. Derived rather than stored, so nothing has to have been
 * written correctly at some point in the past for an existing
 * installation to behave.
 *
 * **Or they said so**, which is the "Continue with Preview only" exit:
 * the design lets somebody leave with a rehearsal rather than facing a door they
 * cannot open, and that person has no real project by definition.
 *
 * The preview project is **not** a real one. Pressing Preview is step 3,
 * in the middle of the flow, and a rehearsal that ended first run would
 * be the product mistaking its own demonstration for somebody's work.
 */
export function firstRunDone(db: Db): boolean {
  if (getSetting<number | null>(db, DONE_KEY, null) !== null) return true;
  const preview = previewProjectId(db);
  const installed = getSetting<string | null>(db, INSTALLED_KEY, null);
  return listProjects(db).some((project) => project.id !== preview && project.id !== installed);
}

/**
 * Remembers the project first run just installed, if it is still first
 * run.
 *
 * Called by `gallery:use` rather than decided here, because "this is the
 * project the flow made" is a fact about that call and nothing else can
 * observe it afterwards: a project made by the flow and a project made
 * from Templates are the same row.
 */
export function noteFirstRunProject(db: Db, projectId: Uuid): void {
  // Not `firstRunDone`, which would already be answering "yes" — the row
  // this is about is the one that just made it say so. The two questions
  // underneath it are what actually decide: has anybody left the flow,
  // and did this installation have a project of its own before this one?
  if (getSetting<number | null>(db, DONE_KEY, null) !== null) return;
  const preview = previewProjectId(db);
  const others = listProjects(db).filter((project) => project.id !== preview && project.id !== projectId);
  if (others.length > 0) return;

  setSetting(db, INSTALLED_KEY, projectId as string);
}

export function firstRunStateCommand(db: Db): IpcResponse<"firstRun:state"> {
  const stored = getSetting<string | null>(db, MODE_KEY, null);
  return {
    done: firstRunDone(db),
    mode: stored === "solo" || stored === "organisation" ? stored : null,
  };
}

/**
 * Step 1's answer (ARCHITECTURE.md, "What a person sees first").
 *
 * Recorded once the person has a way in (EO-661): solo when they chose
 * to carry on alone, organisation once `session:signIn` succeeded from
 * the welcome screen. The address is the one they signed in to, kept
 * beside the mode; the sign-in itself is the session's, not this.
 */
export function setFirstRunModeCommand(db: Db, payload: IpcPayload<"firstRun:setMode">): IpcResponse<"firstRun:setMode"> {
  setSetting(db, MODE_KEY, payload.mode);
  if (payload.address.trim() !== "") setSetting(db, ADDRESS_KEY, payload.address.trim());
  return { mode: payload.mode };
}

/**
 * The flow is behind them.
 *
 * Written once and never rewritten: what it records is *when* somebody
 * first came out the other side, and a second pass through the gallery —
 * which is an ordinary thing to do, since Templates stays in the rail —
 * is not a second first run.
 */
export function finishFirstRunCommand(db: Db): IpcResponse<"firstRun:finish"> {
  if (getSetting<number | null>(db, DONE_KEY, null) === null) setSetting(db, DONE_KEY, Date.now());
  return { done: true };
}
