import { LOCAL_PERSON_ID, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { onTheRecord } from "../db/repos/projectsRepo.js";
import { jobOwnerForItem } from "../db/repos/jobsRepo.js";
import { getSetting } from "../db/repos/settingsRepo.js";

/**
 * Who "you" is, on this machine (EO-325,
 * the original design: *"on first sign-in to a
 * server, mentions that targeted the local person become the signing-in
 * person's"*).
 *
 * Until this story there was one answer and it was a constant.
 * `LOCAL_PERSON_ID` is the implicit local person migration 0077
 * creates, and the inbox, the `!` marker and every human mention were
 * written against it directly. That is exactly right in solo mode,
 * where there is one person and every "the human" in EO means them.
 *
 * It stops being right the moment somebody signs in. The mentions on a
 * moved project are rewritten onto the person the organisation knows —
 * that is the third bullet of this story — and they then have to reach
 * that person's inbox, on this desktop *and on their second one*. A
 * reader still comparing against the local constant would find nothing
 * on either: the rows exist, they are open, and they name somebody the
 * query is not asking about. An inbox that silently empties is the
 * worst shape this could take, because nothing about it looks broken.
 *
 * So there is one function, and everything that means "me" asks it.
 *
 * ### Why the setting rather than `sessionStatus`
 *
 * `sessionStatus` needs the OS keychain, because the honest answer to
 * "am I signed in" includes "is the token still readable". That is the
 * right question for a screen and the wrong dependency for a repo
 * function called on every comment: `commentsRepo` would have to be
 * handed a `SecretStore`, and so would its hundred and twenty-eight
 * callers.
 *
 * What is read here is narrower and needs no key — *which person did
 * this machine last sign in as* — and it is safe to be generous with.
 * A machine whose token has been revoked still holds the mentions that
 * were written for that person, and showing them their own inbox while
 * they sign in again is better than showing them an empty one.
 */
export const MANAGED_PERSON_ID_KEY = "managed.personId";

/**
 * The person the organisation knows this machine as, or the implicit
 * local person where there is none.
 *
 * A solo desktop, an organisation server (whose own "you" is nobody in
 * particular) and every test that has not signed in all answer
 * `LOCAL_PERSON_ID`.
 *
 * **Not the answer to "who is you" on its own**, and that is the
 * correction the review asked for. Read `viewerFor` below.
 */
export function signedInPersonId(db: Db): Uuid {
  const id = getSetting<string>(db, MANAGED_PERSON_ID_KEY, "");
  return id === "" ? LOCAL_PERSON_ID : (id as Uuid);
}

/** Where a sign-in keeps the name the organisation knows this machine's person by. */
export const MANAGED_PERSON_NAME_KEY = "managed.personName";

/**
 * The person this machine is signed in as, with their name, or null on a
 * machine that is not signed in to anything (EO-367).
 *
 * For the one writer that has to *name* them before the record has: a
 * claim on a managed item, shown on this desktop at once while it waits.
 * Null rather than the local person, because "you" is exactly the answer
 * a managed claim must never be given — and null, too, where a sign-in
 * left no name, because a row written here under the record's id would
 * keep whatever name it was first given.
 */
export function signedInPerson(db: Db): { id: Uuid; name: string } | null {
  const id = signedInPersonId(db);
  const name = getSetting<string>(db, MANAGED_PERSON_NAME_KEY, "");
  return id === LOCAL_PERSON_ID || name === "" ? null : { id, name };
}

/**
 * Who "you" is **on this item** (EO-325, the review's third finding).
 *
 * The first draft made this one answer for the whole installation: sign
 * in, and every human mention everywhere became the organisation's
 * person. That is right for the work the organisation owns and wrong
 * for the work beside it. A project the person *kept* at first sign-in
 * is theirs and behaves exactly as it did in solo mode — that is the
 * whole of the first acceptance criterion — and its escalations still
 * target `LOCAL_PERSON_ID`, because nothing rewrote them and nothing
 * was supposed to.
 *
 * So a global answer did two things at once, both silent: it hid every
 * existing escalation on a kept project from the inbox and from `!`,
 * and it wrote every *new* one on a kept project against the
 * organisation's person — so a solo-mode project stopped behaving like
 * one the moment its owner signed in to anything.
 *
 * The honest question is about the item. The record that owns an item's
 * rows is the one whose idea of "you" applies to them: the
 * organisation's person for a project on the record, the implicit local
 * person for a project kept here. `onTheRecord` is the same function
 * the queue, the replica flag and the scheduler ask, so the five cannot
 * come to different answers.
 *
 * Called with no item where there is genuinely no item to ask about —
 * the inbox, which spans both kinds and handles them with `viewerIds`
 * below.
 */
export function viewerFor(db: Db, itemId: Uuid): Uuid {
  if (!onTheRecord(db, itemId)) return LOCAL_PERSON_ID;
  const signedIn = signedInPersonId(db);
  if (signedIn !== LOCAL_PERSON_ID) return signedIn;
  // **A process whose own "you" is nobody in particular** — an
  // organisation server (EO-330, ARCHITECTURE.md, "Where a job runs"). It reaches here because
  // placement gave it work to run: a job somebody put on the server,
  // ticked and dispatched there, with no desktop involved at any point.
  //
  // Falling through to `LOCAL_PERSON_ID` was the behaviour before that
  // could happen, and it stops being harmless the moment it can. Every
  // signed-in desktop reads `LOCAL_PERSON_ID` as one of its own
  // (`viewerIds`), so an escalation the server raised at 03:00 would
  // land in *everybody's* inbox — which is the same as landing in
  // nobody's.
  //
  // The item has an owner even though this process does not: the job
  // that filed it, whose owner is already the item's `createdBy`
  // (`jobs/fire.ts`). So the mention reaches that person, on whichever
  // of their machines they next open, which is the story's own sentence.
  // An item no job filed keeps the old answer — there is nothing better
  // to say about one, and nothing on a server files one.
  return jobOwnerForItem(db, itemId) ?? LOCAL_PERSON_ID;
}

/**
 * Both identities this machine answers to, for a reader that spans
 * projects.
 *
 * The inbox is the one: it is a list across every project, and on a
 * desktop that kept one and moved another there are genuinely two
 * people's rows in it that are both this person. One id on a solo
 * desktop, where the two are the same — so nothing about solo mode
 * changes, and no query grows a second branch it does not need.
 */
export function viewerIds(db: Db): Uuid[] {
  const signedIn = signedInPersonId(db);
  return signedIn === LOCAL_PERSON_ID ? [LOCAL_PERSON_ID] : [signedIn, LOCAL_PERSON_ID];
}
