import type { IpcPayload, IpcResponse, TeamSessionView, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { postComment } from "../db/repos/commentsRepo.js";
import { getTeamSession } from "../db/repos/teamSessionsRepo.js";
import { actingCaller, humanAuthor } from "../identity/acting.js";
import { itemTeamSessions } from "../supervisor/teamSessionView.js";
import type { EngineHandle } from "./domainCommands.js";
import { emitPush } from "./push.js";

/**
 * A person's controls on a team session (EO-849): reading it, cancelling
 * it, and retrying what failed. Each refusal is the same sentence the
 * session's view gives beside the control, answered rather than thrown, so
 * the screen never offers a button that does nothing and a press that is
 * refused says why.
 */

export function teamSessionsCommand(db: Db, engine: EngineHandle | undefined, input: IpcPayload<"items:teamSessions">): IpcResponse<"items:teamSessions"> {
  return { sessions: itemTeamSessions(db, input.itemId, engine?.teamControlSite?.() ?? null) };
}

function viewOf(db: Db, engine: EngineHandle | undefined, sessionId: string): TeamSessionView | undefined {
  const session = getTeamSession(db, sessionId);
  return session === undefined ? undefined : itemTeamSessions(db, session.itemId, engine?.teamControlSite?.() ?? null).find((view) => view.id === sessionId);
}

/** Stops the whole session: the team's run, every participant, and the session ended. */
export function cancelTeamSessionCommand(db: Db, engine: EngineHandle | undefined, input: IpcPayload<"teams:cancel">): IpcResponse<"teams:cancel"> {
  const view = viewOf(db, engine, input.sessionId);
  if (view === undefined) return { cancelled: false, problem: "There is no such team session." };
  if (!view.cancel.allowed) return { cancelled: false, problem: view.cancel.reason };
  if (engine?.cancelTeamSession === undefined) return { cancelled: false, problem: "EO is not running work on this desktop, so it cannot stop or retry a team here." };
  const done = engine.cancelTeamSession(view.id);
  if (!done.ok) return { cancelled: false, problem: done.problem };
  postComment(db, {
    itemId: view.itemId as Uuid,
    author: humanAuthor(actingCaller(db, input.actingDeviceId)),
    body: `Cancelled the team session on "${view.stepName}". Its participants were stopped with it; what they reported stays on the thread.`,
  });
  emitPush("items:changed", { itemId: view.itemId });
  return { cancelled: true, problem: null };
}

/**
 * Tries again what a parked session could not do, keeping every report
 * already accepted: said on the thread in the person's name, and answered
 * as a reply would be — the team's step is run again, which adopts the
 * session and replaces only what failed.
 */
export function retryTeamSessionCommand(db: Db, engine: EngineHandle | undefined, input: IpcPayload<"teams:retry">): IpcResponse<"teams:retry"> {
  const view = viewOf(db, engine, input.sessionId);
  if (view === undefined) return { retried: false, keys: [], problem: "There is no such team session." };
  if (!view.retry.allowed) return { retried: false, keys: [], problem: view.retry.reason };
  if (engine === undefined) return { retried: false, keys: [], problem: "EO is not running work on this desktop, so it cannot stop or retry a team here." };
  const keys = view.retry.keys;
  const itemId = view.itemId as Uuid;
  postComment(db, {
    itemId,
    author: humanAuthor(actingCaller(db, input.actingDeviceId)),
    body: `Try again what failed — ${keys.map((key) => `**${key}**`).join(", ")} — keeping every report already accepted.`,
  });
  void engine.resumeItem(itemId).catch((error: unknown) => {
    postComment(db, {
      itemId,
      author: { type: "engine" },
      kind: "note",
      body: `Could not run the team again: ${error instanceof Error ? error.message : String(error)}\n\nPress Retry again, or reply, to try once more.`,
    });
  });
  emitPush("items:changed", { itemId });
  return { retried: true, keys, problem: null };
}
