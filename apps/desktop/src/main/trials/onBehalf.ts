import { adminToolsEnabled, type Agent, type Comment, type Item, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getAgent, getItem, listAgents } from "../db/repos/index.js";

/**
 * The assistant standing in for the person on a trial item (EO-585,
 * ARCHITECTURE.md, "The assistant on trial items").
 *
 * While a draft is tested the system agent presses the results of the
 * person's steps and answers the questions agents ask the person. Each of
 * those is recorded as the agent's own — its id on the transition, its
 * name on the comment — and on a trial item the comment also says, in
 * words a person reads, that it was done on their behalf on a trial. A
 * thread read later, or the publish card reading it (EO-588), can then
 * never mistake the assistant's press for the person's.
 */

/**
 * The words that mark it, spelled once. A phrase rather than a flag on
 * the comment because it has to be *visible*: the person scrolling a
 * trial item's thread is who it is for.
 */
export const ON_YOUR_BEHALF_TRIAL = "On your behalf, trial";

/** What the assistant did in the person's place. */
export type StandInAct = "decided" | "answered" | "wrote";

const DID: Record<StandInAct, string> = { decided: "pressed this", answered: "answered this", wrote: "wrote this" };

/** The note itself: one line, under whatever the assistant wrote. */
export function onYourBehalfNote(act: StandInAct): string {
  const did = DID[act];
  return `_${ON_YOUR_BEHALF_TRIAL}: the assistant ${did} in your place while testing a draft pipeline. You were not asked._`;
}

/**
 * The body a stand-in comment is posted with: what the assistant wrote,
 * and — on a trial item — the note under it. Off a trial the assistant's
 * words go out as they are; its name on the comment already says whose
 * they are.
 */
export function standInBody(item: Pick<Item, "trialAt">, body: string, act: StandInAct): string {
  return item.trialAt === null ? body : withOnYourBehalfNote(body, act);
}

/** What the assistant wrote, with the note under it. */
export function withOnYourBehalfNote(body: string, act: StandInAct): string {
  return body === "" ? onYourBehalfNote(act) : `${body}\n\n${onYourBehalfNote(act)}`;
}

/**
 * What the assistant wrote, with the note taken back off — what a step
 * reading the answer is handed, so the note EO adds for the person is
 * never read as part of the answer (an option "eu" is still "eu").
 */
export function withoutOnYourBehalfNote(body: string): string {
  const at = body.lastIndexOf(`_${ON_YOUR_BEHALF_TRIAL}:`);
  return at === -1 ? body : body.slice(0, at).trimEnd();
}

/**
 * The system agent a request names, checked against the database rather
 * than believed (invariant #5) — or a sentence saying why it cannot act.
 *
 * The id is stamped by EO's administrative MCP host from the credential
 * the turn holds, never sent by a caller, so this is not where a forgery
 * is caught. It is where an agent removed while its turn was still
 * running is: a press recorded under an id that names nobody would be an
 * audit row no screen can explain.
 */
export function actingAgentFor(db: Db, actingAgentId: string | undefined): { agent: Agent | null } | { problem: string } {
  if (actingAgentId === undefined) return { agent: null };
  const agent = getAgent(db, actingAgentId as Uuid);
  if (agent === undefined) {
    return { problem: "The assistant acting here is no longer one of this installation's agents, so nothing it asked for has been recorded. Nothing has changed." };
  }
  return { agent };
}

/**
 * Who may stand in for the person on this item (EO-585): on a trial item,
 * the system agent — any agent holding EO's administrative grant, the
 * only agent served it (invariant #11). Nobody on any other item, where
 * only a person answers what was put to a person.
 */
export function standInAgentIds(db: Db, itemId: Uuid): ReadonlySet<string> {
  if ((getItem(db, itemId)?.trialAt ?? null) === null) return new Set();
  return new Set(listAgents(db).filter((agent) => adminToolsEnabled(agent)).map((agent) => agent.id));
}

/**
 * Whether a comment is the system agent answering in the person's place
 * on a trial item (EO-585) — and so a reply, read by everything that
 * waits on a person's reply, rather than an agent talking.
 *
 * All four, because each alone is something else:
 *  - written by a stand-in (`standInAgentIds`, empty off a trial item),
 *    which an agent under test cannot be: EO sets the author;
 *  - in no run — written through `comments:post` on the administrative
 *    host, where EO puts the agent's name on it (`postHumanComment`).
 *    Everything the same agent says *inside* a run — reading a reply for
 *    a step (`interpret`), answering a mention — carries the run's id;
 *  - carrying the note EO adds to exactly those comments;
 *  - and not an output, which answers nothing (EO-298).
 */
export function isStandInReply(comment: Pick<Comment, "authorType" | "authorId" | "runId" | "body" | "kind">, standIns: ReadonlySet<string>): boolean {
  return (
    comment.authorType === "agent" &&
    comment.authorId !== null &&
    standIns.has(comment.authorId) &&
    comment.runId === null &&
    comment.kind !== "output" &&
    comment.body.includes(`_${ON_YOUR_BEHALF_TRIAL}:`)
  );
}
